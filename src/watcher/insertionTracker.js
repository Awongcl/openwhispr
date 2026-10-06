// Watcher fork (spec O2): remembers the last dictation insertion so it can be
// swapped (rewrite/revert) or discarded with Backspace x N.

// One Backspace removes one code point in common editors; CRLF collapses to a
// single line break. Grapheme clusters (ZWJ emoji) are a known gap (R18).
function deleteCount(text) {
  return Array.from(String(text).replace(/\r\n/g, "\n")).length;
}

// Re-applies the whitespace OpenWhispr's smart spacing put around the RAW
// paste, so a swap leaves the surrounding text untouched.
function withAffixes(template, body) {
  const lead = template.match(/^\s*/)[0];
  const trail = template.slice(lead.length).match(/\s*$/)[0];
  return lead + body.trim() + trail;
}

function createInsertionTracker({ now = () => Date.now() } = {}) {
  let state = null;

  return {
    // pasted: exact text sent to the clipboard (after smart spacing).
    record({ pasted, target }) {
      state = {
        raw: pasted,
        rewrite: null,
        current: "raw",
        target: target || null,
        insertedAt: now(),
        swappedAt: null,
      };
      return this.get();
    },

    get() {
      if (!state) return null;
      const text = state.current === "raw" ? state.raw : state.rewrite;
      return { ...state, text, n: deleteCount(text) };
    },

    setRewrite(body) {
      if (!state) throw new Error("no insertion");
      state.rewrite = withAffixes(state.raw, body);
    },

    // Called after a successful swap paste; marks the new on-screen version.
    switchTo(version) {
      if (!state) throw new Error("no insertion");
      if (version === "rewrite" && state.rewrite == null) throw new Error("no rewrite cached");
      state.current = version;
      state.swappedAt = now();
      return this.get();
    },

    clear() {
      state = null;
    },
  };
}

module.exports = { createInsertionTracker, deleteCount, withAffixes };
