// Watcher fork (spec O5): decides whether the last insertion may be deleted
// with Backspace x N. All three must hold: same foreground window, no real user
// input since our last paste, insertion younger than maxAgeMs.

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

// HWNDs arrive as %p hex from different compilers ("0000A1", "0xa1").
function sameHwnd(a, b) {
  try {
    const parse = (v) => BigInt(`0x${String(v).trim().replace(/^0x/i, "")}`);
    return parse(a) === parse(b);
  } catch {
    return false;
  }
}

function checkSwap({ entry, foregroundId, lastUserInputAt, now, maxAgeMs = DEFAULT_MAX_AGE_MS }) {
  if (!entry) return { ok: false, reason: "nothing" };
  if (!entry.target?.id || !foregroundId) return { ok: false, reason: "unknown_target" };
  if (!sameHwnd(foregroundId, entry.target.id)) {
    return { ok: false, reason: "focus_changed" };
  }
  const lastOwnAction = Math.max(entry.insertedAt, entry.swappedAt || 0);
  if (lastUserInputAt != null && lastUserInputAt > lastOwnAction) {
    return { ok: false, reason: "user_input" };
  }
  if (now - entry.insertedAt > maxAgeMs) return { ok: false, reason: "expired" };
  return { ok: true };
}

module.exports = { checkSwap, sameHwnd, DEFAULT_MAX_AGE_MS };
