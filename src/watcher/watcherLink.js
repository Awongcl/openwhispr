// Watcher fork (spec O14): BLE central for the Watcher GATT link. Wraps
// resources/bin/watcher-ble.exe (WinRT; Windows keeps the link to each paired
// Watcher and reconnects by itself), restarts it on crash and after PC sleep,
// syncs time on every connect (O12) and turns notifications into events.

const { spawn } = require("child_process");
const { EventEmitter } = require("events");
const fs = require("fs");
const path = require("path");

const { encodeTime, isSeqGap, parseAudio, parseEvent, parseHelperLine } = require("./linkProtocol");

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];
const STABLE_MS = 60000; // a helper alive this long resets the backoff

function resolveBinary() {
  const name = "watcher-ble.exe";
  const candidates = [path.join(__dirname, "..", "..", "resources", "bin", name)];
  if (process.resourcesPath) {
    candidates.push(
      path.join(process.resourcesPath, "bin", name),
      path.join(process.resourcesPath, "app.asar.unpacked", "resources", "bin", name)
    );
  }
  return candidates.find((p) => fs.existsSync(p)) || null;
}

class WatcherLink extends EventEmitter {
  constructor({
    logger = null,
    binary = resolveBinary(),
    spawnImpl = spawn,
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {}) {
    super();
    this.logger = logger;
    this.binary = binary;
    this.spawnImpl = spawnImpl;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.proc = null;
    this.wanted = false;
    this.failures = 0;
    this.retryTimer = null;
    this.devices = new Map(); // address -> device
  }

  isAvailable() {
    return process.platform === "win32" && !!this.binary;
  }

  start() {
    this.wanted = true;
    if (this.isAvailable()) this._spawn();
  }

  stop() {
    this.wanted = false;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    this._kill();
    this._resetDevices();
  }

  // After PC sleep the WinRT session can be stale: start from scratch.
  restart() {
    if (!this.wanted) return;
    this.logger?.info?.("Watcher link restart", {}, "watcher");
    this._kill();
    this._resetDevices();
    this.failures = 0;
    this.clearTimer(this.retryTimer);
    this.retryTimer = null;
    if (this.isAvailable()) this._spawn();
  }

  // Writes a Control message to one Watcher (address) or all connected ("*").
  write(address, buffer) {
    if (!this.proc) return false;
    try {
      this.proc.stdin.write(`W ${address} ${Buffer.from(buffer).toString("hex")}\n`);
      return true;
    } catch {
      return false;
    }
  }

  connectedCount() {
    let n = 0;
    for (const d of this.devices.values()) if (d.connected) n++;
    return n;
  }

  status() {
    return {
      available: this.isAvailable(),
      running: !!this.proc,
      devices: [...this.devices.values()].map(({ lastSeq: _seq, ...d }) => d),
    };
  }

  _spawn() {
    if (this.proc) return;
    let proc;
    try {
      proc = this.spawnImpl(this.binary, [], { windowsHide: true, stdio: "pipe" });
    } catch (error) {
      this.logger?.warn?.("watcher-ble spawn failed", { error: error.message }, "watcher");
      this._scheduleRetry();
      return;
    }
    this.proc = proc;
    const startedAt = Date.now();
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        this._handle(parseHelperLine(line));
      }
    });
    proc.stderr?.on?.("data", () => {});
    proc.on("error", (error) => {
      this.logger?.warn?.("watcher-ble error", { error: error.message }, "watcher");
    });
    proc.on("exit", (code) => {
      if (this.proc !== proc) return; // killed on purpose
      this.proc = null;
      this._resetDevices();
      this.logger?.warn?.("watcher-ble exited", { code }, "watcher");
      if (Date.now() - startedAt > STABLE_MS) this.failures = 0;
      this._scheduleRetry();
    });
  }

  _scheduleRetry() {
    if (!this.wanted || this.retryTimer) return;
    const delay = BACKOFF_MS[Math.min(this.failures, BACKOFF_MS.length - 1)];
    this.failures++;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = null;
      if (this.wanted) this._spawn();
    }, delay);
  }

  _kill() {
    const proc = this.proc;
    this.proc = null;
    if (!proc) return;
    try {
      proc.stdin.end("QUIT\n");
    } catch {}
    // WinRT teardown is quick; make sure a wedged helper does not linger.
    const timer = this.setTimer(() => {
      try {
        proc.kill();
      } catch {}
    }, 3000);
    proc.once?.("exit", () => this.clearTimer(timer));
  }

  _resetDevices() {
    const had = this.devices.size > 0;
    for (const d of this.devices.values()) {
      if (d.connected) this.emit("disconnected", { ...d });
    }
    this.devices.clear();
    if (had) this.emit("change", this.status());
  }

  _device(address) {
    let d = this.devices.get(address);
    if (!d) {
      d = {
        address,
        name: null,
        connected: false,
        mtu: null,
        firmware: null,
        battery: null,
        lastSeq: null,
      };
      this.devices.set(address, d);
    }
    return d;
  }

  _handle(msg) {
    if (!msg) return;
    switch (msg.type) {
      case "ready":
        this.logger?.info?.("watcher-ble ready", {}, "watcher");
        return;
      case "paired": {
        const d = this._device(msg.address);
        d.name = msg.name;
        this.emit("change", this.status());
        return;
      }
      case "unpaired":
        this.devices.delete(msg.address);
        this.emit("change", this.status());
        return;
      case "connected": {
        const d = this._device(msg.address);
        d.connected = true;
        d.mtu = msg.mtu;
        d.lastSeq = null;
        if (msg.info) {
          d.firmware = msg.info.firmware;
          d.battery = msg.info.battery;
        }
        this.logger?.info?.(
          "Watcher connected",
          { address: d.address, mtu: d.mtu, fw: d.firmware },
          "watcher"
        );
        this.write(d.address, encodeTime(this.now())); // O12: every connect
        this.emit("connected", { ...d });
        this.emit("change", this.status());
        return;
      }
      case "disconnected": {
        const d = this.devices.get(msg.address);
        if (!d || !d.connected) return;
        d.connected = false;
        this.logger?.info?.("Watcher disconnected", { address: d.address }, "watcher");
        this.emit("disconnected", { ...d });
        this.emit("change", this.status());
        return;
      }
      case "event": {
        const d = this._device(msg.address);
        const event = parseEvent(msg.data);
        if (!event) {
          this.logger?.warn?.(
            "Watcher event malformed",
            { hex: msg.data.toString("hex") },
            "watcher"
          );
          return;
        }
        const gap = isSeqGap(d.lastSeq, event.seq);
        d.lastSeq = event.seq;
        if (gap) this.logger?.warn?.("Watcher event seq gap", { seq: event.seq }, "watcher");
        if (event.battery) {
          d.battery = event.battery;
          this.emit("change", this.status());
        }
        this.emit("event", event, { ...d });
        return;
      }
      case "audio": {
        const packet = parseAudio(msg.data);
        if (packet) this.emit("audio", packet, msg.address);
        return;
      }
      case "write_error":
        this.logger?.debug?.("Watcher write failed", msg, "watcher");
        return;
      case "log":
        this.logger?.info?.("watcher-ble", { message: msg.message }, "watcher");
        return;
    }
  }
}

module.exports = { WatcherLink, resolveBinary };
