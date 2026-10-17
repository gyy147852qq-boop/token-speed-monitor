#!/usr/bin/env node
/**
 * Offline test suite for token-stats.mjs.
 *
 * Builds synthetic session files that mimic the real formats of OpenCode
 * (SQLite + legacy JSON), Claude Code, Codex CLI and Gemini CLI, then runs
 * the tool against them with env overrides and asserts the numbers.
 *
 * Run:  node test/run-tests.mjs
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "scripts", "token-stats.mjs");

const fx = join(tmpdir(), `token-stats-fixtures-${process.pid}`);
rmSync(fx, { recursive: true, force: true });

const write = (rel, content) => {
  const p = join(fx, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};

/* ------------------------------ fixtures ------------------------------ */

// Claude Code: ~/.claude/projects/<proj>/<session>.jsonl
write(
  "claude/projects/demo/s1.jsonl",
  [
    { type: "user", timestamp: "2026-10-01T10:00:00.000Z", message: { role: "user", content: "hi" } },
    {
      type: "assistant", timestamp: "2026-10-01T10:00:05.000Z",
      message: {
        id: "msg_1", model: "claude-sonnet-4-5",
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 },
      },
    },
    { type: "system", subtype: "turn_duration", durationMs: 5000, timestamp: "2026-10-01T10:00:05.100Z" },
    {
      type: "assistant", timestamp: "2026-10-01T10:01:00.000Z",
      message: {
        id: "msg_2", model: "claude-sonnet-4-5",
        usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n"
);

// Codex CLI: ~/.codex/sessions/<y>/<m>/<d>/rollout-*.jsonl
write(
  "codex/sessions/2026/10/01/rollout-2026-10-01T10-00-00-abc.jsonl",
  [
    { timestamp: "2026-10-01T10:00:00.000Z", type: "session_meta", payload: { id: "sess-codex-1", cwd: "C:\\demo" } },
    { timestamp: "2026-10-01T10:00:01.000Z", type: "turn_context", payload: { model: "gpt-5.2-codex" } },
    {
      timestamp: "2026-10-01T10:00:02.000Z", type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50,
            reasoning_output_tokens: 10, total_tokens: 1050,
          },
        },
      },
    },
    {
      timestamp: "2026-10-01T10:00:12.000Z", type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1100, cached_input_tokens: 400, output_tokens: 150,
            reasoning_output_tokens: 10, total_tokens: 1250,
          },
        },
      },
    },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n"
);

// Gemini CLI: ~/.gemini/tmp/<proj>/chats/session-*.json
write(
  "gemini/tmp/proj/chats/session-1.json",
  JSON.stringify({
    sessionId: "gem-1",
    startTime: "2026-10-01T10:00:00.000Z",
    lastUpdated: "2026-10-01T10:05:00.000Z",
    messages: [
      { type: "user", timestamp: "2026-10-01T10:00:00.000Z", content: "hi" },
      {
        type: "gemini", timestamp: "2026-10-01T10:00:20.000Z", model: "gemini-2.5-pro",
        tokens: { input: 100, output: 200, cached: 0, thoughts: 50, tool: 0, total: 350 },
      },
    ],
  })
);

// OpenCode legacy JSON storage (v1.x): storage/message/<ses>/<msg>.json
write(
  "opencode-case/storage/message/ses_1/msg_a.json",
  JSON.stringify({
    id: "msg_a", role: "assistant", sessionID: "ses_1",
    modelID: "test-legacy-model", providerID: "test", cost: 0.01,
    tokens: { input: 5, output: 7, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1792000000000, completed: 1792000001000 },
  })
);

// OpenCode modern SQLite database
const { DatabaseSync } = await import("node:sqlite");
const dbPath = join(fx, "opencode-case", "opencode.db");
mkdirSync(dirname(dbPath), { recursive: true });
{
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)");
  db.prepare("INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)").run(
    "msg_db1", "ses_db", 1792000102000,
    JSON.stringify({
      role: "assistant", modelID: "test-db-model", providerID: "test", cost: 0,
      tokens: { input: 11, output: 20, reasoning: 0, cache: { read: 3, write: 0 } },
      time: { created: 1792000100000, completed: 1792000102000 },
    })
  );
  db.close();
}

/* ------------------------------ run tool ------------------------------ */

const emptyHome = join(fx, "empty-home");
mkdirSync(emptyHome, { recursive: true });
const env = {
  ...process.env,
  TOKEN_STATS_OPENCODE_DIR: join(fx, "opencode-case"),
  TOKEN_STATS_CLAUDE_DIR: join(fx, "claude"),
  TOKEN_STATS_CODEX_DIR: join(fx, "codex"),
  TOKEN_STATS_GEMINI_DIR: join(fx, "gemini"),
};

const res = spawnSync(
  process.execPath,
  [script, "summary", "--json", "--home", emptyHome],
  { encoding: "utf8", env }
);
if (res.status !== 0) {
  console.error("tool exited with", res.status);
  console.error(res.stdout);
  console.error(res.stderr);
  process.exit(1);
}

let j;
try { j = JSON.parse(res.stdout); }
catch {
  console.error("could not parse JSON output:\n", res.stdout, res.stderr);
  process.exit(1);
}

/* ------------------------------ assertions ---------------------------- */

let failed = 0;
function check(name, actual, expected) {
  const ok = typeof expected === "number"
    ? Math.abs(actual - expected) < 1e-6
    : actual === expected;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `   (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
  if (!ok) failed++;
}

const oc = j.totals.byTool.opencode;
check("opencode input", oc.input, 16);
check("opencode output", oc.output, 27);
check("opencode cacheRead", oc.cacheRead, 3);
check("opencode requests", oc.requests, 2);
check("opencode cost", oc.cost, 0.01);
check("opencode speed avg", j.speed.byTool.opencode.avg, 8.5);
check("opencode speed quality", j.speed.byTool.opencode.quality, "exact");

const cl = j.totals.byTool.claude;
check("claude input", cl.input, 220);
check("claude output", cl.output, 130);
check("claude cacheRead", cl.cacheRead, 10);
check("claude cacheWrite", cl.cacheWrite, 5);
check("claude speed avg", j.speed.byTool.claude.avg, 10);
check("claude speed quality", j.speed.byTool.claude.quality, "approx");

const cx = j.totals.byTool.codex;
check("codex input", cx.input, 700);
check("codex output", cx.output, 150);
check("codex reasoning", cx.reasoning, 10);
check("codex cacheRead", cx.cacheRead, 400);
check("codex speed avg", j.speed.byTool.codex.avg, 10);

const gm = j.totals.byTool.gemini;
check("gemini input", gm.input, 100);
check("gemini output", gm.output, 200);
check("gemini reasoning", gm.reasoning, 50);
check("gemini no speed samples", j.speed.byTool.gemini.n, 0);

check("all output", j.totals.all.output, 507);

const claudeModel = j.byModel.find((m) => m.tool === "claude");
check("claude model name", claudeModel?.model, "claude-sonnet-4-5");

/* ------------------------------ watch smoke --------------------------- */

const w = spawnSync(
  process.execPath,
  [script, "watch", "--cycles", "1", "--interval", "0.5", "--json", "--home", emptyHome],
  { encoding: "utf8", env, timeout: 30000 }
);
check("watch exits cleanly", w.status, 0);

/* ------------------------------ cleanup ------------------------------- */

rmSync(fx, { recursive: true, force: true });

console.log("");
if (failed) {
  console.log(`${failed} test(s) FAILED`);
  process.exit(1);
}
console.log("All tests passed.");
