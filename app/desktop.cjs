/**
 * Token Speed Monitor - entry point of the packaged single-file app
 * (dist/Token Speed Monitor.exe). The Node.js runtime and the whole program are
 * bundled into that one file, so the target machine needs nothing installed and
 * the app never talks to the internet - only to localhost.
 *
 *   Token Speed Monitor.exe             launch: start the server (hidden) + app window
 *   Token Speed Monitor.exe --serve     run only the local server (internal)
 *   Token Speed Monitor.exe --cli ...   run the CLI (internal, the server asks for data)
 */
(async function main() {
  const mode = process.argv[2];

  if (mode === "--cli") {
    // The server asks this same executable for data; hand over to the CLI.
    await import("../scripts/token-stats.mjs");
    return;
  }

  if (mode !== "--serve") {
    // Start the worker without a console window, then exit so the launcher's
    // console disappears right away.
    const { spawn } = require("node:child_process");
    const child = spawn(process.execPath, ["--serve"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.unref();
    return;
  }

  /* ------------------------------ server mode ------------------------------ */

  process.env.TOKEN_STATS_CLI_SPAWN = "exe";
  if (process.env.TOKEN_STATS_OPEN_MODE === undefined) process.env.TOKEN_STATS_OPEN_MODE = "app";
  if (process.env.TOKEN_STATS_EXIT_WHEN_CLOSED === undefined) process.env.TOKEN_STATS_EXIT_WHEN_CLOSED = "1";

  // The dashboard files are inlined into this bundle at build time, so there is
  // nothing to unpack here. Serve them from app/public when running from a source
  // checkout (TOKEN_STATS_PUBLIC_DIR is respected when set).
  await import("./server.mjs");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
