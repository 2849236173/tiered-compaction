// 修复 compaction 事件缺失 data.turn 字段
// 用法: node fix-compaction-turn.mjs <in.zstd> <out.zstd> [--apply]
//
// 依据宿主实现（dsh-session-format-v3-to-v4 L700-726）：
//   compaction/start 读 data.turn（必须等于当前 open turn）
//   compaction/end   要求 data.turn 等于 start 的 owner turn
//   成功 end 需要一条 compaction/summary；带 data.error 的失败 end 不需要
import { readFileSync, writeFileSync } from 'node:fs';
import { zstdDecompressSync, zstdCompressSync } from 'node:zlib';

const [inFile, outFile, flag] = process.argv.slice(2);
const apply = flag === '--apply';

function readZstd(file) {
  const buf = readFileSync(file);
  const MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
  const off = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) off.push(i);
  }
  let text = '';
  for (let k = 0; k < off.length; k++) {
    const s = off[k], e = k + 1 < off.length ? off[k + 1] : buf.length;
    text += zstdDecompressSync(buf.subarray(s, e)).toString('utf8');
  }
  return { text, frames: off.length, size: buf.length };
}

const { text, frames, size } = readZstd(inFile);
console.log(`原文件 ${size} 字节，${frames} 帧，${text.length} 字符`);
const lines = text.split('\n');
console.log(`行数 ${lines.length}`);

let currentTurn = null;
const fixes = [];
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  if (!raw.trim()) continue;
  let ev;
  try { ev = JSON.parse(raw); } catch { continue; }

  if (ev.type === 'turn/start' && typeof ev.data?.turn === 'number') { currentTurn = ev.data.turn; continue; }

  if (ev.type === 'compaction/start' || ev.type === 'compaction/end') {
    const t = ev.data?.turn;
    const ok = typeof t === 'number' && Number.isSafeInteger(t) && t >= 0;
    if (!ok) {
      if (currentTurn === null) { console.error(`行 ${i + 1}: 找不到 open turn`); process.exit(1); }
      fixes.push({ i, type: ev.type, seq: ev.seq, turn: currentTurn, hasError: ev.type === 'compaction/end' && ev.data?.error !== undefined });
    }
  }
}

console.log(`\n需修复 ${fixes.length} 行：`);
for (const f of fixes) console.log(`  行 ${f.i + 1} ${f.type} seq=${f.seq} → data.turn=${f.turn}${f.hasError ? '（带 error，无需 summary）' : ''}`);

// 校验一致性：失败的 compaction 不应有 summary 也要能闭合
if (fixes.length === 0) { console.log('无需修复'); process.exit(0); }
if (!apply) { console.log('\n(dry-run，未写文件)'); process.exit(0); }

for (const f of fixes) {
  const ev = JSON.parse(lines[f.i]);
  ev.data = { ...ev.data, turn: f.turn };   // 写进 data，不是顶层
  lines[f.i] = JSON.stringify(ev);
}

const newText = lines.join('\n');
writeFileSync(outFile, zstdCompressSync(Buffer.from(newText, 'utf8')));
console.log(`\n已写出 ${outFile}`);

// 自校验
const chk = readZstd(outFile);
const clines = chk.text.split('\n').filter((x) => x.trim());
let bad = 0;
for (const raw of clines) {
  const ev = JSON.parse(raw);
  if (ev.type === 'compaction/start' || ev.type === 'compaction/end') {
    const t = ev.data?.turn;
    if (!(typeof t === 'number' && Number.isSafeInteger(t) && t >= 0)) bad++;
  }
}
console.log(`自校验：${clines.length} 行，compaction 事件 turn 仍非法 ${bad} 条`);
console.log(`文本一致性: ${chk.text === newText ? '✅' : '❌'}`);
console.log(bad === 0 ? '✅ 修复完成' : '❌ 仍有问题');
