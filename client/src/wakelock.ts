// Always-on display: hold a Screen Wake Lock so the device never dims/sleeps
// while a game is on screen (Android, iOS 16.4+, and desktop Chromium/Firefox).
// The lock is auto-released by the browser when the tab is hidden, so we
// re-acquire it whenever the page becomes visible again. Unsupported browsers
// silently no-op.

// WakeLockSentinel isn't in every TS lib target — keep it loosely typed.
let sentinel: { release?: () => Promise<void>; addEventListener?: (e: string, cb: () => void) => void } | null = null;
let active = false;
let onVisibility: (() => void) | null = null;

async function acquire(): Promise<void> {
  if (!active || sentinel) return;
  const wl = (navigator as unknown as { wakeLock?: { request: (t: string) => Promise<typeof sentinel> } }).wakeLock;
  if (!wl) return;
  try {
    sentinel = await wl.request("screen");
    // If the OS drops it (tab hidden, power saver), forget it so we re-acquire.
    sentinel?.addEventListener?.("release", () => { sentinel = null; });
  } catch {
    // Not allowed right now (e.g. no user gesture yet) — try again on next visibility.
    sentinel = null;
  }
}

/** Start keeping the screen awake (call when a game begins). Idempotent. */
export function enableWakeLock(): void {
  if (active) return;
  active = true;
  void acquire();
  onVisibility = (): void => { if (document.visibilityState === "visible") void acquire(); };
  document.addEventListener("visibilitychange", onVisibility);
}

/** Release the screen wake lock (call when leaving the game). Idempotent. */
export function disableWakeLock(): void {
  if (!active) return;
  active = false;
  if (onVisibility) { document.removeEventListener("visibilitychange", onVisibility); onVisibility = null; }
  void sentinel?.release?.().catch(() => { /* already gone */ });
  sentinel = null;
}
