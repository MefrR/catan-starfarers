import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { Server as IOServer } from "socket.io";
import { randomUUID } from "node:crypto";
import { type ClientIntent, SOCKET_EVENT } from "@starfarers/shared";
import { Room } from "./room.js";
import { getLanAddress } from "./lan.js";

const PORT = Number(process.env.PORT ?? 3000);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const httpServer = createServer(app);
const io = new IOServer(httpServer, {
  cors: { origin: "*" },
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
if (clientDist) {
  app.use(express.static(clientDist));
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
        rooms.set(code, room);
        const playerId = randomUUID();
        room.addMember(playerId, intent.name, socket);
        socketToRoom.set(socket.id, { roomCode: code, playerId });
        browsers.delete(socket.id); // now in a room, not browsing
        room.broadcastLobby();
        broadcastRoomList();
        return;
      }

      if (intent.t === "rejoin") {
        const room = rooms.get(intent.roomCode.toUpperCase());
        if (!room || !room.hasMember(intent.playerId)) {
          socket.emit(SOCKET_EVENT.message, { t: "error", message: "Could not rejoin." });
          return;
        }
        room.reattach(intent.playerId, socket);
        socketToRoom.set(socket.id, { roomCode: room.code, playerId: intent.playerId });
        browsers.delete(socket.id);
        room.broadcastLobby();
        room.broadcastState();
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
        room.addMember(playerId, intent.name, socket);
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
      // A player who left the room is no longer mapped to it; reap empty lobbies.
      if (intent.t === "leaveRoom") {
        socketToRoom.delete(socket.id);
        if (room.isEmpty && !room.hasStarted) rooms.delete(ref.roomCode);
      }
      // start / play-again / leave all change whether the room is joinable.
      if (intent.t === "startGame" || intent.t === "playAgain" || intent.t === "leaveRoom") {
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
      // Keep started rooms alive so players can reconnect by id; only reap
      // empty lobbies that never started.
      if (room.isEmpty && !room.hasStarted) rooms.delete(ref.roomCode);
    }
    socketToRoom.delete(socket.id);
    broadcastRoomList(); // a freed seat / reaped room may change the list
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const lan = getLanAddress();
  console.log("\n  Catan: Starfarers server running");
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  LAN:     http://${lan}:${PORT}   <- share this with your table\n`);
});
