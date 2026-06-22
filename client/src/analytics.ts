/**
 * Lightweight, privacy-friendly usage analytics.
 *
 * Fires three things at the server (which forwards to Supabase):
 *  - `page_open` once per load  → "visitors today"
 *  - a presence `ping` every 20s → "players online now" (counts SP *and* MP)
 *  - `game_start` / `game_finish` → "games played"
 *
 * The only identifier is a random `anonId` kept in localStorage — no personal
 * data. Everything is best-effort: a failed request is swallowed so analytics
 * can never disrupt the game. In dev (client on Vite, no Express) the requests
 * simply 404/blocked and are ignored.
 */

const PING_MS = 20_000;

function anonId(): string {
  try {
    let id = localStorage.getItem("sf_anon");
    if (!id) {
      id = (crypto.randomUUID?.() ?? `a${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`).slice(0, 64);
      localStorage.setItem("sf_anon", id);
    }
    return id;
  } catch {
    // Private mode / storage blocked: fall back to a per-session id.
    return "anon";
  }
}

function post(path: string, body: Record<string, unknown>): void {
  try {
    void fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive: true, // still sent if the tab is closing
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

let started = false;
let timer = 0;

/** Begin tracking: log the visit and start the presence heartbeat. Idempotent. */
export function startAnalytics(): void {
  if (started) return;
  started = true;
  const id = anonId();
  post("/api/event", { type: "page_open", anonId: id, meta: { ref: document.referrer || null } });
  const ping = (): void => post("/api/ping", { anonId: id });
  ping();
  timer = window.setInterval(ping, PING_MS);
  // Re-ping the moment a backgrounded tab returns, so it reappears as online.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") ping();
  });
}

/** A game began (single-player or multiplayer). MP starts are counted server-side
 *  to avoid double counting, so callers should only report single-player here. */
export function trackGameStart(meta: Record<string, unknown>): void {
  post("/api/event", { type: "game_start", anonId: anonId(), meta });
}

/** A game reached its end screen. */
export function trackGameFinish(meta: Record<string, unknown>): void {
  post("/api/event", { type: "game_finish", anonId: anonId(), meta });
}

// Keep the type checker honest about the unused timer in some builds.
export function stopAnalytics(): void {
  if (timer) window.clearInterval(timer);
  timer = 0;
  started = false;
}
