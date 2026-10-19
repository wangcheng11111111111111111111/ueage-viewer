#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const os = require("os");

const args = process.argv.slice(2);
const all = args.includes("--all");
const asJson = args.includes("--json");
const lastArg = args.find((a) => a.startsWith("--last="));
const lastN = lastArg ? Number(lastArg.split("=")[1]) : null;
const daysArg = args.find((a) => a.startsWith("--days="));
const days = daysArg ? Number(daysArg.split("=")[1]) : all ? null : 1;

const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
const sessionsDir = path.join(codexHome, "sessions");

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function num(value) { return Number.isFinite(value) ? value : 0; }

function readSession(file) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return null; }
  let meta = null;
  let usage = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (!meta && event.type === "session_meta") meta = event.payload || {};
    if (event.type === "event_msg" && event.payload && event.payload.type === "token_count") {
      usage = event.payload;
    }
  }
  if (!usage || !usage.info || !usage.info.total_token_usage) return null;

  const total = usage.info.total_token_usage;
  const last = usage.info.last_token_usage || {};
  const input = num(total.input_tokens);
  const cached = num(total.cached_input_tokens);
  const lastInput = num(last.input_tokens);
  const lastCached = num(last.cached_input_tokens);
  const model = (meta && (meta.model || (meta.base_instructions && meta.base_instructions.provenance && meta.base_instructions.provenance.model))) || "";
  const provider = (meta && meta.model_provider) || "";
  const time = (meta && meta.timestamp) || fs.statSync(file).mtime.toISOString();

  return {
    time,
    session: (meta && (meta.session_id || meta.id)) || path.basename(file, ".jsonl"),
    provider,
    model,
    input,
    cached,
    uncached: Math.max(0, input - cached),
    output: num(total.output_tokens),
    reasoning: num(total.reasoning_output_tokens),
    total: num(total.total_tokens),
    cacheHit: input > 0 ? cached / input : null,
    lastInput,
    lastCached,
    lastHit: lastInput > 0 ? lastCached / lastInput : null,
    file,
  };
}

function fmt(n) { return Number(n).toLocaleString("en-US"); }
function pct(n) { return n == null ? "-" : `${(n * 100).toFixed(1)}%`; }
function pad(value, width) { return String(value).padEnd(width, " "); }

const now = Date.now();
const cutoff = days == null ? null : now - days * 24 * 60 * 60 * 1000;
let rows = walk(sessionsDir).map(readSession).filter(Boolean);
if (cutoff != null) rows = rows.filter((r) => new Date(r.time).getTime() >= cutoff);
rows.sort((a, b) => new Date(b.time) - new Date(a.time));
if (lastN != null) rows = rows.slice(0, lastN);

if (asJson) {
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
}

if (rows.length === 0) {
  console.log("没有找到会话记录。试试 --all 或 --days=30。");
  process.exit(0);
}

const total = rows.reduce((acc, r) => {
  acc.input += r.input;
  acc.cached += r.cached;
  acc.uncached += r.uncached;
  acc.output += r.output;
  acc.reasoning += r.reasoning;
  acc.total += r.total;
  return acc;
}, { input: 0, cached: 0, uncached: 0, output: 0, reasoning: 0, total: 0 });

console.log(`Codex 会话用量（${rows.length} 个会话）`);
console.log("");
console.log(`${pad("时间", 17)}${pad("模型", 22)}${pad("输入", 12)}${pad("缓存输入", 12)}${pad("未缓存", 11)}${pad("输出", 9)}${pad("命中率", 8)}${pad("最近一次", 9)}`);
console.log("-".repeat(100));
for (const r of rows) {
  const t = new Date(r.time).toLocaleString("zh-CN", { hour12: false });
  console.log(`${pad(t.slice(5), 17)}${pad(r.model || r.provider || "-", 22)}${pad(fmt(r.input), 12)}${pad(fmt(r.cached), 12)}${pad(fmt(r.uncached), 11)}${pad(fmt(r.output), 9)}${pad(pct(r.cacheHit), 8)}${pad(pct(r.lastHit), 9)}`);
}
console.log("-".repeat(100));
console.log(`${pad("合计", 17)}${pad("", 22)}${pad(fmt(total.input), 12)}${pad(fmt(total.cached), 12)}${pad(fmt(total.uncached), 11)}${pad(fmt(total.output), 9)}${pad(pct(total.input > 0 ? total.cached / total.input : null), 8)}`);
console.log("");
console.log("缓存命中率 = 缓存输入 / 输入；输入 = 缓存输入 + 未缓存输入。");
