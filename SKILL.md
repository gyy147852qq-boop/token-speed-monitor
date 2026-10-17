---
name: token-speed-monitor
description: >
  Measure token usage totals and generation speed (tokens/sec) of the AI
  software installed on this computer: OpenCode, Claude Code, Codex CLI,
  Gemini CLI, Ollama, LM Studio, llama.cpp. Use when the user asks about
  token usage, token totals, token counter, generation speed, tokens per
  second, tok/s, output speed, how fast a model generates, or wants a live
  benchmark of a local LLM. Triggers: 用量统计, token 总量, 生成速度,
  每秒 token, tok/s, token speed, token usage, benchmark, ollama speed.
---

# Token Speed Monitor

Measures two things about the AI software on this machine, fully locally and read-only:

1. **Token totals** — how many tokens every tool has consumed (input, output,
   reasoning, cache read/write), per tool, per model, per time range.
2. **Generation speed** — tokens per second (tok/s), both as history statistics
   from session logs and as a live benchmark for local LLM servers.

No dependencies. Node >= 22 recommended (node:sqlite is only needed for the
OpenCode database; all JSONL sources work on older Node).

## Quick start

Run from this skill's directory (or use an absolute path):

```bash
node scripts/token-stats.mjs summary      # token totals by tool & model (default)
node scripts/token-stats.mjs speed        # generation speed stats from history
node scripts/token-stats.mjs watch        # live: print tok/s of new completions
node scripts/token-stats.mjs bench        # live benchmark of local LLM servers
node scripts/token-stats.mjs list         # show which AI software was detected
```

Use `--json` whenever you need to parse the output programmatically.
Use `--since 7d` (or `24h`, `2w`, an ISO date) to limit the time range.
Use `--tool opencode,claude,codex,gemini` to filter sources.

## Recommended workflow

1. Start with `list` to see what was detected on this machine.
2. For "how many tokens did I use" questions: `summary --json --since <range>`.
3. For "how fast is it generating" questions:
   - Recent/historical speed → `speed --json`;
   - Local models (Ollama / LM Studio / llama.cpp) → `bench --json` for a real,
     reproducible decode-speed measurement.
   - "Right now" while the user works → `watch` (prints one line per completed
     generation; Ctrl+C to stop).
4. Report numbers with their meaning: `exact` = the app timed the call itself;
   `approx` = derived from turn durations or token-count deltas, may include
   tool execution time.

## Dashboard (GUI)

This skill also ships a local dashboard for users who prefer a visual view
(cards, charts, live speed feed, one-click local-model benchmark):

```bash
node app/server.mjs          # serves http://127.0.0.1:7391/ and opens the browser
```

- On Windows the launcher is `启动面板.cmd`; keep its window open to keep serving.
- `TOKEN_STATS_PORT=<port>` changes the port, `TOKEN_STATS_NO_OPEN=1` skips the browser launch.
- The dashboard reads the same data by calling this CLI with `--json`, so the commands
  above remain the authoritative source for numbers you report.

## What each source provides

| Source      | Where data comes from                                       | Speed                            |
| ----------- | ----------------------------------------------------------- | -------------------------------- |
| opencode    | `~/.local/share/opencode/opencode.db` + legacy JSON storage | exact (call start → completion)  |
| claude      | `~/.claude/projects/**/*.jsonl` (Claude Code)               | approx (turn_duration pairing)   |
| codex       | `~/.codex/sessions/**/rollout-*.jsonl` (Codex CLI)          | approx (token-count deltas)      |
| gemini      | `~/.gemini/tmp/**/chats/session-*.json` (Gemini CLI)        | totals only (no call timing)     |
| ollama      | `http://127.0.0.1:11434` (must be running)                  | exact (eval_count/eval_duration) |
| lmstudio    | `http://127.0.0.1:1234` (must be running)                   | exact (server-reported stats)    |
| llamacpp    | `http://127.0.0.1:8080` (must be running)                   | exact (server timings)           |

## Rules

- This tool is strictly read-only: never modify session files, databases or
  server state. It only sends HTTP requests to **localhost** LLM servers for
  benchmarks (and only when `bench` or `list` is run).
- Prefer `--json` output for anything that will be parsed or summarized.
- If a source shows "not detected", report the path that was checked
  (printed by `list`) instead of guessing.
- `bench` with no running server exits with code 1 and explains how to start
  one or override URLs via `TOKEN_STATS_*_URL` env vars — relay that to the user.
- On Windows, run via PowerShell/cmd as usual; paths are resolved from the
  user's home directory.

## Troubleshooting

- **OpenCode numbers are missing** → the tool needs Node >= 22.5 (`node:sqlite`).
  Check with `node --version`.
- **Claude/Gemini not found** → the tool was never used on this machine, or it
  stores data elsewhere; set `TOKEN_STATS_CLAUDE_DIR` / `TOKEN_STATS_GEMINI_DIR`.
- **bench finds no server** → local server not running; start Ollama/LM Studio
  or point `TOKEN_STATS_OLLAMA_URL` etc. at the right port.
