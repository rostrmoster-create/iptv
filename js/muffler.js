// ── Console muffler ───────────────────────────────────────────────────────
// The CORS-proxy spam fills DevTools with hundreds of failed-fetch lines
// every few seconds. This silences console.* output AND wipes the console
// every second so it stays clean.
//
// Drop this <script> first in <head> if you want it to mute boot logs too.
(() => {
  const noop = () => {};
  // Keep a way to opt out: window.__unmute() restores normal logging.
  const original = {
    log:   console.log,
    info:  console.info,
    warn:  console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
    clear: console.clear,
  };
  console.log = noop;
  console.info = noop;
  console.warn = noop;
  console.error = noop;
  console.debug = noop;
  console.trace = noop;

  // Wipe whatever the browser logs natively (failed fetches, CSP warnings,
  // etc.). console.clear() doesn't always work if the user has "Preserve
  // log" enabled — nothing we can do about that.
  setInterval(() => {
    try { original.clear.call(console); } catch (_) {}
  }, 1000);

  window.__unmute = () => {
    Object.assign(console, original);
    console.log('[muffler] console restored');
  };
})();
