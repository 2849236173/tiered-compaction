// 只读：用宿主自带的 V4 校验器（restoreReleasedV4Artifact）校验会话日志。
// 用法: node host-validate.mjs <session.v4.jsonl.zstd>
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { pathToFileURL } from "node:url";

const lib = "G:/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js";
const { restoreReleasedV4Artifact, RELEASED_V3_EVENT_TYPES } = await import(pathToFileURL(lib).href);

const buf = readFileSync(process.argv[2]);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
for (let i = buf.indexOf(MAGIC); i !== -1; i = buf.indexOf(MAGIC, i + 4)) starts.push(i);
let text = "";
for (let k = 0; k < starts.length; k++) text += zstdDecompressSync(buf.subarray(starts[k], k + 1 < starts.length ? starts[k + 1] : buf.length)).toString("utf8");
const rows = text.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const [{ type: _t, ...header }, ...events] = rows;
const known = new Set([...RELEASED_V3_EVENT_TYPES, ...events.map((e) => e.type)]);
try {
    restoreReleasedV4Artifact({ header, events, inheritedEventCount: 0 }, known);
    console.log("HOST_VALIDATE OK", events.length, "events");
} catch (err) {
    console.log("HOST_VALIDATE FAIL", err.name, err.message);
    process.exitCode = 2;
}
