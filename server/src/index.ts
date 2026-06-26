import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { Server as IOServer } from "socket.io";
import { randomUUID } from "node:crypto";
import { type ClientIntent, SOCKET_EVENT } from "@starfarers/shared";
import { Room, type RoomSnapshot } from "./room.js";
import { getLanAddress } from "./lan.js";
import { saveRoom, deleteRoom, loadAllRooms, persistenceEnabled, logEvent, analyticsSummary } from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
// Optional gate for the /stats dashboard: when set, the page + API require
// ?key=<token>. Leave unset to keep the aggregate numbers public.
const STATS_TOKEN = process.env.STATS_TOKEN ?? "";

// Socket.IO CORS allow-list. In production set ALLOWED_ORIGINS to your site(s)
// (comma-separated, e.g. "https://starfarers.space,https://www.starfarers.space")
// so other websites can't open sockets to the server. Unset → "*" for LAN/dev.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Self-contained live dashboard served at /stats. Reuses any ?key= from its own
// URL when polling the JSON endpoint, and refreshes every 5s.
const STATS_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Starfarers · Live Stats</title>
<style>
  :root{color-scheme:dark}
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
    color:#e7ecf6;background:radial-gradient(1200px 800px at 70% -10%,#16203b,#0a0e1a 60%) fixed;min-height:100vh}
  .wrap{max-width:880px;margin:0 auto;padding:32px 20px 60px}
  h1{font-size:22px;margin:0 0 2px;letter-spacing:.5px}
  .sub{color:#8aa;opacity:.7;font-size:13px;margin-bottom:24px}
  .grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
  .card{background:rgba(150,170,210,.07);border:1px solid rgba(150,170,210,.16);
    border-radius:16px;padding:20px 22px}
  .card.hero{grid-column:1/-1;background:linear-gradient(135deg,rgba(57,216,200,.16),rgba(91,140,255,.12));
    border-color:rgba(57,216,200,.3)}
  .label{font-size:13px;text-transform:uppercase;letter-spacing:1px;color:#9fb0cf;opacity:.85}
  .num{font-size:46px;font-weight:800;line-height:1.05;margin-top:6px;
    font-variant-numeric:tabular-nums}
  .hero .num{font-size:64px;background:linear-gradient(90deg,#39d8c8,#7fa8ff);
    -webkit-background-clip:text;background-clip:text;color:transparent}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:#39d8c8;
    margin-right:8px;box-shadow:0 0 0 0 rgba(57,216,200,.6);animation:p 2s infinite}
  @keyframes p{0%{box-shadow:0 0 0 0 rgba(57,216,200,.5)}70%{box-shadow:0 0 0 12px rgba(57,216,200,0)}100%{box-shadow:0 0 0 0 rgba(57,216,200,0)}}
  .foot{margin-top:22px;font-size:12px;color:#8aa;opacity:.6}
  .err{color:#ff8a8a}
</style></head><body><div class="wrap">
  <h1>🚀 Starfarers · Live Stats</h1>
  <div class="sub">Auto-refreshing every 5s · "today" resets at midnight Dubai time</div>
  <div class="grid">
    <div class="card hero"><div class="label"><span class="dot"></span>Players online now</div><div class="num" id="online_now">–</div></div>
    <div class="card"><div class="label">Visitors today</div><div class="num" id="visitors_today">–</div></div>
    <div class="card"><div class="label">Games started today</div><div class="num" id="games_today">–</div></div>
    <div class="card"><div class="label">Page views today</div><div class="num" id="views_today">–</div></div>
    <div class="card"><div class="label">Games finished today</div><div class="num" id="finishes_today">–</div></div>
    <div class="card"><div class="label">Visitors all-time</div><div class="num" id="visitors_total">–</div></div>
    <div class="card"><div class="label">Games all-time</div><div class="num" id="games_total">–</div></div>
  </div>
  <div class="foot" id="foot"></div>
</div><script>
  var key = new URLSearchParams(location.search).get('key');
  var url = '/api/stats' + (key ? '?key=' + encodeURIComponent(key) : '');
  function fmt(n){ return (typeof n==='number') ? n.toLocaleString() : '–'; }
  async function tick(){
    try{
      var r = await fetch(url, {cache:'no-store'});
      if(!r.ok) throw new Error('HTTP '+r.status);
      var d = await r.json();
      ['online_now','visitors_today','games_today','views_today','finishes_today','visitors_total','games_total']
        .forEach(function(k){ var e=document.getElementById(k); if(e) e.textContent = fmt(d[k]); });
      document.getElementById('foot').textContent = 'Updated ' + new Date().toLocaleTimeString();
    }catch(e){
      document.getElementById('foot').innerHTML = '<span class="err">Could not load stats: ' + e.message + '</span>';
    }
  }
  tick(); setInterval(tick, 5000);
</script></body></html>`;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS : "*" },
  // Be tolerant of mobile latency / a backgrounded tab pausing timers: wait
  // longer for a missed heartbeat before declaring a client gone, so a brief
  // network blip doesn't kick players mid-game (they also auto-rejoin).
  pingInterval: 25000,
  pingTimeout: 60000,
  // Every move broadcasts the full GameState JSON (tens of KB) to every player.
  // Compressing frames over ~1KB cuts that to a few KB — a big win on mobile
  // data and on the free-tier server's tiny bandwidth.
  perMessageDeflate: { threshold: 1024 },
});

// In production, serve the built client. In dev, Vite serves it on its own port.
// The bundle's location varies by build method, so probe a few candidate paths
// (relative to this file and to the working dir) and use the first that exists.
function resolveClientDist(): string | null {
  const candidates = [
    path.resolve(__dirname, "../../client/dist"), // esbuild bundle: server/dist/index.mjs
    path.resolve(__dirname, "../../../../client/dist"), // tsc output: server/dist/server/src/
    path.resolve(process.cwd(), "client/dist"), // started from the repo root
    path.resolve(process.cwd(), "../client/dist"), // started from the server workspace
  ];
  return candidates.find((p) => existsSync(path.join(p, "index.html"))) ?? null;
}
const clientDist = resolveClientDist();
app.get("/health", (_req, res) => res.json({ ok: true }));

// --- Analytics -------------------------------------------------------------
// "Who's online" is tracked in memory: every open client (single-player OR
// multiplayer) pings every ~20s with a persistent anon id. We count ids seen in
// the last 45s. Persisted counters (visitors / games per day) live in Supabase.
app.use(express.json({ limit: "8kb" }));
// Behind Render's proxy, the real client IP is in X-Forwarded-For; trust one hop
// so req.ip reflects the visitor (needed for per-IP rate limiting below).
app.set("trust proxy", 1);

// Simple in-memory per-IP rate limit for the public write endpoints, so a script
// can't flood the analytics table or inflate counts. Generous enough that real
// clients (one page-open + a ping every 20s) never hit it.
const RATE_LIMIT = 120; // requests per window
const RATE_WINDOW_MS = 60_000;
const rateHits = new Map<string, { n: number; t: number }>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const r = rateHits.get(ip);
  if (!r || now - r.t > RATE_WINDOW_MS) {
    rateHits.set(ip, { n: 1, t: now });
    return false;
  }
  r.n++;
  return r.n > RATE_LIMIT;
}

const ONLINE_WINDOW_MS = 45_000;
const lastSeen = new Map<string, number>(); // anonId -> ms
function touchOnline(anonId: unknown): void {
  if (typeof anonId === "string" && anonId.length > 0 && anonId.length <= 64) {
    lastSeen.set(anonId, Date.now());
  }
}
function onlineNow(): number {
  const cutoff = Date.now() - ONLINE_WINDOW_MS;
  let n = 0;
  for (const [id, t] of lastSeen) {
    if (t < cutoff) lastSeen.delete(id);
    else n++;
  }
  return n;
}

// Heartbeat: presence only, no DB write (cheap, fires every ~20s per client).
app.post("/api/ping", (req, res) => {
  if (rateLimited(req.ip ?? "")) { res.status(429).json({ ok: false }); return; }
  touchOnline(req.body?.anonId);
  res.json({ ok: true });
});

// A recorded event (page_open / game_start / game_finish). Also refreshes
// presence. Unknown types are ignored so the table can't be spammed arbitrarily.
const ALLOWED_EVENTS = new Set(["page_open", "game_start", "game_finish"]);
app.post("/api/event", (req, res) => {
  if (rateLimited(req.ip ?? "")) { res.status(429).json({ ok: false }); return; }
  const { type, anonId, meta } = (req.body ?? {}) as { type?: string; anonId?: string; meta?: unknown };
  touchOnline(anonId);
  if (typeof type === "string" && ALLOWED_EVENTS.has(type)) {
    void logEvent(type, typeof anonId === "string" ? anonId : undefined, meta);
  }
  res.json({ ok: true });
});

function statsAuthorized(req: express.Request): boolean {
  return STATS_TOKEN.length === 0 || req.query.key === STATS_TOKEN;
}

// Live dashboard numbers (JSON). Public unless STATS_TOKEN is set.
app.get("/api/stats", async (req, res) => {
  if (!statsAuthorized(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  const summary = await analyticsSummary();
  res.json({ online_now: onlineNow(), ...(summary ?? {}) });
});

// Human-readable live dashboard. Polls /api/stats every few seconds.
app.get("/stats", (req, res) => {
  if (!statsAuthorized(req)) { res.status(401).type("html").send("<h1>401 — add ?key=…</h1>"); return; }
  res.type("html").send(STATS_PAGE);
});

if (clientDist) {
  app.use(express.static(clientDist));
  // Public legal pages at clean URLs. Google OAuth verification and app stores
  // need real, directly-viewable links (not the in-app modal). The .html files
  // are also served statically; these aliases give tidy /privacy and /terms URLs.
  app.get("/privacy", (_req, res) => res.sendFile(path.join(clientDist, "privacy.html")));
  app.get("/terms", (_req, res) => res.sendFile(path.join(clientDist, "terms.html")));
  app.get("/about", (_req, res) => res.sendFile(path.join(clientDist, "about.html")));
  app.get("/how-to-play", (_req, res) => res.sendFile(path.join(clientDist, "how-to-play.html")));
  // SPA fallback: any non-API route serves index.html so deep links / reloads work.
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
} else {
  console.warn("client/dist not found — serving API only (run `npm run build` first).");
}

// --- Room registry ---
const rooms = new Map<string, Room>();
const socketToRoom = new Map<string, { roomCode: string; playerId: string }>();
// Sockets currently browsing the lobby (not yet in a room) — they get live
// updates to the public-room list.
const browsers = new Map<string, import("socket.io").Socket>();

/** Public, open, not-started rooms — the browsable list. */
function publicRoomList(): { code: string; host: string; players: number; max: number }[] {
  return [...rooms.values()].filter((r) => r.isJoinable).map((r) => r.summary());
}
function broadcastRoomList(): void {
  const list = publicRoomList();
  for (const s of browsers.values()) s.emit(SOCKET_EVENT.message, { t: "roomList", rooms: list });
}

function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = Array.from({ length: 4 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
  } while (rooms.has(code));
  return code;
}

// --- Durable persistence wiring ---
// Each room mirrors its state to Supabase so an in-progress game survives a
// server restart / free-tier spin-down. Saves are debounced per room (game
// intents fire fast) to coalesce bursts into one write.
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
function cancelSave(code: string): void {
  const t = saveTimers.get(code);
  if (t) { clearTimeout(t); saveTimers.delete(code); }
}
function wireRoom(room: Room): void {
  room.onPersist = () => {
    cancelSave(room.code);
    saveTimers.set(
      room.code,
      setTimeout(() => { saveTimers.delete(room.code); void saveRoom(room.code, room.snapshot()); }, 1500),
    );
  };
  room.onUnpersist = () => { cancelSave(room.code); void deleteRoom(room.code); };
  room.onReap = () => {
    cancelSave(room.code);
    rooms.delete(room.code);
    void deleteRoom(room.code);
    broadcastRoomList();
  };
}

/** On boot, reload any in-progress games that were persisted before a restart. */
async function restoreRooms(): Promise<void> {
  if (!persistenceEnabled) return;
  const snaps = await loadAllRooms();
  let restored = 0;
  for (const data of snaps) {
    try {
      const s = data as RoomSnapshot;
      // Only resurrect live games — skip junk, finished games, and lobbies.
      if (!s?.code || !s.started || !s.game || s.game.phaseState?.phase === "gameOver") {
        if (s?.code) void deleteRoom(s.code);
        continue;
      }
      const room = Room.fromSnapshot(s);
      wireRoom(room);
      room.armGraceForDisconnected(); // reclaim within the window, else auto-clean
      rooms.set(room.code, room);
      restored++;
    } catch (err) {
      console.warn("restore room failed", err);
    }
  }
  if (restored) console.log(`  Restored ${restored} in-progress game(s) from storage`);
}

io.on("connection", (socket) => {
  socket.on(SOCKET_EVENT.intent, (intent: ClientIntent) => {
    try {
      if (intent.t === "listRooms") {
        // Enter the lobby browser: get the current list and live updates.
        browsers.set(socket.id, socket);
        socket.emit(SOCKET_EVENT.message, { t: "roomList", rooms: publicRoomList() });
        return;
      }

      if (intent.t === "leaveBrowsing") {
        browsers.delete(socket.id);
        return;
      }

      if (intent.t === "createRoom") {
        const code = makeRoomCode();
        const room = new Room(code);
        room.isPublic = intent.public !== false; // public by default
        wireRoom(room);
        rooms.set(code, room);
        const playerId = randomUUID();
        room.addMember(playerId, intent.name, socket, intent.username);
        socketToRoom.set(socket.id, { roomCode: code, playerId });
        browsers.delete(socket.id); // now in a room, not browsing
        room.broadcastLobby();
        broadcastRoomList();
        return;
      }

      if (intent.t === "rejoin") {
        const room = rooms.get(intent.roomCode.toUpperCase());
        if (!room) {
          // The room is gone (server lost it and it wasn't persisted, or it
          // ended). Tell the client so it forgets the stale session.
          socket.emit(SOCKET_EVENT.message, { t: "error", message: "That game has ended." });
          return;
        }
        const status = room.reattach(intent.playerId, socket);
        if (status === "released") {
          socket.emit(SOCKET_EVENT.message, {
            t: "error",
            message: "You were away too long — an AI took over your fleet, so this game is no longer yours to rejoin.",
          });
          return;
        }
        if (status === "missing") {
          socket.emit(SOCKET_EVENT.message, { t: "error", message: "Could not rejoin." });
          return;
        }
        socketToRoom.set(socket.id, { roomCode: room.code, playerId: intent.playerId });
        browsers.delete(socket.id);
        // reattach() already re-broadcast lobby + state for the resync.
        return;
      }

      if (intent.t === "joinRoom") {
        const room = rooms.get(intent.roomCode.toUpperCase());
        if (!room) {
          socket.emit(SOCKET_EVENT.message, { t: "error", message: "Room not found." });
          return;
        }
        if (room.hasStarted) {
          socket.emit(SOCKET_EVENT.message, { t: "error", message: "That game has already started." });
          return;
        }
        const playerId = randomUUID();
        room.addMember(playerId, intent.name, socket, intent.username);
        socketToRoom.set(socket.id, { roomCode: room.code, playerId });
        browsers.delete(socket.id);
        room.broadcastLobby();
        broadcastRoomList(); // room may now be full → drops off the list
        return;
      }

      const ref = socketToRoom.get(socket.id);
      const room = ref && rooms.get(ref.roomCode);
      if (!ref || !room) {
        socket.emit(SOCKET_EVENT.message, { t: "error", message: "Not in a room." });
        return;
      }
      room.handleIntent(ref.playerId, intent);
      // Count a multiplayer game once, when it actually starts (one event per
      // game, host-side — clients never log MP starts, to avoid N-fold counts).
      if (intent.t === "startGame" && room.hasStarted) {
        void logEvent("game_start", undefined, { mode: "mp", players: room.summary().players });
      }
      // A player who left the room is no longer mapped to it; reap empty lobbies.
      if (intent.t === "leaveRoom") {
        socketToRoom.delete(socket.id);
        if (room.isEmpty && !room.hasStarted) rooms.delete(ref.roomCode);
      }
      // start / play-again / leave change joinability; setRoomConfig changes
      // the settings shown in the browser. All warrant a room-list refresh.
      if (
        intent.t === "startGame" || intent.t === "playAgain" ||
        intent.t === "leaveRoom" || intent.t === "setRoomConfig"
      ) {
        broadcastRoomList();
      }
    } catch (err) {
      console.error("intent error", err);
      socket.emit(SOCKET_EVENT.message, { t: "error", message: "Server error." });
    }
  });

  socket.on("disconnect", () => {
    browsers.delete(socket.id);
    const ref = socketToRoom.get(socket.id);
    if (!ref) return;
    const room = rooms.get(ref.roomCode);
    if (room) {
      room.markDisconnected(ref.playerId);
      room.broadcastLobby();
      room.broadcastState(); // so the table sees the seat go "away"
      // Keep started rooms alive so players can reconnect by id (AI takes the
      // seat over after the grace period); only reap empty lobbies that never
      // started.
      if (room.isEmpty && !room.hasStarted) rooms.delete(ref.roomCode);
    }
    socketToRoom.delete(socket.id);
    broadcastRoomList(); // a freed seat / reaped room may change the list
  });
});

// Restore any persisted in-progress games first, then start accepting clients.
void restoreRooms().finally(() => {
  httpServer.listen(PORT, "0.0.0.0", () => {
    const lan = getLanAddress();
    console.log("\n  Catan: Starfarers server running");
    console.log(`  Local:   http://localhost:${PORT}`);
    console.log(`  LAN:     http://${lan}:${PORT}   <- share this with your table`);
    console.log(`  Game persistence: ${persistenceEnabled ? "on (Supabase)" : "off (set SUPABASE_URL + SUPABASE_SERVICE_KEY)"}\n`);
  });
});
