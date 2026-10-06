#!/usr/bin/env node
// Watcher fork: compiles resources/watcher-input.c (Backspace x N + input
// tracking). Local compile only; there is no prebuilt download. Set CC to a
// compiler path if clang/gcc/cl are not on PATH.

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

if (process.platform !== "win32") process.exit(0);

const projectRoot = path.resolve(__dirname, "..");
const source = path.join(projectRoot, "resources", "watcher-input.c");
const outputDir = path.join(projectRoot, "resources", "bin");
const output = path.join(outputDir, "watcher-input.exe");

const log = (msg) => console.log(`[watcher-input] ${msg}`);

function upToDate() {
  try {
    return fs.statSync(output).mtimeMs >= fs.statSync(source).mtimeMs;
  } catch {
    return false;
  }
}

function compile() {
  const gnuArgs = ["-O2", source, "-o", output, "-luser32"];
  const candidates = [
    ...(process.env.CC ? [{ cmd: process.env.CC, args: gnuArgs }] : []),
    { cmd: "clang", args: gnuArgs },
    { cmd: "gcc", args: gnuArgs },
    { cmd: "cl", args: ["/O2", "/nologo", source, `/Fe:${output}`, "user32.lib"] },
  ];
  for (const { cmd, args } of candidates) {
    const result = spawnSync(cmd, args, { stdio: "inherit", cwd: projectRoot });
    if (!result.error && result.status === 0 && fs.existsSync(output)) {
      log(`Built with ${cmd}`);
      return true;
    }
  }
  return false;
}

fs.mkdirSync(outputDir, { recursive: true });
if (upToDate()) {
  log("Binary is up to date, skipping build");
} else if (!compile()) {
  console.warn("[watcher-input] No C compiler found (clang/gcc/cl or CC).");
  console.warn("[watcher-input] Rewrite/revert/discard will be unavailable.");
}
