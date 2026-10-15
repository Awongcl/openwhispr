// Watcher fork: wrapper around resources/bin/watcher-input.exe (Windows only).
// One request in flight at a time; replies are single lines.

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const REQUEST_TIMEOUT_MS = 4000;

function resolveBinary() {
  const name = "watcher-input.exe";
  const candidates = [path.join(__dirname, "..", "..", "resources", "bin", name)];
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "bin", name),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", name)
    );
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// VK codes the helper must not count as user input (the Watcher's own hotkeys).
const MODIFIER_VK = { control: 0x11, ctrl: 0x11, commandorcontrol: 0x11, alt: 0x12, shift: 0x10 };
function hotkeyToVks(hotkey) {
  const vks = [];
  for (const part of String(hotkey || "").split("+")) {
    const key = part.trim().toLowerCase();
    if (MODIFIER_VK[key]) vks.push(MODIFIER_VK[key]);
    else if (/^f([1-9]|1\d|2[0-4])$/.test(key)) vks.push(0x6f + Number(key.slice(1)));
    else if (/^[a-z0-9]$/.test(key)) vks.push(key.toUpperCase().charCodeAt(0));
  }
  return vks;
}

class WatcherInput {
  constructor({ logger = null, binary = resolveBinary(), spawnImpl = spawn } = {}) {
    this.logger = logger;
    this.binary = binary;
    this.spawnImpl = spawnImpl;
    this.proc = null;
    this.ignoreVks = [];
    this.queue = Promise.resolve();
    this.pending = null;
    this.buffer = "";
  }

  isAvailable() {
    return process.platform === "win32" && !!this.binary;
  }

  setIgnoredHotkeys(hotkeys) {
    const vks = [...new Set(hotkeys.flatMap(hotkeyToVks))].sort((a, b) => a - b);
    if (vks.join() === this.ignoreVks.join()) return;
    this.ignoreVks = vks;
    this.stop(); // respawn with the new ignore list on next request
  }

  _ensureStarted() {
    if (this.proc) return;
    const args = this.ignoreVks.length
      ? ["--ignore", this.ignoreVks.map((v) => `0x${v.toString(16)}`).join(",")]
      : [];
    const proc = this.spawnImpl(this.binary, args, { windowsHide: true, stdio: "pipe" });
    this.proc = proc;
    this.startedAt = Date.now();
    this.buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let idx;
      while ((idx = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (line === "READY") continue;
        const pending = this.pending;
        this.pending = null;
        pending?.resolve(line);
      }
    });
    proc.on("exit", (code) => {
      if (this.proc === proc) this.proc = null;
      this.pending?.reject(new Error(`watcher-input exited (${code})`));
      this.pending = null;
      this.logger?.debug?.("watcher-input exited", { code }, "watcher");
    });
    proc.on("error", (error) => {
      this.logger?.warn?.("watcher-input error", { error: error.message }, "watcher");
    });
  }

  _request(command) {
    const run = () =>
      new Promise((resolve, reject) => {
        if (!this.isAvailable()) {
          reject(new Error("watcher-input unavailable"));
          return;
        }
        this._ensureStarted();
        const timer = setTimeout(() => {
          this.pending = null;
          reject(new Error(`watcher-input timeout: ${command.split(" ")[0]}`));
        }, REQUEST_TIMEOUT_MS);
        this.pending = {
          resolve: (line) => {
            clearTimeout(timer);
            resolve(line);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          },
        };
        this.proc.stdin.write(`${command}\n`);
      });
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }

  // Starts the hook early so input before the first swap is observed.
  warmUp() {
    if (this.isAvailable()) this._ensureStarted();
  }

  // Wall-clock ms of the last real (non-injected, non-hotkey) input. With no input
  // seen, the hook start time: anything inserted before a (re)start is unverifiable.
  async lastUserInputAt() {
    const line = await this._request("IDLE");
    const ms = Number(line.split(" ")[1]);
    return Number.isFinite(ms) && ms >= 0 ? Date.now() - ms : this.startedAt;
  }

  async foregroundId() {
    const line = await this._request("FG");
    return line.startsWith("FG ") ? line.slice(3) : null;
  }

  // Resolves "OK" or an error code ("focus", "modifiers", "send", "args").
  async backspace(n, hwnd) {
    if (n <= 0) return "OK";
    const id = String(hwnd).replace(/^0x/i, "");
    const line = await this._request(`BS ${n} ${id}`);
    return line === "OK" ? "OK" : line.replace(/^ERR\s*/, "");
  }

  // Watcher "send" (O14): Enter to the foreground window. "OK" or an error code.
  async enter() {
    const line = await this._request("ENTER");
    return line === "OK" ? "OK" : line.replace(/^ERR\s*/, "");
  }

  // Call from a swap hotkey while its keys are still down: keeps the Alt/Win
  // release from opening the target's menu bar (see SendMask in the helper).
  async mask() {
    const line = await this._request("MASK");
    return line === "OK" ? "OK" : line.replace(/^ERR\s*/, "");
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try {
        proc.stdin.end("QUIT\n");
      } catch {
        proc.kill();
      }
    }
  }
}

module.exports = { WatcherInput, hotkeyToVks, resolveBinary };
