// 只补 compaction/summary 缺失的 sourceCommandId（从配对 compaction/start 取），其余逐字不动。
// 用法: node fix-summary-cmd.mjs <in.zstd> <out.zstd>
import { readFileSync, writeFileSync } from "node:fs";
import { zstdDecompressSync, zstdCompressSync } from "node:zlib";

const [inFile, outFile] = process.argv.slice(2);
const buf = readFileSync(inFile);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) starts.push(i);
let text = "";
for (let k = 0; k < starts.length; k++) text += zstdDecompressSync(buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)).toString("utf8");
const lines = text.split("\n");
const cmdOf = new Map();
let patched = 0;
for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const ev = JSON.parse(lines[i]);
    if (ev.type === "compaction/start") cmdOf.set(ev.data.compactionId, ev.data.sourceCommandId);
    if (ev.type === "compaction/summary" && ev.data.sourceCommandId === undefined) {
        const cmd = cmdOf.get(ev.data.compactionId);
        if (cmd === undefined) continue;
        ev.data = { compactionId: ev.data.compactionId, sourceCommandId: cmd, ...ev.data };
        lines[i] = JSON.stringify(ev);
        patched += 1;
    }
}
console.log(`patched ${patched}`);
writeFileSync(outFile, zstdCompressSync(Buffer.from(lines.join("\n"), "utf8")));
