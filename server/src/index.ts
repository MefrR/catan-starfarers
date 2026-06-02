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
const io = new IOServer(httpServer, { cors: { origin: "*" } });

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
      if (intent.t === "createRoom") {
        const code = makeRoomCode();
        const room = new Room(code);
        rooms.set(code, room);
        const playerId = randomUUID();
        room.addMember(playerId, intent.name, socket);
        socketToRoom.set(socket.id, { roomCode: code, playerId });
        room.broadcastLobby();
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
        const playerId = randomUUID();
        room.addMember(playerId, intent.name, socket);
        socketToRoom.set(socket.id, { roomCode: room.code, playerId });
        room.broadcastLobby();
        return;
      }

      const ref = socketToRoom.get(socket.id);
      const room = ref && rooms.get(ref.roomCode);
      if (!ref || !room) {
        socket.emit(SOCKET_EVENT.message, { t: "error", message: "Not in a room." });
        return;
      }
      room.handleIntent(ref.playerId, intent);
    } catch (err) {
      console.error("intent error", err);
      socket.emit(SOCKET_EVENT.message, { t: "error", message: "Server error." });
    }
  });

  socket.on("disconnect", () => {
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
  });
});

httpServer.listen(PORT, "0.0.0.0", () => {
  const lan = getLanAddress();
  console.log("\n  Catan: Starfarers server running");
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  LAN:     http://${lan}:${PORT}   <- share this with your table\n`);
});
