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
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { platform } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "scripts", "token-stats.mjs");
const PUBLIC = join(here, "public");
const PORT = Number(process.env.TOKEN_STATS_PORT || 7391);
const HOST = "127.0.0.1";
const URL_BASE = `http://${HOST}:${PORT}/`;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ------------------------------- CLI bridge ------------------------------ */

const cache = new Map();

function runCli(args, { timeoutMs = 60000, cacheMs = 4000 } = {}) {
  const key = args.join(" ");
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < cacheMs) return Promise.resolve(hit.data);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { windowsHide: true });
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

  watchChild = spawn(
    process.execPath,
    [CLI, "watch", "--json", "--interval", String(process.env.TOKEN_STATS_WATCH_INTERVAL || 2)],
    { windowsHide: true }
  );
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
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, URL_BASE);
  try {
    switch (url.pathname) {
      case "/api/health":
        return json(res, { ok: true, uptime: process.uptime() });
      case "/api/list":
        return json(res, await runCli(["list", "--json"], { cacheMs: 15000 }));
      case "/api/summary":
        return json(res, await runCli(["summary", "--json", ...sinceArgs(url)]));
      case "/api/speed":
        return json(res, await runCli(["speed", "--json", ...sinceArgs(url)]));
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

function openBrowser(url) {
  if (process.env.TOKEN_STATS_NO_OPEN) return;
  const cmd =
    platform() === "win32" ? `start "" "${url}"`
    : platform() === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  try {
    spawn(cmd, { detached: true, stdio: "ignore", shell: true }).unref();
  } catch { /* headless environment */ }
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
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopWatch();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
