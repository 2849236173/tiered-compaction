// 修复 beta.2 时期重复写入的 compaction/prune：
//   prune(shadow X) → tool/result(replace X) → prune(shadow X)  ← 第二条指向已不在表面的 X，宿主判 corrupt
// 做法：删除第二条（表面上已不存在的 span），把后续事件 seq 重新压实，并改写所有 seq 引用。
// 用法: node fix-duplicate-prune.mjs <in.zstd> <out.zstd> [--apply]
import { readFileSync, writeFileSync } from "node:fs";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";

const [inFile, outFile, flag] = process.argv.slice(2);
const apply = flag === "--apply";

function readLines(file) {
    const buf = readFileSync(file);
    const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
    const starts = [];
    for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) starts.push(i);
    let text = "";
    for (let k = 0; k < starts.length; k++) {
        text += zstdDecompressSync(buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)).toString("utf8");
    }
    return text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const SURFACE_TYPES = new Set(["system/message", "user/message", "assistant/message", "tool/result"]);

/** 模拟宿主表面折叠与 span 校验（dsh-session-format-v3-to-v4 L597-617、L731-738）。 */
function check(events) {
    const surface = [];
    const problems = [];
    let expect = 0;
    for (const ev of events) {
        if (ev.seq === undefined) continue;
        if (ev.seq !== expect) problems.push(`seq ${ev.seq} 不稠密（期望 ${expect}）`);
        expect = ev.seq + 1;
        if (ev.type === "compaction/prune" || ev.type === "compaction/summary") {
            const r = ev.data.shadowedRange;
            const a = surface.indexOf(r.start), b = surface.indexOf(r.end);
            const ok = a >= 0 && b >= a && JSON.stringify(surface.slice(a, b + 1)) === JSON.stringify(ev.data.shadowedSeqs);
            if (!ok) problems.push(`seq ${ev.seq} ${ev.type} span 不在当前表面`);
        }
        if (SURFACE_TYPES.has(ev.type) && ev.surfaceOp !== undefined) {
            if (ev.surfaceOp === "append") surface.push(ev.seq);
            else {
                const a = surface.indexOf(ev.surfaceOp.startSeq), b = surface.indexOf(ev.surfaceOp.endSeq);
                if (a < 0 || b < a) { problems.push(`seq ${ev.seq} replace 区间不在表面`); continue; }
                surface.splice(a, b - a + 1, ev.seq);
            }
        }
    }
    return problems;
}

const events = readLines(inFile);
// 修复二：summary 缺 sourceCommandId（插件 ≤0.4.0-beta.3 的 /compact 漏写）→ 从配对 start 补齐
{
    const starts = new Map();
    let patched = 0;
    for (const ev of events) {
        if (ev.type === "compaction/start") starts.set(ev.data.compactionId, ev.data.sourceCommandId);
        if (ev.type === "compaction/summary") {
            const cmd = starts.get(ev.data.compactionId);
            if (cmd !== undefined && ev.data.sourceCommandId === undefined) {
                ev.data = { compactionId: ev.data.compactionId, sourceCommandId: cmd, ...ev.data };
                patched += 1;
            }
        }
    }
    console.log(`summary 补 sourceCommandId：${patched} 条`);
    globalThis.__patched = patched;
}
const header = events[0];
console.log(`读入 ${events.length} 行，header=${header.type} v${header.version} id=${header.id}`);
const before = check(events);
console.log(`修复前问题 ${before.length} 条：`, before);

// 标出要删的事件：沿表面模拟，span 不在当前表面的 prune
const surface = [];
const drop = new Set();
for (const ev of events) {
    if (ev.seq === undefined) continue;
    if (ev.type === "compaction/prune") {
        const r = ev.data.shadowedRange;
        const a = surface.indexOf(r.start), b = surface.indexOf(r.end);
        const ok = a >= 0 && b >= a && JSON.stringify(surface.slice(a, b + 1)) === JSON.stringify(ev.data.shadowedSeqs);
        if (!ok) drop.add(ev.seq);
    }
    if (SURFACE_TYPES.has(ev.type) && ev.surfaceOp !== undefined) {
        if (ev.surfaceOp === "append") surface.push(ev.seq);
        else {
            const a = surface.indexOf(ev.surfaceOp.startSeq), b = surface.indexOf(ev.surfaceOp.endSeq);
            if (a >= 0 && b >= a) surface.splice(a, b - a + 1, ev.seq);
        }
    }
}
// 只允许删「紧跟同目标 prune + replace」的重复 prune，其他情况不自动处理
const bySeq = new Map(events.filter((e) => e.seq !== undefined).map((e) => [e.seq, e]));
for (const s of drop) {
    const dup = bySeq.get(s);
    const replace = bySeq.get(s - 1);
    const first = bySeq.get(s - 2);
    // 宽化（8382411b）：并行工具结果会交错成 prune(A) replace(A) prune(B) replace(B) prune(A) prune(B)，
    // 所以向前 12 条内找「同目标的保留 prune + 同目标 replace」即可，不要求紧邻
    void first; void replace;
    const target = dup.data.shadowedRange.start;
    let sawPrune = false, sawReplace = false;
    if (dup.data.shadowedRange.end === target && dup.data.shadowedSeqs.length === 1) {
        for (let q = s - 1; q >= Math.max(0, s - 12); q -= 1) {
            const e = bySeq.get(q);
            if (e?.type === "tool/result" && e.surfaceOp?.op === "replace" && e.surfaceOp.startSeq === target) sawReplace = true;
            if (e?.type === "compaction/prune" && !drop.has(q) && e.data.shadowedRange.start === target) { sawPrune = true; break; }
        }
    }
    const same = sawPrune && sawReplace;
    if (!same) { console.error(`seq ${s} 不是已知的重复 prune 模式，停止`); process.exit(1); }
}
console.log(`待删重复 prune：${[...drop].join(", ")}`);
if (drop.size === 0 && globalThis.__patched === 0) { console.log("无需修复"); process.exit(0); }

const map = new Map();
let next = 0;
for (const ev of events) {
    if (ev.seq === undefined) continue;
    if (drop.has(ev.seq)) continue;
    map.set(ev.seq, next++);
}
const re = (s) => { if (!map.has(s)) throw new Error(`引用了被删除或不存在的 seq ${s}`); return map.get(s); };
const out = [];
for (const ev of events) {
    if (ev.seq !== undefined && drop.has(ev.seq)) continue;
    const e = structuredClone(ev);
    if (e.seq !== undefined) e.seq = re(e.seq);
    if (Array.isArray(e.sourceEventSeqs)) e.sourceEventSeqs = e.sourceEventSeqs.map(re);
    if (e.surfaceOp && typeof e.surfaceOp === "object") { e.surfaceOp.startSeq = re(e.surfaceOp.startSeq); e.surfaceOp.endSeq = re(e.surfaceOp.endSeq); }
    if (e.data?.shadowedRange) e.data.shadowedRange = { start: re(e.data.shadowedRange.start), end: re(e.data.shadowedRange.end) };
    if (Array.isArray(e.data?.shadowedSeqs)) e.data.shadowedSeqs = e.data.shadowedSeqs.map(re);
    if (Array.isArray(e.data?.messageSeqs)) e.data.messageSeqs = e.data.messageSeqs.map(re);
    if (typeof e.data?.throughSeq === "number") e.data.throughSeq = re(e.data.throughSeq);
    out.push(e);
}
const after = check(out);
console.log(`修复后 ${out.length} 行，问题 ${after.length} 条`, after);
if (after.length > 0) process.exit(1);
if (!apply) { console.log("(dry-run，未写文件)"); process.exit(0); }
const text = out.map((e) => JSON.stringify(e)).join("\n") + "\n";
writeFileSync(outFile, zstdCompressSync(Buffer.from(text, "utf8")));
const back = readLines(outFile);
console.log(`已写出 ${outFile}，回读 ${back.length} 行，一致：${JSON.stringify(back) === JSON.stringify(out)}`);
