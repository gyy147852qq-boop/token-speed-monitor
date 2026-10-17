#!/usr/bin/env node
/**
 * token-stats.mjs — Measure token usage totals and generation speed (tok/s)
 * of the AI software installed on this computer. Read-only, local-only.
 *
 * Sources:
 *   OpenCode      ~/.local/share/opencode/opencode.db (SQLite) + legacy JSON storage
 *   Claude Code   ~/.claude/projects/**\/*.jsonl
 *   Codex CLI     ~/.codex/sessions/**\/rollout-*.jsonl
 *   Gemini CLI    ~/.gemini/tmp/**\/chats/session-*.json
 *   Ollama        http://127.0.0.1:11434 (live benchmark)
 *   LM Studio     http://127.0.0.1:1234  (live benchmark)
 *   llama.cpp     http://127.0.0.1:8080  (live benchmark)
 *
 * Zero dependencies. Node >= 22 recommended (node:sqlite is only needed for
 * the OpenCode database; all JSONL sources work on older Node versions).
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";

const VERSION = "0.2.0";

// node:sqlite is optional (only needed for the OpenCode database source)
let sqliteMod = null;
try { sqliteMod = await import("node:sqlite"); } catch { /* Node < 22.5 */ }

/* --------------------------------- CLI ---------------------------------- */

const argv = process.argv.slice(2);
const opts = {
  cmd: null, target: null, since: null, tools: null, json: false,
  interval: 2, home: null, model: null, prompt: null, maxTokens: 128,
  cycles: 0, history: 12, help: false,
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const next = () => argv[++i];
  if (a === "--since") opts.since = next();
  else if (a === "--tool" || a === "--tools")
    opts.tools = (next() || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  else if (a === "--json") opts.json = true;
  else if (a === "--interval") opts.interval = Math.max(0.5, parseFloat(next()) || 2);
  else if (a === "--home") opts.home = next();
  else if (a === "--model") opts.model = next();
  else if (a === "--prompt") opts.prompt = next();
  else if (a === "--max-tokens") opts.maxTokens = Math.max(8, parseInt(next(), 10) || 128);
  else if (a === "--cycles") opts.cycles = Math.max(1, parseInt(next(), 10) || 1);
  else if (a === "--history") opts.history = Math.max(0, parseInt(next(), 10) || 0);
  else if (a === "-h" || a === "--help") opts.help = true;
  else if (!a.startsWith("--")) {
    if (!opts.cmd) opts.cmd = a.toLowerCase();
    else if (!opts.target) opts.target = a.toLowerCase();
  }
}
if (!opts.cmd) opts.cmd = "summary";

const HOME = opts.home || homedir();
const envOr = (name, def) => process.env[name] || def;

const SOURCE_DIRS = {
  opencode: envOr("TOKEN_STATS_OPENCODE_DIR", join(HOME, ".local", "share", "opencode")),
  claude: process.env.TOKEN_STATS_CLAUDE_DIR
    ? [process.env.TOKEN_STATS_CLAUDE_DIR]
    : [join(HOME, ".claude", "projects"), join(HOME, ".config", "claude", "projects")],
  codex: envOr("TOKEN_STATS_CODEX_DIR", join(HOME, ".codex", "sessions")),
  gemini: process.env.TOKEN_STATS_GEMINI_DIR
    ? [process.env.TOKEN_STATS_GEMINI_DIR]
    : [join(HOME, ".gemini", "tmp")],
};

/* -------------------------------- helpers -------------------------------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;

function parseSince(s) {
  if (!s) return 0;
  const m = /^(\d+)(m|h|d|w)$/i.exec(s);
  if (m) {
    const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[m[2].toLowerCase()];
    return Date.now() - parseInt(m[1], 10) * unit;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function fmt(n) {
  if (!n) return "0";
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2) + "G";
  if (abs >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (abs >= 1e4) return (n / 1e3).toFixed(1) + "k";
  return String(Math.round(n));
}

function renderTable(headers, rows) {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((r) => String(r[i] ?? "").length)));
  const line = (r) => r.map((c, i) => String(c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(line)].join("\n");
}

function walkFiles(dir, ext, limit = 20000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop();
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.endsWith(ext)) out.push(p);
    }
  }
  return out;
}

function safeMtime(f) {
  try { return statSync(f).mtimeMs; } catch { return 0; }
}

async function fetchJson(url, init = {}, timeoutMs = 3000) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const promptText = () =>
  opts.prompt || "Write a short paragraph about why measuring tokens per second is useful.";

/* ---------------------------------- data ---------------------------------- */

function totalsOf(recs) {
  const t = {
    requests: recs.length, sessions: new Set(),
    input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0,
    total: 0, cost: null,
  };
  let cost = 0, hasCost = false;
  for (const r of recs) {
    t.sessions.add(r.session);
    t.input += r.input; t.output += r.output; t.reasoning += r.reasoning;
    t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite;
    if (typeof r.cost === "number" && r.cost > 0) { cost += r.cost; hasCost = true; }
  }
  t.sessions = t.sessions.size;
  t.total = t.input + t.output + t.reasoning + t.cacheRead + t.cacheWrite;
  t.cost = hasCost ? r2(cost) : null;
  return t;
}

const tokPerSec = (s) => (s.durationMs > 0 ? s.output / (s.durationMs / 1000) : 0);

function speedStats(samples) {
  const vals = samples.map(tokPerSec).filter((v) => v > 0).sort((a, b) => a - b);
  if (!vals.length) return { n: 0, avg: null, p50: null, p90: null, max: null, quality: null };
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  const q = (p) => vals[Math.min(vals.length - 1, Math.floor(p * (vals.length - 1)))];
  const hasExact = samples.some((s) => s.quality === "exact");
  const hasApprox = samples.some((s) => s.quality === "approx");
  return {
    n: vals.length, avg: r1(avg), p50: r1(q(0.5)), p90: r1(q(0.9)), max: r1(vals[vals.length - 1]),
    quality: hasExact && hasApprox ? "mixed" : hasExact ? "exact" : "approx",
  };
}

/* ---------------------------- source parsers ---------------------------- */
/*
 * A record is one usage data point:
 *   { id, tool, session, model, ts, input, output, reasoning, cacheRead,
 *     cacheWrite, cost }
 * A speed sample is:
 *   { id, tool, session, model, ts, output, durationMs, quality }
 * quality = "exact"  -> duration measured by the app itself for that call
 *           "approx" -> derived from turn durations / token-count deltas
 */

function parseOpenCode({ recentMs = 0 } = {}) {
  const records = [], speeds = [], notes = [];
  const base = SOURCE_DIRS.opencode;
  let detected = false;

  const pushMsg = (id, session, d) => {
    if (!d || d.role !== "assistant") return;
    const tk = d.tokens || {};
    const c = tk.cache || {};
    const created = d.time?.created ?? null;
    const completed = d.time?.completed ?? null;
    const ts = completed ?? created;
    if (ts == null || (recentMs && ts < recentMs)) return;
    const rec = {
      id: `opencode:${id}`, tool: "opencode",
      session: session || d.sessionID || "?", model: d.modelID || "(unknown)",
      ts, input: tk.input || 0, output: tk.output || 0, reasoning: tk.reasoning || 0,
      cacheRead: c.read || 0, cacheWrite: c.write || 0,
      cost: typeof d.cost === "number" ? d.cost : null,
    };
    records.push(rec);
    if (created != null && completed != null && completed > created && rec.output > 0) {
      speeds.push({
        id: rec.id, tool: "opencode", session: rec.session, model: rec.model,
        ts, output: rec.output, durationMs: completed - created, quality: "exact",
      });
    }
  };

  // 1) modern SQLite database
  const dbPath = join(base, "opencode.db");
  if (existsSync(dbPath)) {
    detected = true;
    if (!sqliteMod) {
      notes.push("opencode.db found but node:sqlite unavailable (need Node >= 22.5)");
    } else {
      try {
        let db;
        try { db = new sqliteMod.DatabaseSync(dbPath, { readOnly: true }); }
        catch { db = new sqliteMod.DatabaseSync(dbPath); }
        const rows = recentMs
          ? db.prepare("SELECT id, session_id, data FROM message WHERE time_updated > ?").all(recentMs)
          : db.prepare("SELECT id, session_id, data FROM message").all();
        for (const row of rows) {
          let d;
          try { d = JSON.parse(row.data); } catch { continue; }
          pushMsg(row.id, row.session_id, d);
        }
        db.close();
      } catch (e) { notes.push(`opencode.db: ${e.message}`); }
    }
  }

  // 2) legacy JSON storage (v1.x, incl. per-project stores)
  const roots = [join(base, "storage")];
  const projRoot = join(base, "project");
  if (existsSync(projRoot)) {
    try { for (const p of readdirSync(projRoot)) roots.push(join(projRoot, p, "storage")); } catch { /* ignore */ }
  }
  for (const root of roots) {
    const msgDir = join(root, "message");
    if (!existsSync(msgDir)) continue;
    detected = true;
    for (const f of walkFiles(msgDir, ".json")) {
      if (recentMs && safeMtime(f) < recentMs) continue;
      try {
        const d = JSON.parse(readFileSync(f, "utf8"));
        pushMsg(d.id || f, d.sessionID || basename(dirname(f)), d);
      } catch { /* skip bad file */ }
    }
  }
  return { records, speeds, detected, note: notes.join("; ") || null };
}

function parseClaude({ recentMs = 0 } = {}) {
  const records = [], speeds = [];
  let detected = false;
  const files = [];
  for (const d of [...new Set(SOURCE_DIRS.claude)]) {
    if (existsSync(d)) { detected = true; files.push(...walkFiles(d, ".jsonl")); }
  }
  for (const f of files) {
    if (recentMs && safeMtime(f) < recentMs) continue;
    let lines;
    try { lines = readFileSync(f, "utf8").split("\n"); } catch { continue; }
    const byId = new Map();
    let lastAssistantId = null;
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch { continue; }
      if (e.type === "assistant" && e.message?.usage) {
        const u = e.message.usage;
        const id = e.message.id || e.uuid || `${f}#${byId.size}`;
        const ts = Date.parse(e.timestamp || "") || null;
        if (recentMs && ts && ts < recentMs) continue;
        const rec = {
          id: `claude:${id}`, tool: "claude", session: basename(f, ".jsonl"),
          model: e.message.model || "(unknown)", ts,
          input: u.input_tokens || 0, output: u.output_tokens || 0, reasoning: 0,
          cacheRead: u.cache_read_input_tokens || 0,
          cacheWrite: u.cache_creation_input_tokens || 0,
          cost: null, durationMs: null,
        };
        const prev = byId.get(id);
        if (!prev) byId.set(id, rec);
        else if (rec.output > prev.output) {
          const keepDuration = prev.durationMs; // keep a duration already paired to a turn
          Object.assign(prev, rec);
          prev.durationMs = keepDuration;
        }
        lastAssistantId = id;
      } else if (e.type === "system" && lastAssistantId) {
        // Claude Code writes {"type":"system","subtype":"turn_duration","durationMs":N}
        const dur = e.durationMs ?? e.duration_ms;
        const rec = byId.get(lastAssistantId);
        if (typeof dur === "number" && rec && rec.durationMs == null && rec.output > 0 && dur > 250) {
          rec.durationMs = dur;
          lastAssistantId = null;
        }
      }
    }
    for (const rec of byId.values()) {
      records.push(rec);
      if (rec.durationMs) {
        speeds.push({
          id: rec.id, tool: "claude", session: rec.session, model: rec.model,
          ts: rec.ts, output: rec.output, durationMs: rec.durationMs, quality: "approx",
        });
      }
    }
  }
  return { records, speeds, detected, note: null };
}

function parseCodex({ recentMs = 0 } = {}) {
  const records = [], speeds = [];
  const base = SOURCE_DIRS.codex;
  const detected = existsSync(base);
  if (!detected) return { records, speeds, detected, note: null };
  for (const f of walkFiles(base, ".jsonl")) {
    if (recentMs && safeMtime(f) < recentMs) continue;
    let lines;
    try { lines = readFileSync(f, "utf8").split("\n"); } catch { continue; }
    let model = "(unknown)";
    let sessionId = basename(f);
    let prev = null;
    for (const line of lines) {
      const s = line.trim();
      if (!s) continue;
      let e;
      try { e = JSON.parse(s); } catch { continue; }
      if (e.type === "session_meta" && e.payload?.id) sessionId = e.payload.id;
      if (e.type === "turn_context" && e.payload?.model) model = e.payload.model;
      if (e.type !== "event_msg" || e.payload?.type !== "token_count" || !e.payload.info) continue;
      const t = e.payload.info.total_token_usage || {};
      const ts = Date.parse(e.timestamp || "") || null;
      if (ts == null) continue;
      const cur = {
        ts, input: t.input_tokens || 0, cached: t.cached_input_tokens || 0,
        output: t.output_tokens || 0, reasoning: t.reasoning_output_tokens || 0,
      };
      const d = prev
        ? {
            input: Math.max(0, cur.input - prev.input),
            cached: Math.max(0, cur.cached - prev.cached),
            output: Math.max(0, cur.output - prev.output),
            reasoning: Math.max(0, cur.reasoning - prev.reasoning),
          }
        : { input: cur.input, cached: cur.cached, output: cur.output, reasoning: cur.reasoning };
      const isNew = !recentMs || ts >= recentMs;
      if (isNew) {
        const rec = {
          id: `codex:${sessionId}:${ts}`, tool: "codex", session: sessionId,
          model, ts, input: Math.max(0, d.input - d.cached), output: d.output,
          reasoning: d.reasoning, cacheRead: d.cached, cacheWrite: 0, cost: null,
        };
        if (rec.input + rec.output + rec.reasoning + rec.cacheRead > 0) records.push(rec);
        if (prev && d.output > 0) {
          const dt = ts - prev.ts;
          if (dt >= 500 && dt <= 180000) {
            speeds.push({
              id: rec.id, tool: "codex", session: sessionId, model,
              ts, output: d.output, durationMs: dt, quality: "approx",
            });
          }
        }
      }
      prev = cur;
    }
  }
  return { records, speeds, detected, note: null };
}

function parseGemini({ recentMs = 0 } = {}) {
  const records = [], speeds = [];
  let detected = false;
  const files = [];
  for (const b of [...new Set(SOURCE_DIRS.gemini)]) {
    if (!existsSync(b)) continue;
    detected = true;
    for (const f of walkFiles(b, ".json")) {
      if (basename(f).startsWith("session-")) files.push(f);
    }
  }
  for (const f of files) {
    if (recentMs && safeMtime(f) < recentMs) continue;
    let obj;
    try { obj = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    const msgs = Array.isArray(obj.messages) ? obj.messages : [];
    const session = obj.sessionId || basename(f, ".json");
    const fallbackTs = Date.parse(obj.lastUpdated || obj.startTime || "") || null;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.type !== "gemini" || !m.tokens) continue;
      const ts = Date.parse(m.timestamp || m.time || "") || fallbackTs;
      if (ts == null || (recentMs && ts < recentMs)) continue;
      const tk = m.tokens;
      records.push({
        id: `gemini:${session}:${i}`, tool: "gemini", session,
        model: m.model || obj.model || "(unknown)", ts,
        input: tk.input || 0, output: tk.output || 0, reasoning: tk.thoughts || 0,
        cacheRead: tk.cached || 0, cacheWrite: 0, cost: null,
      });
    }
  }
  return { records, speeds, detected, note: null };
}

/* ------------------------------- collection ------------------------------ */

function collectAll({ recentMs = 0 } = {}) {
  const parsers = [
    ["opencode", parseOpenCode],
    ["claude", parseClaude],
    ["codex", parseCodex],
    ["gemini", parseGemini],
  ];
  const out = { records: [], speeds: [], sources: {} };
  for (const [tool, fn] of parsers) {
    if (opts.tools && !opts.tools.includes(tool)) continue;
    try {
      const r = fn({ recentMs });
      out.records.push(...r.records);
      out.speeds.push(...r.speeds);
      out.sources[tool] = { detected: r.detected, records: r.records.length, note: r.note || null };
    } catch (e) {
      out.sources[tool] = { detected: false, records: 0, note: String(e?.message || e) };
    }
  }
  return out;
}

const filterSince = (list, ms) => (ms > 0 ? list.filter((r) => r.ts && r.ts >= ms) : list);

function groupByModel(items) {
  const groups = new Map();
  for (const r of items) {
    const k = `${r.tool}\u0000${r.model}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

/* -------------------------------- reporting ------------------------------ */

function buildJson(collected, records, speeds) {
  const byTool = {};
  for (const tool of Object.keys(collected.sources)) {
    byTool[tool] = totalsOf(records.filter((r) => r.tool === tool));
  }
  const recGroups = groupByModel(records);
  const spGroups = groupByModel(speeds);
  const byModel = [...recGroups.entries()]
    .map(([k, recs]) => {
      const [tool, model] = k.split("\u0000");
      return { tool, model, ...totalsOf(recs), speed: speedStats(spGroups.get(k) || []) };
    })
    .sort((a, b) => b.total - a.total);
  const speedByTool = {};
  for (const tool of Object.keys(collected.sources)) {
    speedByTool[tool] = speedStats(speeds.filter((s) => s.tool === tool));
  }
  return {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    since: opts.since || null,
    sources: collected.sources,
    totals: { all: totalsOf(records), byTool },
    byModel,
    speed: { byTool: speedByTool },
  };
}

function cmdSummary() {
  const sinceMs = parseSince(opts.since);
  const collected = collectAll();
  const records = filterSince(collected.records, sinceMs);
  const speeds = filterSince(collected.speeds, sinceMs);
  const data = buildJson(collected, records, speeds);

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const lines = [];
  lines.push(`AI TOKEN STATS v${VERSION}  ·  ${new Date().toLocaleString()}  ·  since: ${opts.since || "all time"}`);
  lines.push("");
  lines.push("TOTALS BY TOOL");
  for (const [tool, t] of Object.entries(data.totals.byTool)) {
    const src = collected.sources[tool] || { detected: false };
    if (!src.detected) { lines.push(`  [${tool}]  not detected`); continue; }
    if (!t.requests) { lines.push(`  [${tool}]  detected, no usage in range`); continue; }
    lines.push(`  [${tool}]  ${t.requests} requests · ${t.sessions} sessions`);
    lines.push(
      `      ${fmt(t.total)} tokens  =  in ${fmt(t.input)} + out ${fmt(t.output)} + reason ${fmt(t.reasoning)}` +
      ` + cacheR ${fmt(t.cacheRead)} + cacheW ${fmt(t.cacheWrite)}` +
      (t.cost != null ? `  ·  cost $${t.cost}` : "")
    );
  }
  const all = data.totals.all;
  lines.push(`  [ALL]  ${fmt(all.total)} tokens · ${all.requests} requests · ${all.sessions} sessions`);
  if (data.byModel.length) {
    lines.push("");
    lines.push("TOP MODELS");
    lines.push(renderTable(
      ["model", "tool", "reqs", "input", "output", "cache-read", "total", "avg tok/s"],
      data.byModel.slice(0, 15).map((m) => [
        m.model, m.tool, m.requests, fmt(m.input), fmt(m.output), fmt(m.cacheRead), fmt(m.total),
        m.speed.n ? `${m.speed.avg}${m.speed.quality === "approx" ? "~" : ""}` : "-",
      ])
    ));
    lines.push("  tok/s marked ~ is approximate (turn-level timing); see README for details.");
  }
  console.log(lines.join("\n"));
}

function cmdSpeed() {
  const sinceMs = parseSince(opts.since);
  const collected = collectAll();
  const records = filterSince(collected.records, sinceMs);
  const speeds = filterSince(collected.speeds, sinceMs);

  if (opts.json) {
    console.log(JSON.stringify(buildJson(collected, records, speeds).speed, null, 2));
    return;
  }

  const lines = [`GENERATION SPEED (tokens/sec)  ·  since: ${opts.since || "all time"}`, ""];
  for (const tool of Object.keys(collected.sources)) {
    if (!collected.sources[tool].detected) { lines.push(`  [${tool}]  not detected`); continue; }
    const st = speedStats(speeds.filter((s) => s.tool === tool));
    if (!st.n) { lines.push(`  [${tool}]  no timing samples`); continue; }
    lines.push(`  [${tool}]  ${st.n} samples (${st.quality})   avg ${st.avg} · p50 ${st.p50} · p90 ${st.p90} · max ${st.max} tok/s`);
  }
  const rows = [...groupByModel(speeds).entries()]
    .map(([k, ss]) => {
      const [tool, model] = k.split("\u0000");
      const st = speedStats(ss);
      return [model, tool, st.n, st.avg, st.p50, st.max, st.quality];
    })
    .filter((row) => row[2] > 0)
    .sort((a, b) => b[3] - a[3]);
  if (rows.length) {
    lines.push("");
    lines.push("BY MODEL");
    lines.push(renderTable(["model", "tool", "samples", "avg", "p50", "max", "quality"], rows));
  }
  lines.push("");
  lines.push("  exact  = duration recorded by the app itself (end-to-end, incl. first-token latency)");
  lines.push("  approx = derived from turn durations / token-count deltas (tool execution may be included)");
  console.log(lines.join("\n"));
}

async function cmdWatch() {
  process.on("SIGINT", () => { console.log("\nstopped."); process.exit(0); });
  const seen = new Map();
  const seenSpeeds = new Map();
  let first = true;
  let polls = 0;

  if (!opts.json) console.log(`WATCHING (poll every ${opts.interval}s, Ctrl+C to stop)`);

  for (;;) {
    const collected = collectAll({ recentMs: Date.now() - 2 * 3600 * 1000 });
    if (first && !opts.json) {
      const det = Object.entries(collected.sources).map(([k, v]) => `${k}:${v.detected ? "on" : "off"}`).join("  ");
      console.log(`sources  ${det}`);
      console.log("");
    }
    // A message that was still streaming when the watcher started is updated, not
    // new: compare a fingerprint (timestamp + tokens + duration) instead of the id.
    const fresh = [];
    for (const r of collected.records) {
      const f = `${r.ts || 0}:${r.output}`;
      if (seen.get(r.id) !== f) { seen.set(r.id, f); fresh.push(r); }
    }
    const freshSpeeds = [];
    for (const s of collected.speeds) {
      const f = `${s.ts || 0}:${s.output}:${s.durationMs}`;
      if (seenSpeeds.get(s.id) !== f) { seenSpeeds.set(s.id, f); freshSpeeds.push(s); }
    }

    // Replay recent history once so a fresh consumer is never blank.
    if (first && opts.json && opts.history > 0) {
      const sorted = [...collected.speeds].sort((a, b) => a.ts - b.ts).slice(-opts.history);
      const items = sorted.map((s) => ({
        id: s.id, kind: "generation", ts: s.ts, tool: s.tool, model: s.model,
        outputTokens: s.output, durationSec: r1(s.durationMs / 1000),
        speed: r1(tokPerSec(s)), quality: s.quality,
      }));
      if (items.length < 3) {
        const withSpeed = new Set(collected.speeds.map((s) => s.id));
        const recs = [...collected.records].sort((a, b) => a.ts - b.ts).slice(-opts.history);
        for (const r of recs) {
          if (withSpeed.has(r.id)) continue;
          items.push({
            id: r.id, kind: "usage", ts: r.ts, tool: r.tool, model: r.model,
            inputTokens: r.input, outputTokens: r.output, reasoningTokens: r.reasoning,
            cacheRead: r.cacheRead,
            totalTokens: r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite,
          });
        }
      }
      items.sort((a, b) => a.ts - b.ts);
      console.log(JSON.stringify({ event: "history", count: items.length, items }));
    }

    if (!first) {
      const emitted = new Set();
      for (const s of freshSpeeds) {
        const spd = r1(tokPerSec(s));
        if (opts.json) {
          console.log(JSON.stringify({
            event: "generation", id: s.id, ts: s.ts, tool: s.tool, model: s.model, session: s.session,
            outputTokens: s.output, durationSec: r1(s.durationMs / 1000), speed: spd, quality: s.quality,
          }));
        } else {
          console.log(
            `${new Date(s.ts).toLocaleTimeString()}  ${s.tool.padEnd(8)} ` +
            `${String(s.model).padEnd(28)} ${String(s.output).padStart(6)} out · ${(s.durationMs / 1000).toFixed(1)}s · ${spd} tok/s (${s.quality})`
          );
        }
        emitted.add(s.id);
      }
      for (const r of fresh) {
        if (emitted.has(r.id)) continue;
        const total = r.input + r.output + r.reasoning + r.cacheRead + r.cacheWrite;
        if (opts.json) {
          console.log(JSON.stringify({
            event: "usage", id: r.id, ts: r.ts, tool: r.tool, model: r.model, session: r.session,
            inputTokens: r.input, outputTokens: r.output, reasoningTokens: r.reasoning,
            cacheRead: r.cacheRead, totalTokens: total,
          }));
        } else {
          console.log(
            `${new Date(r.ts).toLocaleTimeString()}  ${r.tool.padEnd(8)} ${String(r.model).padEnd(28)} ` +
            `${String(total).padStart(6)} tokens (${r.input} in / ${r.output} out) · no timing data`
          );
        }
      }
    }
    first = false;
    if (opts.cycles) {
      if (polls >= opts.cycles) break;
      polls++;
    }
    await sleep(opts.interval * 1000);
  }
}

/* ---------------------------------- list --------------------------------- */

async function cmdList() {
  const collected = collectAll();
  const ollamaBase = envOr("TOKEN_STATS_OLLAMA_URL", "http://127.0.0.1:11434").replace(/\/+$/, "");
  const lmBase = envOr("TOKEN_STATS_LMSTUDIO_URL", "http://127.0.0.1:1234").replace(/\/+$/, "");
  const llamaBase = envOr("TOKEN_STATS_LLAMACPP_URL", "http://127.0.0.1:8080").replace(/\/+$/, "");

  let ollama = null, lmstudio = null, llamacpp = null;
  try {
    const v = await fetchJson(`${ollamaBase}/api/version`, {}, 1000);
    const tags = await fetchJson(`${ollamaBase}/api/tags`, {}, 1000);
    ollama = { version: v.version || null, models: (tags.models || []).length };
  } catch { /* not running */ }
  try {
    let models = [];
    try { models = (await fetchJson(`${lmBase}/api/v0/models`, {}, 1000)).data || []; }
    catch { models = (await fetchJson(`${lmBase}/v1/models`, {}, 1000)).data || []; }
    lmstudio = { models: models.length };
  } catch { /* not running */ }
  try {
    const r = await fetch(`${llamaBase}/health`, { signal: AbortSignal.timeout(1000) });
    if (r.ok) llamacpp = { status: (await r.json()).status || "ok" };
  } catch { /* not running */ }

  const paths = {
    opencode: SOURCE_DIRS.opencode, claude: SOURCE_DIRS.claude,
    codex: SOURCE_DIRS.codex, gemini: SOURCE_DIRS.gemini,
  };
  const data = {
    fileSources: collected.sources,
    paths,
    servers: {
      ollama: { url: ollamaBase, ...(ollama || { running: false }) },
      lmstudio: { url: lmBase, ...(lmstudio || { running: false }) },
      llamacpp: { url: llamaBase, ...(llamacpp || { running: false }) },
    },
  };
  if (opts.json) { console.log(JSON.stringify(data, null, 2)); return; }

  const lines = ["DETECTED SOURCES", ""];
  lines.push(renderTable(
    ["kind", "source", "location", "detail"],
    [
      ...Object.entries(collected.sources).map(([tool, s]) => {
        const p = Array.isArray(paths[tool]) ? paths[tool][0] : paths[tool];
        return ["file", `[${s.detected ? "x" : " "}] ${tool}`, p || "", s.detected ? `${s.records} usage records` : s.note || "not found"];
      }),
      ["server", `[${ollama ? "x" : " "}] ollama`, ollamaBase, ollama ? `running · v${ollama.version ?? "?"} · ${ollama.models} models` : "not running"],
      ["server", `[${lmstudio ? "x" : " "}] lmstudio`, lmBase, lmstudio ? `running · ${lmstudio.models} models` : "not running"],
      ["server", `[${llamacpp ? "x" : " "}] llamacpp`, llamaBase, llamacpp ? `running (${llamacpp.status})` : "not running"],
    ]
  ));
  console.log(lines.join("\n"));
}

/* ---------------------------------- bench -------------------------------- */

async function probeReachable(url, ms = 900) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.status < 500;
  } catch { return false; }
}

async function benchOllama(base) {
  const version = (await fetchJson(`${base}/api/version`, {}, 1500)).version;
  const tags = await fetchJson(`${base}/api/tags`, {}, 1500);
  const models = tags.models || [];
  if (!models.length) throw new Error("ollama has no models installed");
  const model = opts.model || [...models].sort((a, b) => (a.size || 0) - (b.size || 0))[0].name;
  const t0 = Date.now();
  const r = await fetchJson(`${base}/api/generate`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: promptText(), stream: false, options: { num_predict: opts.maxTokens } }),
  }, 600000);
  const wallSec = (Date.now() - t0) / 1000;
  const genSec = (r.eval_duration || 0) / 1e9 || wallSec;
  const outTok = r.eval_count || 0;
  const promptSec = (r.prompt_eval_duration || 0) / 1e9;
  return {
    tool: "ollama", url: base, model, version, maxTokens: opts.maxTokens,
    loadSec: r1((r.load_duration || 0) / 1e9),
    promptTokens: r.prompt_eval_count || 0, promptSec: r1(promptSec),
    promptSpeed: r.prompt_eval_count && promptSec ? r1(r.prompt_eval_count / promptSec) : null,
    outputTokens: outTok, generationSec: r1(genSec),
    speed: r1(outTok && genSec ? outTok / genSec : 0), wallSec: r1(wallSec),
  };
}

async function benchLmStudio(base) {
  let api = "v0", models = [];
  try { models = (await fetchJson(`${base}/api/v0/models`, {}, 1500)).data || []; }
  catch { api = "openai"; models = (await fetchJson(`${base}/v1/models`, {}, 1500)).data || []; }
  const model = opts.model || models[0]?.id;
  if (!model) throw new Error("no model found; load one in LM Studio or pass --model <id>");
  const t0 = Date.now();
  if (api === "v0") {
    const r = await fetchJson(`${base}/api/v0/completion`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, prompt: promptText(), max_tokens: opts.maxTokens }),
    }, 600000);
    const st = r.stats || {};
    const wallSec = (Date.now() - t0) / 1000;
    const outTok = st.generation_length ?? r.usage?.completion_tokens ?? 0;
    const genSec = st.generation_time ?? wallSec;
    return {
      tool: "lmstudio", url: base, model, maxTokens: opts.maxTokens,
      loadSec: st.model_load_time != null ? r1(st.model_load_time) : null,
      timeToFirstToken: st.time_to_first_token != null ? r1(st.time_to_first_token) : null,
      outputTokens: outTok, generationSec: r1(genSec),
      speed: r1(st.tokens_per_second ?? (outTok && genSec ? outTok / genSec : 0)),
      wallSec: r1(wallSec),
    };
  }
  const r = await fetchJson(`${base}/v1/completions`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, prompt: promptText(), max_tokens: opts.maxTokens }),
  }, 600000);
  const wallSec = (Date.now() - t0) / 1000;
  const outTok = r.usage?.completion_tokens || 0;
  return {
    tool: "lmstudio", url: base, model, maxTokens: opts.maxTokens,
    outputTokens: outTok, generationSec: r1(wallSec),
    speed: r1(outTok && wallSec ? outTok / wallSec : 0), wallSec: r1(wallSec),
  };
}

async function benchLlamaCpp(base) {
  const t0 = Date.now();
  const r = await fetchJson(`${base}/completion`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: promptText(), n_predict: opts.maxTokens, stream: false }),
  }, 600000);
  const wallSec = (Date.now() - t0) / 1000;
  const t = r.timings || {};
  const outTok = t.predicted_n || 0;
  const genSec = (t.predicted_ms || 0) / 1000 || wallSec;
  return {
    tool: "llamacpp", url: base, model: r.model || opts.model || "(server default)",
    maxTokens: opts.maxTokens,
    promptTokens: t.prompt_n || 0, promptSec: r1((t.prompt_ms || 0) / 1000),
    promptSpeed: t.prompt_per_second != null ? r1(t.prompt_per_second) : null,
    outputTokens: outTok, generationSec: r1(genSec),
    speed: r1(t.predicted_per_second ?? (outTok && genSec ? outTok / genSec : 0)),
    wallSec: r1(wallSec),
  };
}

async function cmdBench() {
  const target = opts.target || "auto";
  const names = target === "auto" ? ["ollama", "lmstudio", "llamacpp"] : [target];
  const bases = {
    ollama: envOr("TOKEN_STATS_OLLAMA_URL", "http://127.0.0.1:11434").replace(/\/+$/, ""),
    lmstudio: envOr("TOKEN_STATS_LMSTUDIO_URL", "http://127.0.0.1:1234").replace(/\/+$/, ""),
    llamacpp: envOr("TOKEN_STATS_LLAMACPP_URL", "http://127.0.0.1:8080").replace(/\/+$/, ""),
  };
  const probes = {
    ollama: `${bases.ollama}/api/version`,
    lmstudio: `${bases.lmstudio}/v1/models`,
    llamacpp: `${bases.llamacpp}/health`,
  };
  const results = [];
  for (const name of names) {
    if (!["ollama", "lmstudio", "llamacpp"].includes(name)) {
      console.error(`unknown bench target: ${name} (use ollama | lmstudio | llamacpp | auto)`);
      process.exitCode = 1;
      return;
    }
    try {
      if (target === "auto" && !(await probeReachable(probes[name]))) continue;
      const r = name === "ollama" ? await benchOllama(bases.ollama)
        : name === "lmstudio" ? await benchLmStudio(bases.lmstudio)
        : await benchLlamaCpp(bases.llamacpp);
      results.push(r);
    } catch (e) {
      if (target !== "auto") { console.error(`${name}: ${e.message}`); process.exitCode = 1; }
    }
  }
  if (!results.length) {
    if (!process.exitCode) {
      console.log("No local LLM server responded (tried ollama :11434, LM Studio :1234, llama.cpp :8080).");
      console.log("Start one, or set TOKEN_STATS_OLLAMA_URL / TOKEN_STATS_LMSTUDIO_URL / TOKEN_STATS_LLAMACPP_URL.");
      process.exitCode = 1;
    }
    return;
  }
  if (opts.json) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const r of results) {
    console.log(`${r.tool.toUpperCase()} BENCHMARK  ${r.url}  model=${r.model}  max_tokens=${r.maxTokens}`);
    if (r.loadSec) console.log(`  model load:       ${r.loadSec} s`);
    if (r.promptTokens) console.log(`  prompt eval:      ${r.promptTokens} tok in ${r.promptSec}s  ->  ${r.promptSpeed ?? "-"} tok/s${r.timeToFirstToken ? ` · TTFT ${r.timeToFirstToken}s` : ""}`);
    console.log(`  generation:       ${r.outputTokens} tok in ${r.generationSec}s  ->  ${r.speed} tok/s`);
    console.log(`  wall clock:       ${r.wallSec} s`);
    console.log("");
  }
}

/* ---------------------------------- help --------------------------------- */

function printHelp() {
  console.log(`token-stats.mjs v${VERSION} — AI token usage & generation speed monitor (local, read-only)

Usage:
  node token-stats.mjs [command] [options]

Commands:
  summary           Token totals by tool and model (default)
  speed             Generation speed stats from session history
  watch             Live view: prints speed of newly completed generations
  bench [target]    Live benchmark: ollama | lmstudio | llamacpp | auto (default: auto)
  list              Show which AI software and data was detected

Options:
  --since <7d|24h|2w|2026-01-01>  Only count activity since this time
  --tool <opencode,claude,codex,gemini>  Limit to specific tools
  --json                          Output JSON (watch: JSON Lines)
  --interval <seconds>            watch poll interval (default 2)
  --history <n>                   watch: replay this many recent events on start (default 12, 0 = none)
  --model <name>                  bench: model to test (default: smallest available)
  --prompt <text>                 bench: prompt to use
  --max-tokens <n>                bench: max generated tokens (default 128)
  --home <dir>                    Override home directory (advanced/testing)

Env overrides:
  TOKEN_STATS_OPENCODE_DIR   TOKEN_STATS_CLAUDE_DIR   TOKEN_STATS_CODEX_DIR
  TOKEN_STATS_GEMINI_DIR     TOKEN_STATS_OLLAMA_URL  TOKEN_STATS_LMSTUDIO_URL
  TOKEN_STATS_LLAMACPP_URL

Sources:
  OpenCode     ~/.local/share/opencode (SQLite db + legacy JSON storage)
  Claude Code  ~/.claude/projects/**/*.jsonl
  Codex CLI    ~/.codex/sessions/**/rollout-*.jsonl
  Gemini CLI   ~/.gemini/tmp/**/chats/session-*.json
  Servers      Ollama :11434 · LM Studio :1234 · llama.cpp :8080 (localhost only)`);
}

/* ---------------------------------- main --------------------------------- */

async function main() {
  if (opts.help) { printHelp(); return; }
  switch (opts.cmd) {
    case "summary": case "stats": case "usage": return cmdSummary();
    case "speed": case "speeds": return cmdSpeed();
    case "watch": case "live": return cmdWatch();
    case "bench": case "benchmark": return cmdBench();
    case "list": case "sources": case "detect": return cmdList();
    default:
      console.error(`Unknown command: ${opts.cmd}\n`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("error:", e?.stack || e?.message || e);
  process.exitCode = 1;
});
