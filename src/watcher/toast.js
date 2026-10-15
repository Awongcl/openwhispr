// Watcher fork (spec O9): tiny status toast. Never focusable and shown inactive,
// because taking focus would move the paste target and trip the swap guard.

const { BrowserWindow, screen } = require("electron");

const MESSAGES = {
  rewriting: "Rewriting…",
  rewritten: "Rewritten",
  reverted: "Reverted",
  discarded: "Discarded",
  rewrite_failed: "Rewrite failed",
  nothing: "Nothing to swap",
  busy: "Busy…",
  unavailable: "Swap helper unavailable",
  refused: "Swap refused",
  battery_low: "Watcher battery low",
  battery_critical: "Watcher battery critical",
};

const REASONS = {
  focus_changed: "window changed",
  user_input: "you typed or clicked",
  expired: "too old",
  unknown_target: "unknown window",
  modifiers: "keys still held",
  focus: "window changed",
  paste_failed: "paste failed",
  error: "error",
  send: "key send failed",
};

const STICKY = new Set(["rewriting", "busy"]);
const WIDTH = 260;
const HEIGHT = 44;

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;overflow:hidden;font:13px/1.2 "Segoe UI",system-ui,sans-serif}
#t{position:absolute;inset:4px;display:flex;align-items:center;justify-content:center;border-radius:10px;
background:rgba(24,24,27,.92);color:#fafafa;padding:0 12px;text-align:center;opacity:0;transition:opacity .15s}
#t.on{opacity:1}#t.err{background:rgba(153,27,27,.94)}
</style></head><body><div id="t"></div><script>
window.show=(m,e)=>{const t=document.getElementById("t");t.textContent=m;t.className="on"+(e?" err":"")};
</script></body></html>`;

function formatToast(kind, detail) {
  const base = MESSAGES[kind] || kind;
  const reason = detail?.reason && REASONS[detail.reason];
  return reason ? `${base}: ${reason}` : base;
}

function createToast({ durationMs = 1600 } = {}) {
  let win = null;
  let ready = null;
  let hideTimer = null;

  function ensureWindow() {
    if (win && !win.isDestroyed()) return ready;
    win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      show: false,
      hasShadow: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    ready = win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
    return ready;
  }

  function position() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    win.setBounds({
      x: Math.round(x + (width - WIDTH) / 2),
      y: Math.round(y + height - HEIGHT - 48),
      width: WIDTH,
      height: HEIGHT,
    });
  }

  async function show(kind, detail) {
    try {
      await ensureWindow();
      const isError =
        kind === "refused" ||
        kind === "rewrite_failed" ||
        kind === "unavailable" ||
        kind === "battery_critical";
      const message = formatToast(kind, detail);
      await win.webContents.executeJavaScript(`show(${JSON.stringify(message)}, ${isError})`);
      position();
      if (!win.isVisible()) win.showInactive();
      clearTimeout(hideTimer);
      if (!STICKY.has(kind)) {
        hideTimer = setTimeout(() => win && !win.isDestroyed() && win.hide(), durationMs);
      }
    } catch {
      // A toast must never break a swap.
    }
  }

  function destroy() {
    clearTimeout(hideTimer);
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
  }

  return { show, destroy };
}

module.exports = { createToast, formatToast };
