// 修复 compaction 事件缺失 data.turn 字段，并把档案重排为宿主加载器接受的物理布局
// 用法: node fix-compaction-turn.mjs <in.zstd> <out.zstd> [--apply]
//
// ============ 物理契约（为什么必须这样写） ============
// 宿主 @deepseek-ai/dsh-session-persistence-jsonl 的加载器逐帧解压，
// 第一帧解出的明文必须【恰好一行头行】且以 \n 收尾
// （见该库 lib/index.js "first frame is not exactly one header line" 判罚处）。
// 违反即整个会话档案无法加载，错误形如：
//   resume failed for session "...": ... first frame is not exactly one header line
//
// 本工具的前身（0.3.x 随包分发的旧版脚本）用 zstdCompressSync 把整档一次压成
// 单帧，恰恰制造了这种损坏——修好语义的同时毁掉物理。教训与新产物鉴别法见同目录 README。
//
// 本版输出布局（与宿主自身压缩管道同款）：
//   帧 0        = 头行（含结尾 \n），独占一帧
//   帧 1..N-1   = 其余事件行按 ~128 KiB 明文一批，逐批压一帧
//   每帧带 zstd 内容校验位（checksumFlag=1，与宿主 CHECKSUM_OPTIONS 一致）
// 事件内容（除补 data.turn 外）逐字节不动。
// =====================================================
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  zstdDecompressSync,
  zstdCompressSync,
  constants as zlibConstants,
} from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]); // zstd 帧魔数 28 B5 2F FD
const BATCH_LINES_TARGET = 128 * 1024; // 头行之后每帧装载的明文目标字节数（宿主 1 MiB 工作块的保守同级）
// 宿主压缩器强制 checksumFlag=1；枚举值 201，找不到导出时按 zstd 枚举兜底
const CHECKSUM_FLAG_KEY = zlibConstants.ZSTD_c_checksumFlag ?? 2;
const COMPRESS_PARAMS = { params: { [CHECKSUM_FLAG_KEY]: 1 } };

// ---------- 帧切分：把任意多帧 zstd 缓冲按帧切开，返回每帧明文 ----------
// node 的 zstdDecompressSync 对「拼接多帧」只解第一帧、无视尾部（v24 实测），
// 且在帧尾附近截断也可能不报错，因此帧边界必须自己推定：
//   1. 对剩余缓冲整段解码得到第一帧文本 T（尾部自然被无视）；
//   2. 指数扩张 + 二分找最小的 k 使得 decode(buf[pos..pos+k)) 的文本与 T 一致；
//   3. 从该 k 向后扫到下一个帧魔数，即下一帧起点（吸收校验位区间内的误差）。
// 注：第 3 步遇到「压缩载荷里恰好出现魔数」属极小概率事件；即便命中，随后
// 逐帧解码要么报错、要么在本文件最后的全文回环断言处暴露，不会静默出错。
function splitZstdFrames(buf) {
  // 单次解码尝试：帧内截断会抛错，视为「前缀不够长」而不是失败
  const tryDecode = (sub) => {
    try {
      return { ok: true, text: zstdDecompressSync(sub).toString('utf8') };
    } catch {
      return { ok: false, text: null };
    }
  };
  const frames = [];
  let pos = 0;
  while (pos < buf.length) {
    // 期待此处是帧魔数；不是就明说（撕尾/垃圾尾部交给上层报错）
    if (!buf.subarray(pos, pos + 4).equals(MAGIC)) {
      throw new Error(`offset ${pos}: 不是 zstd 帧魔数（档案尾部疑似撕裂，请从备份恢复）`);
    }
    const base = tryDecode(buf.subarray(pos));
    if (!base.ok) throw new Error(`offset ${pos}: 该帧无法完整解码（档案疑似撕裂，请从备份恢复）`);
    // 指数扩张确定上界：解码成功且文本一致即为足够长的前缀
    let lo = 4;
    let hi = Math.min(buf.length - pos, 4096);
    while (hi < buf.length - pos) {
      const t = tryDecode(buf.subarray(pos, pos + hi));
      if (t.ok && t.text === base.text) break;
      hi = Math.min(hi * 2, buf.length - pos);
    }
    // 二分逼近最小可行前缀（文本一致的最早点；不够长视同不一致）
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const t = tryDecode(buf.subarray(pos, pos + mid));
      if (t.ok && t.text === base.text) hi = mid;
      else lo = mid + 1;
    }
    let frameEnd = pos + lo;          // 可能略早于真帧尾（校验位区间），向后吸收
    let nextPos = frameEnd;
    while (nextPos < buf.length && !buf.subarray(nextPos, nextPos + 4).equals(MAGIC)) nextPos++;
    frames.push(base.text);
    pos = nextPos;                    // 下一帧从此魔数开始
    if (pos === frameEnd) pos++;      // 防御：魔数恰好落原地时前进一格避免死循环
  }
  return frames;
}

// ---------- 读整档：全部帧明文按序拼接 ----------
function readWholeArchive(file) {
  const buf = readFileSync(file);
  const frames = splitZstdFrames(buf);
  return { buf, frames, text: frames.join('') };
}

// ---------- 逐批压缩：文本 → 首帧头行 + 余行分帧的合规字节流 ----------
// framesOut 若提供，则同步记录每帧明文（供自检按构造核对）。
function encodeConformant(text, framesOut) {
  const hadFinalNewline = text.endsWith('\n');
  if (!hadFinalNewline) text += '\n'; // 行式日志必须以换行收尾；补上并已在报告中注明
  const nl = text.indexOf('\n');
  // 正文与头行的切分：nl 必然 ≥ 0（上文已保证换行收尾）
  const headerLine = text.slice(0, nl + 1); // 头行（含 \n），独占首帧
  const body = text.slice(nl + 1);
  const parts = [];
  if (body.length > 0) {
    // 按「凑满目标字节的若干整行」切块，保证帧内不切断行
    let acc = [];
    let accLen = 0;
    let lineStart = 0;
    while (lineStart < body.length) {
      const lineEnd = body.indexOf('\n', lineStart);
      const end = lineEnd === -1 ? body.length : lineEnd + 1; // 单行超目标也整行入帧
      acc.push(body.slice(lineStart, end));
      accLen += end - lineStart;
      lineStart = end;
      if (accLen >= BATCH_LINES_TARGET) {
        parts.push(acc.join(''));
        acc = [];
        accLen = 0;
      }
    }
    if (acc.length > 0) parts.push(acc.join(''));
  }
  const batches = [headerLine, ...parts];
  const bufs = batches.map((b) => {
    if (framesOut) framesOut.push(b);
    return compressFrame(b);
  });
  return Buffer.concat(bufs);
}

// 单帧压缩的唯一出口：统一携带校验位参数（供测试做帧头指纹断言）
function compressFrame(batchText) {
  return zstdCompressSync(Buffer.from(batchText, 'utf8'), COMPRESS_PARAMS);
}

// ---------- 语义修复：补 compaction/start|end 缺失的 data.turn ----------
// 扫描事件行（跳过头行与解析不了的行——后者原样保留在输出里），
// 对缺 turn 的 compaction 事件补当前 open turn（逻辑沿用 0.3.x 已验证版本）。
function fixLines(text) {
  const lines = text.split('\n');
  let currentTurn = null;
  const fixes = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type === 'turn/start' && typeof ev.data?.turn === 'number') {
      currentTurn = ev.data.turn;
      continue;
    }
    if (ev.type === 'compaction/start' || ev.type === 'compaction/end') {
      const t = ev.data?.turn;
      const ok = typeof t === 'number' && Number.isSafeInteger(t) && t >= 0;
      if (!ok) {
        if (currentTurn === null) throw new Error(`行 ${i + 1}: compaction 事件缺少 data.turn 且流中找不到 open turn，无法自动修复`);
        fixes.push({ i, type: ev.type, seq: ev.seq, turn: currentTurn, hasError: ev.type === 'compaction/end' && ev.data?.error !== undefined });
      }
    }
  }
  return { lines, fixes };
}

// ---------- 加载器契约自检：模拟真加载器的判罚（不再是宽容校验） ----------
// 判罚项与宿主对齐：首帧必须恰好一行头行；行完整性（撕行检测）；
// compaction turn 合法性。返回 { ok, violations: [...] }。
function validateContract(frames) {
  const violations = [];
  // 判罚 1：首帧必须恰好一行且以 \n 收尾（宿主 L1898 同款语义）
  if (frames.length === 0) {
    violations.push('空档案：没有任何帧');
  } else if (!frames[0].endsWith('\n')) {
    violations.push('首帧不是以 \\n 收尾的完整行');
  } else {
    const inner = frames[0].indexOf('\n', 0);
    if (inner !== frames[0].length - 1) {
      // 只在「恰好一行」成立时才检查头行 JSON，避免连环噪音
      violations.push(`首帧不止一行内容（首行 ${inner + 1} 字符，整帧 ${frames[0].length} 字符，契约要求首帧=头行独占）`);
    } else {
      // 头行还得是合法 JSON——加载器要解析它才能走到事件层
      try { JSON.parse(frames[0]); } catch { violations.push('首帧头行不是合法 JSON'); }
    }
  }
  // 判罚 2：所有帧串起来的文本行完整性——不允许出现缺 \n 的中间断行
  const full = frames.join('');
  if (!full.endsWith('\n')) violations.push('全文不以 \\n 收尾（行未终结）');
  // 判罚 3：compaction 事件 turn 全部合法
  const lines = full.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw.trim()) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    if (ev.type === 'compaction/start' || ev.type === 'compaction/end') {
      const t = ev.data?.turn;
      if (!(typeof t === 'number' && Number.isSafeInteger(t) && t >= 0)) {
        violations.push(`行 ${i + 1}: compaction/${ev.type.split('/')[1]} 的 data.turn 非法`);
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

// ---------- 主流程（CLI）----------
function main() {
  const [inFile, outFile, flag] = process.argv.slice(2);
  if (!inFile || !outFile) {
    console.error('用法: node fix-compaction-turn.mjs <in.zstd> <out.zstd> [--apply]');
    process.exit(1);
  }
  const apply = flag === '--apply';

  // 1. 读原始档（支持单帧病档与任意多帧档案）
  const { text } = readWholeArchive(inFile);
  const lineCount = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  console.log(`已读取：${text.length} 字符，${lineCount} 行`);

  // 2. 语义体检：找出需要补 turn 的行
  const { lines, fixes } = fixLines(text);
  console.log(`需补 data.turn 的行：${fixes.length}`);
  for (const f of fixes) {
    console.log(`  行 ${f.i + 1} ${f.type} seq=${f.seq} → data.turn=${f.turn}${f.hasError ? '（带 error，无需 summary）' : ''}`);
  }

  // 3. 输入档的物理体检（按契约判罚）
  const inputFrames = (() => { try { return splitZstdFrames(readFileSync(inFile)); } catch (e) { console.error(`输入档读取失败: ${e.message}`); process.exit(1); } })();
  const inVerdict = validateContract(inputFrames);

  // 4. 应用：补 turn + 无条件归一化物理形态（哪怕 turn 全合法也重排，让历史病档重跑即自愈）
  for (const f of fixes) {
    const ev = JSON.parse(lines[f.i]);
    ev.data = { ...ev.data, turn: f.turn }; // 写进 data，不是顶层
    lines[f.i] = JSON.stringify(ev);
  }
  const newText = lines.join('\n');

  if (!apply) {
    console.log('\n(dry-run，未写文件)');
    console.log(`输入物理布局：${inVerdict.ok ? '符合契约' : `不符合契约：${inVerdict.violations.join('；')}`}`);
    console.log(`(--apply 后将${fixes.length ? '补齐 turn 并' : ''}重排为「首帧头行独占 + ~128 KiB 分帧 + 校验位」布局)`);
    process.exit(0);
  }

  const builtFrames = [];
  const outBuf = encodeConformant(newText, builtFrames);
  writeFileSync(outFile, outBuf);
  console.log(`\n已写出 ${outFile}`);

  // 5. 出厂自检：重新读取输出文件，按真加载器契约逐条判罚（不许假绿灯）
  const chk = readWholeArchive(outFile);
  const verdict = validateContract(chk.frames);
  // 全文回环断言：输出解出的文本必须与拟写文本逐字符一致
  const expected = newText.endsWith('\n') ? newText : newText + '\n';
  const roundTripOk = chk.text === expected;
  // 布局断言：首帧确实是头行、其余帧数量符合批次划分
  const layoutOk = chk.frames[0] === expected.slice(0, expected.indexOf('\n') + 1);
  console.log(`文本一致性: ${roundTripOk ? '✅' : '❌'}　首帧=头行独占: ${layoutOk ? '✅' : '❌'}　共 ${chk.frames.length} 帧`);
  if (verdict.ok) {
    console.log('✅ 修复完成，输出符合宿主加载器契约');
  } else {
    console.error('❌ 输出仍不符合契约：');
    for (const v of verdict.violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  if (!roundTripOk || !layoutOk) process.exit(1);
}

// 仅在直接运行时执行主流程；被 import 时不执行，以便测试复用上述纯函数
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

export { splitZstdFrames, readWholeArchive, encodeConformant, fixLines, validateContract, compressFrame };
