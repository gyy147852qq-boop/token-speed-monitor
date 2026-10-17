#!/usr/bin/env node
/**
 * app/server.mjs — Token Speed Monitor dashboard.
 *
 * A zero-dependency local web app around scripts/token-stats.mjs:
 *   GET  /                 dashboard (public/index.html)
 *   GET  /api/health       liveness probe
 *   GET  /api/list         detected sources (token-stats list --json)
 *   GET  /api/summary      token totals (token-stats summary --json)
 *   GET  /api/speed        speed stats (token-stats speed --json)
 *   GET  /api/bench        live local-LLM benchmark (token-stats bench --json)
 *   GET  /api/watch        Server-Sent Events stream of new generations
 *
 * Binds 127.0.0.1 only. Set TOKEN_STATS_PORT to change the port (default 7391)
 * and TOKEN_STATS_NO_OPEN=1 to skip opening the browser.
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

// `here` must also work when this module is bundled into a single-file executable
// (import.meta.url is not available in CommonJS output).
const here = (() => {
  const url = typeof import.meta.url === "string" ? import.meta.url : "";
  return url ? dirname(fileURLToPath(url)) : dirname(process.execPath);
})();
const CLI = join(here, "..", "scripts", "token-stats.mjs");
const PORT = Number(process.env.TOKEN_STATS_PORT || 7391);
const HOST = "127.0.0.1";
const URL_BASE = `http://${HOST}:${PORT}/`;

// The single-file build (Token Speed Monitor.exe) extracts its UI assets to a
// writable folder and points us at it; in a git checkout we read from disk.
const PUBLIC = process.env.TOKEN_STATS_PUBLIC_DIR || join(here, "public");
// "exe"  -> this process is the packaged app: ask ourselves via `--cli`
// "script" -> plain node checkout: run scripts/token-stats.mjs directly
const SPAWN_MODE = process.env.TOKEN_STATS_CLI_SPAWN === "exe" ? "exe" : "script";
// "app" -> standalone application window (no browser tabs/address bar)
const OPEN_MODE = process.env.TOKEN_STATS_OPEN_MODE === "app" ? "app" : "browser";
// Exit when the dashboard window has been closed for a while (single-file build)
const EXIT_WHEN_CLOSED = process.env.TOKEN_STATS_EXIT_WHEN_CLOSED === "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/**
 * In the single-file build the dashboard files are inlined into the JavaScript
 * bundle (app/embedded-ui.generated.mjs, written by scripts/build-sea.ps1), so
 * the exe needs no side files. In a source checkout this import simply fails and
 * the files are read from app/public instead.
 */
let embeddedPromise = null;
function embeddedAssets() {
  if (!embeddedPromise) {
    embeddedPromise = import("./embedded-ui.generated.mjs")
      .then((m) => m.default || {})
      .catch(() => ({}));
  }
  return embeddedPromise;
}

/* ------------------------------- CLI bridge ------------------------------ */

const cache = new Map();

// In the packaged single-file build we re-enter ourselves with `--cli` instead of
// spawning a separate script file.
function cliInvocation(args) {
  return SPAWN_MODE === "exe"
    ? { cmd: process.execPath, args: ["--cli", ...args] }
    : { cmd: process.execPath, args: [CLI, ...args] };
}

function runCli(args, { timeoutMs = 60000, cacheMs = 4000 } = {}) {
  const key = args.join(" ");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < cacheMs) return Promise.resolve(hit.data);
  const { cmd, args: full } = cliInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("timeout"));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `token-stats exited with ${code}`));
      try {
        const data = JSON.parse(out);
        cache.set(key, { ts: Date.now(), data });
        resolve(data);
      } catch {
        reject(new Error("unexpected output: " + out.slice(0, 200)));
      }
    });
  });
}

async function runCliText(args, { timeoutMs = 60000 } = {}) {
  const { cmd, args: full } = cliInvocation(args);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, full, { windowsHide: true });
    let out = "";
    let err = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(err.trim() || `token-stats exited with ${code}`));
      resolve(out);
    });
  });
}

const sinceArgs = (url) => {
  const raw = url.searchParams.get("since") || "";
  // only pass through values the CLI understands: 24h / 7d / 2026-01-01 ...
  if (!/^[0-9A-Za-z:.+\-]{1,32}$/.test(raw)) return [];
  return ["--since", raw];
};

/* ----------------------------- live watch stream ------------------------- */

let watchChild = null;

function stopWatch() {
  if (watchChild) {
    try { watchChild.kill(); } catch { /* already gone */ }
    watchChild = null;
  }
}

function startWatch(req, res) {
  stopWatch();
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* client gone */ }
  };
  send({ event: "hello" });

  const { cmd, args } = cliInvocation(["watch", "--json", "--interval", String(process.env.TOKEN_STATS_WATCH_INTERVAL || 2)]);
  watchChild = spawn(cmd, args, { windowsHide: true });
  let buf = "";
  watchChild.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { send(JSON.parse(line)); } catch { /* ignore malformed line */ }
    }
  });
  watchChild.stderr.on("data", (d) => send({ event: "stderr", message: String(d).slice(0, 300) }));

  const keepAlive = setInterval(() => {
    try { res.write(": keepalive\n\n"); } catch { /* ignore */ }
  }, 15000);
  const cleanup = () => {
    clearInterval(keepAlive);
    stopWatch();
  };
  req.on("close", cleanup);
  res.on("close", cleanup);
}

/* --------------------------------- http ---------------------------------- */

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  res.end(body);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : decodeURIComponent(urlPath).replace(/^\/+/, "");
  const target = normalize(join(PUBLIC, rel));
  if (!target.startsWith(PUBLIC)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return;
  }
  try {
    const buf = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] || "application/octet-stream",
      "content-length": buf.length,
      "cache-control": "no-store",
    });
    res.end(buf);
    return;
  } catch {
    // Fall back to the copy inlined into a single-file build.
    const embedded = await embeddedAssets();
    const text = embedded[rel.split("\\").join("/")];
    if (typeof text === "string") {
      const body = Buffer.from(text, "utf8");
      res.writeHead(200, {
        "content-type": MIME[extname(rel)] || "text/plain; charset=utf-8",
        "content-length": body.length,
        "cache-control": "no-store",
      });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

let lastPing = Date.now();
let lastRequestAt = Date.now();

const server = http.createServer(async (req, res) => {
  lastRequestAt = Date.now();
  const url = new URL(req.url, URL_BASE);
  try {
    switch (url.pathname) {
      case "/api/health":
        return json(res, { ok: true, uptime: process.uptime() });
      case "/api/ping":
        // The dashboard pings while its window is open. In the single-file build the
        // process shuts itself down once the window has been closed for a while.
        lastPing = Date.now();
        return json(res, { ok: true, t: lastPing });
      case "/api/list":
        return json(res, await runCli(["list", "--json"], { cacheMs: 15000 }));
      case "/api/summary":
        return json(res, await runCli(["summary", "--json", ...sinceArgs(url)]));
      case "/api/speed":
        return json(res, await runCli(["speed", "--json", ...sinceArgs(url)]));
      case "/api/recent": {
        // Recent finished generations, so the live panel has content before the
        // SSE stream delivers anything (and works even with ?nolive=1).
        const n = Math.min(50, Math.max(1, parseInt(url.searchParams.get("n") || "12", 10) || 12));
        const text = await runCliText(["watch", "--json", "--history", String(n), "--interval", "1", "--cycles", "1"], { timeoutMs: 30000 });
        const items = [];
        for (const line of text.split("\n")) {
          const s = line.trim();
          if (!s) continue;
          try {
            const m = JSON.parse(s);
            if (m.event === "history" && Array.isArray(m.items)) items.push(...m.items);
          } catch { /* ignore */ }
        }
        items.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        return json(res, { items });
      }
      case "/api/bench": {
        const target = (url.searchParams.get("target") || "auto").slice(0, 20);
        const model = (url.searchParams.get("model") || "").trim().slice(0, 80);
        const args = ["bench", target, "--json"];
        if (model) args.push("--model", model);
        const data = await runCli(args, { timeoutMs: 300000, cacheMs: 0 });
        return json(res, data);
      }
      case "/api/watch":
        return startWatch(req, res);
      default:
        return serveStatic(res, url.pathname);
    }
  } catch (e) {
    return json(res, { error: String(e?.message || e) }, 500);
  }
});

function openDefaultBrowser(url) {
  const cmd =
    platform() === "win32" ? `start "" "${url}"`
    : platform() === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  try {
    spawn(cmd, { detached: true, stdio: "ignore", shell: true }).unref();
  } catch { /* headless environment */ }
}

function openBrowser(url) {
  if (process.env.TOKEN_STATS_NO_OPEN) return;

  // Packaged build: a standalone application window (no tabs, no address bar).
  if (OPEN_MODE === "app") {
    const candidates = [
      join(process.env["ProgramFiles(x86)"] || "x", "Microsoft", "Edge", "Application", "msedge.exe"),
      join(process.env.ProgramFiles || "x", "Microsoft", "Edge", "Application", "msedge.exe"),
      join(process.env.ProgramFiles || "x", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env["ProgramFiles(x86)"] || "x", "Google", "Chrome", "Application", "chrome.exe"),
      join(process.env.LOCALAPPDATA || "x", "Google", "Chrome", "Application", "chrome.exe"),
    ];
    const startedAt = lastRequestAt;
    for (const b of candidates) {
      if (existsSync(b)) {
        try {
          spawn(b, [`--app=${url}`], { detached: true, stdio: "ignore" }).unref();
          // Some browsers occasionally ignore --app (or leave the window blank).
          // If nothing even requests the page shortly after, fall back to a tab.
          setTimeout(() => {
            if (lastRequestAt <= startedAt) openDefaultBrowser(url);
          }, 6000).unref();
          return;
        } catch { /* fall through to the default browser */ }
      }
    }
  }

  openDefaultBrowser(url);
}

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.log(`Dashboard already running (or port ${PORT} busy). Opening ${URL_BASE}`);
    openBrowser(URL_BASE);
    return;
  }
  console.error("server error:", e.message);
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`Token Speed Monitor dashboard  ->  ${URL_BASE}`);
  console.log("Local only. Press Ctrl+C to stop.");
  openBrowser(URL_BASE);

  // Single-file build: no console to press Ctrl+C in, so shut down automatically
  // once the dashboard window has been gone for a while.
  if (EXIT_WHEN_CLOSED) {
    setInterval(() => {
      if (Date.now() - lastPing < 25000) return;
      console.log("Dashboard window closed - shutting down.");
      stopWatch();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 800).unref();
    }, 5000).unref();
  }
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopWatch();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
