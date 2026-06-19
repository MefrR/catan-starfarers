import type { Socket } from "socket.io";
import {
  type ClientIntent,
  type LobbyState,
  type LobbyPlayer,
  type ServerMessage,
  type GameConfig,
  type GameState,
  PLAYER_COLORS,
  DEFAULT_TARGET_VP,
  BOT_SPEED_MS,
  SOCKET_EVENT,
} from "@starfarers/shared";
import { createGameState, applyIntent, aiObligation, aiTurnAction } from "@starfarers/shared";

interface Member {
  id: string;
  name: string;
  socket: Socket | null;
  color: LobbyPlayer["color"];
  isHost: boolean;
  connected: boolean;
  /** Host-added AI seat (no human ever owned it). */
  isAI?: boolean;
  /** A disconnected human's seat the server AI has taken over (after the grace
   *  period) so the game keeps moving. Cleared if the human reclaims it. */
  aiControlled?: boolean;
  /** The grace period elapsed — the human can no longer reclaim this seat and it
   *  no longer appears in their rejoin area. The AI keeps the seat for good. */
  released?: boolean;
  /** When the socket dropped (ms epoch), for the takeover / release timers. */
  disconnectedAt?: number;
  /** Account username (lowercased) the client claims at join — used only to
   *  authorize developer testing codes. */
  username?: string;
}

/** One member's snapshot for durable persistence (no live socket). */
interface MemberSnapshot {
  id: string;
  name: string;
  color: LobbyPlayer["color"];
  isHost: boolean;
  isAI: boolean;
  aiControlled: boolean;
  released: boolean;
  username?: string;
}

/** A whole room, serialised so it survives a server restart / spin-down. */
export interface RoomSnapshot {
  code: string;
  isPublic: boolean;
  started: boolean;
  config: GameConfig;
  aiSeq: number;
  members: MemberSnapshot[];
  game: GameState | null;
}

/** Usernames allowed to use the dev/testing codes online (lowercase). Extend
 *  as needed; keep it short. */
const DEV_USERNAMES = new Set(["mefr"]);

/** Encounters resolve far slower so players can read the card and the AI's
 *  choice before it flashes past (5s minimum per AI encounter act). */
const ENCOUNTER_AI_DELAY = 5000;
const AI_NAMES = ["Nova", "Orion", "Vega", "Lyra", "Atlas", "Cygnus"];

/** A disconnected human's seat is auto-played by AI after this long, so the rest
 *  of the table isn't stuck waiting (the game "will not die"). Overridable via
 *  env for tuning / testing; defaults to 100s. */
const AI_TAKEOVER_MS = Number(process.env.SF_AI_TAKEOVER_MS) || 100_000;
/** ...and after this long they forfeit the seat entirely: it stays an AI for the
 *  rest of the game and the game disappears from their rejoin area. Default 300s. */
const SEAT_RELEASE_MS = Number(process.env.SF_SEAT_RELEASE_MS) || 300_000;

export class Room {
  readonly code: string;
  private members = new Map<string, Member>();
  private started = false;
  private config: GameConfig = {
    playerCount: 4,
    setup: "beginner",
    targetVictoryPoints: DEFAULT_TARGET_VP,
  };
  private game: GameState | null = null;
  /** Member ids the server plays (host-added bots + taken-over seats). */
  private aiIds = new Set<string>();
  private aiSeq = 0;
  /** Per-member disconnect timers (takeover at 100s, release at 300s). */
  private timers = new Map<string, { takeover?: ReturnType<typeof setTimeout>; release?: ReturnType<typeof setTimeout> }>();
  /** Public rooms show up in the lobby browser; private ones are code-only. */
  isPublic = false;

  /** Persist the latest snapshot to durable storage (set by the server). */
  onPersist: (() => void) | null = null;
  /** Drop the persisted row but keep the room in memory (game over). */
  onUnpersist: (() => void) | null = null;
  /** Retire the room entirely — abandoned by every human. */
  onReap: (() => void) | null = null;

  constructor(code: string) {
    this.code = code;
  }

  /** Rebuild a room from a stored snapshot (members reload without sockets). */
  static fromSnapshot(s: RoomSnapshot): Room {
    const room = new Room(s.code);
    room.isPublic = s.isPublic;
    room.started = s.started;
    room.config = s.config;
    room.aiSeq = s.aiSeq ?? 0;
    for (const ms of s.members) {
      room.members.set(ms.id, {
        id: ms.id,
        name: ms.name,
        color: ms.color,
        isHost: ms.isHost,
        socket: null,
        connected: false,
        isAI: ms.isAI,
        aiControlled: ms.aiControlled,
        released: ms.released,
        username: ms.username,
      });
    }
    room.game = s.game;
    room.aiIds = new Set(
      [...room.members.values()].filter((m) => m.isAI || m.aiControlled).map((m) => m.id),
    );
    return room;
  }

  /** Serialise the room for durable storage. Sockets are intentionally dropped. */
  snapshot(): RoomSnapshot {
    return {
      code: this.code,
      isPublic: this.isPublic,
      started: this.started,
      config: this.config,
      aiSeq: this.aiSeq,
      members: [...this.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        isHost: m.isHost,
        isAI: !!m.isAI,
        aiControlled: !!m.aiControlled,
        released: !!m.released,
        username: m.username,
      })),
      game: this.game,
    };
  }

  /** A room is "empty" once no HUMAN is connected — AI seats don't keep it alive. */
  get isEmpty(): boolean {
    return [...this.members.values()].every((m) => m.isAI || !m.connected);
  }

  get hasStarted(): boolean {
    return this.started;
  }

  /** Joinable from the lobby browser: public, open, and not yet started. */
  get isJoinable(): boolean {
    return this.isPublic && !this.started && this.members.size < this.config.playerCount;
  }

  /** At least one human (not a bot) is currently connected. AI seats only play
   *  while a real player is watching, so abandoned games pause instead of
   *  burning the server running a match no one can see. */
  private hasConnectedHuman(): boolean {
    return [...this.members.values()].some((m) => !m.isAI && m.connected);
  }

  /** A human who could still come back (connected, or away within the grace
   *  window). Once none remain, the room can be retired. */
  private hasReclaimableHuman(): boolean {
    return [...this.members.values()].some((m) => !m.isAI && !m.released);
  }

  /** Compact card for the lobby room list. */
  summary(): { code: string; host: string; players: number; max: number; fog: boolean; timer: number } {
    const host = [...this.members.values()].find((m) => m.isHost);
    return {
      code: this.code,
      host: host?.name ?? "Commander",
      players: this.members.size,
      max: this.config.playerCount,
      fog: !!this.config.fogMap,
      timer: this.config.turnSeconds ?? 0,
    };
  }

  hasMember(id: string): boolean {
    return this.members.has(id);
  }

  private clearTimers(id: string): void {
    const t = this.timers.get(id);
    if (t) {
      if (t.takeover) clearTimeout(t.takeover);
      if (t.release) clearTimeout(t.release);
      this.timers.delete(id);
    }
  }

  /**
   * Reattach a returning player's socket (reconnect / rejoin by player id).
   * Returns the outcome so the server can tell the client what happened:
   *  - "ok": seat reclaimed (any AI takeover handed back to the human)
   *  - "released": the grace window expired; the seat is permanently the AI's
   *  - "missing": no such member in this room
   */
  reattach(id: string, socket: Socket): "ok" | "released" | "missing" {
    const m = this.members.get(id);
    if (!m) return "missing";
    if (m.released) return "released";
    this.clearTimers(id);
    m.socket = socket;
    m.connected = true;
    m.disconnectedAt = undefined;
    if (m.aiControlled) {
      // Hand control back from the server AI to the returning human.
      m.aiControlled = false;
      this.aiIds.delete(id);
    }
    this.broadcastLobby();
    this.broadcastState();
    this.driveAi(); // a human is back — resume any paused AI seats
    return "ok";
  }

  private nextColor(): LobbyPlayer["color"] {
    const used = new Set([...this.members.values()].map((m) => m.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? "yellow";
  }

  addMember(id: string, name: string, socket: Socket, username?: string): Member {
    const handle = username?.trim().toLowerCase() || undefined;
    const existing = this.members.get(id);
    if (existing) {
      existing.socket = socket;
      existing.connected = true;
      existing.name = name || existing.name;
      if (handle) existing.username = handle;
      return existing;
    }
    const member: Member = {
      id,
      name: name || `Starfarer ${this.members.size + 1}`,
      socket,
      color: this.nextColor(),
      isHost: this.members.size === 0,
      connected: true,
      username: handle,
    };
    this.members.set(id, member);
    return member;
  }

  markDisconnected(id: string): void {
    const m = this.members.get(id);
    if (!m) return;
    m.connected = false;
    m.socket = null;
    // Pre-game, or a finished game, or an AI/already-released seat: nothing to
    // schedule (the index reaps empty pre-game lobbies separately).
    if (!this.started || !this.game || this.game.phaseState.phase === "gameOver") return;
    if (m.isAI || m.released) return;
    m.disconnectedAt = Date.now();
    this.clearTimers(id);
    this.timers.set(id, {
      takeover: setTimeout(() => this.aiTakeover(id), AI_TAKEOVER_MS),
      release: setTimeout(() => this.releaseSeat(id), SEAT_RELEASE_MS),
    });
  }

  /** After a server restart, every seat reloads disconnected. Arm the same
   *  takeover/release grace for each absent human so a reclaimed game resumes —
   *  and a truly-abandoned one is cleaned up ~5 min after boot rather than
   *  lingering forever. */
  armGraceForDisconnected(): void {
    if (!this.started || !this.game || this.game.phaseState.phase === "gameOver") return;
    for (const m of this.members.values()) {
      if (m.isAI || m.released || m.connected || this.timers.has(m.id)) continue;
      m.disconnectedAt = Date.now();
      this.timers.set(m.id, {
        takeover: setTimeout(() => this.aiTakeover(m.id), AI_TAKEOVER_MS),
        release: setTimeout(() => this.releaseSeat(m.id), SEAT_RELEASE_MS),
      });
    }
  }

  /** 100s: the server AI takes over a still-absent seat so the table flows on. */
  private aiTakeover(id: string): void {
    const m = this.members.get(id);
    if (!m || m.connected || m.isAI || m.aiControlled) return;
    m.aiControlled = true;
    this.aiIds.add(id);
    this.broadcast({ t: "log", line: `${m.name} disconnected — AI is now playing their fleet.` });
    this.broadcastLobby();
    this.broadcastState();
    this.driveAi();
  }

  /** 300s: the seat is forfeited for good (stays AI). The game leaves the
   *  player's rejoin area; if no human can return, the room is retired. */
  private releaseSeat(id: string): void {
    const m = this.members.get(id);
    if (!m || m.connected || m.released) return;
    m.released = true;
    m.aiControlled = true;
    this.aiIds.add(id);
    this.clearTimers(id);
    this.broadcastLobby();
    this.broadcastState();
    this.driveAi();
    if (!this.hasReclaimableHuman()) this.onReap?.();
  }

  private lobby(): LobbyState {
    return {
      roomCode: this.code,
      started: this.started,
      config: this.config,
      players: [...this.members.values()].map((m) => ({
        id: m.id,
        name: m.name,
        color: m.color,
        connected: m.connected,
        isHost: m.isHost,
        isAI: m.isAI,
        aiControlled: m.aiControlled,
      })),
    };
  }

  broadcast(msg: ServerMessage): void {
    for (const m of this.members.values()) {
      m.socket?.emit(SOCKET_EVENT.message, msg);
    }
  }

  send(id: string, msg: ServerMessage): void {
    this.members.get(id)?.socket?.emit(SOCKET_EVENT.message, msg);
  }

  broadcastLobby(): void {
    for (const m of this.members.values()) {
      m.socket?.emit(SOCKET_EVENT.message, { t: "lobby", lobby: this.lobby(), youId: m.id });
    }
  }

  /** Copy live presence (connected / AI-controlled) onto the game's player
   *  records so every client can show who is away or being played by AI. */
  private syncPlayerFlags(): void {
    if (!this.game) return;
    for (const p of this.game.players) {
      const m = this.members.get(p.id);
      if (!m) continue;
      p.connected = m.isAI ? true : m.connected;
      p.aiControlled = !!m.aiControlled;
    }
  }

  broadcastState(): void {
    if (!this.game) return;
    this.syncPlayerFlags();
    for (const m of this.members.values()) {
      m.socket?.emit(SOCKET_EVENT.message, { t: "state", state: this.game, youId: m.id });
    }
    // Mirror to durable storage so the game survives a server restart. A
    // finished game needs no rejoin, so drop its row instead.
    if (this.started) {
      if (this.game.phaseState.phase === "gameOver") this.onUnpersist?.();
      else this.onPersist?.();
    }
  }

  handleIntent(id: string, intent: ClientIntent): void {
    const member = this.members.get(id);
    if (!member) return;

    switch (intent.t) {
      case "setColor": {
        const taken = [...this.members.values()].some((m) => m.id !== id && m.color === intent.color);
        if (taken) {
          this.send(id, { t: "error", message: "Color already taken." });
          return;
        }
        member.color = intent.color;
        this.broadcastLobby();
        return;
      }
      case "setRoomConfig": {
        // Host's pre-game choices (map style / timer) — stored so the lobby
        // browser can show them. The index layer re-broadcasts the room list.
        if (!member.isHost) return;
        if (intent.fogMap !== undefined) this.config = { ...this.config, fogMap: intent.fogMap };
        if (intent.turnSeconds !== undefined) this.config = { ...this.config, turnSeconds: intent.turnSeconds };
        if (intent.targetVictoryPoints !== undefined)
          this.config = { ...this.config, targetVictoryPoints: intent.targetVictoryPoints };
        if (intent.botSpeed !== undefined) this.config = { ...this.config, botSpeed: intent.botSpeed };
        if (intent.friendlyRobber !== undefined) this.config = { ...this.config, friendlyRobber: intent.friendlyRobber };
        if (intent.hideBank !== undefined) this.config = { ...this.config, hideBank: intent.hideBank };
        if (intent.balancedLayout !== undefined) this.config = { ...this.config, balancedLayout: intent.balancedLayout };
        if (intent.deck36Dice !== undefined) this.config = { ...this.config, deck36Dice: intent.deck36Dice };
        // Visibility is now toggled inside the lobby (host-only). Re-broadcast of
        // the room list is handled by the index layer for setRoomConfig.
        if (intent.isPublic !== undefined) this.isPublic = intent.isPublic;
        this.broadcastLobby();
        return;
      }
      case "startGame": {
        if (!member.isHost) {
          this.send(id, { t: "error", message: "Only the host can start the game." });
          return;
        }
        this.config = { ...this.config, ...intent.config };
        this.started = true;
        this.aiIds = new Set([...this.members.values()].filter((m) => m.isAI).map((m) => m.id));
        this.game = createGameState(
          [...this.members.values()].map((m) => ({
            id: m.id,
            name: m.name,
            color: m.color,
            connected: m.connected,
          })),
          this.config,
        );
        this.broadcastLobby();
        this.broadcastState();
        // If the first setup actor is an AI, get the bots rolling.
        this.driveAi();
        return;
      }
      case "addAi": {
        if (!member.isHost) {
          this.send(id, { t: "error", message: "Only the host can add AI players." });
          return;
        }
        if (this.started) return;
        if (this.members.size >= 4) {
          this.send(id, { t: "error", message: "The table is full (4 players max)." });
          return;
        }
        const color = this.nextColor();
        const n = [...this.members.values()].filter((m) => m.isAI).length;
        const aiId = `ai-${this.aiSeq++}`;
        this.members.set(aiId, {
          id: aiId,
          name: `${AI_NAMES[n % AI_NAMES.length]} (AI)`,
          socket: null,
          color,
          isHost: false,
          connected: true,
          isAI: true,
        });
        this.broadcastLobby();
        return;
      }
      case "removeAi": {
        if (!member.isHost) {
          this.send(id, { t: "error", message: "Only the host can remove AI players." });
          return;
        }
        const target = this.members.get(intent.id);
        if (target?.isAI) this.members.delete(intent.id);
        this.broadcastLobby();
        return;
      }
      case "chat": {
        // Relay a chat line to everyone in the room (including the sender, so all
        // clients render an identical log). Works in the lobby and mid-game.
        const text = String(intent.text ?? "").slice(0, 200).trim();
        if (!text) return;
        this.broadcast({
          t: "chat",
          fromId: member.id,
          name: member.name,
          color: member.color,
          text,
        });
        return;
      }
      case "leaveRoom": {
        if (this.started && this.game && this.game.phaseState.phase !== "gameOver") {
          // Quitting a live game: the seat stays in the match and the AI takes it
          // over so the others can finish. Don't delete the member (the game
          // state still has that player).
          this.clearTimers(id);
          member.connected = false;
          member.socket = null;
          member.released = true;
          member.aiControlled = true;
          this.aiIds.add(id);
          this.broadcast({ t: "log", line: `${member.name} left the game — AI takes over their fleet.` });
          this.broadcastLobby();
          this.broadcastState();
          this.driveAi();
          if (!this.hasReclaimableHuman()) this.onReap?.();
          return;
        }
        // Pre-game (or after game over): remove the seat. If the host leaves,
        // promote the next remaining member so the room stays controllable.
        this.members.delete(id);
        this.clearTimers(id);
        if (member.isHost) {
          const next = [...this.members.values()].find((m) => !m.isAI);
          if (next) next.isHost = true;
        }
        this.broadcastLobby();
        return;
      }
      case "playAgain": {
        // Host returns the whole room to the lobby for a fresh game. Colors,
        // names, and host stay as they were; only the in-progress game is cleared.
        if (!member.isHost) {
          this.send(id, { t: "error", message: "Only the host can start a new game." });
          return;
        }
        this.started = false;
        this.game = null;
        this.onUnpersist?.(); // no game to persist anymore
        this.broadcastLobby();
        return;
      }
      default: {
        // Dev/testing codes are developer-only. Reject them server-side unless the
        // member's claimed account is on the allowlist — so a crafted socket
        // message from a normal player can't grant cards/VP/encounters online.
        if (intent.t === "dev" && !DEV_USERNAMES.has(member.username ?? "")) {
          this.send(id, { t: "error", message: "Not authorized." });
          return;
        }
        // Game intents: run them through the shared engine authoritatively and
        // broadcast the resulting state to every connected Starfarer.
        if (!this.started || !this.game) {
          this.send(id, { t: "error", message: "Game has not started yet." });
          return;
        }
        const result = applyIntent(this.game, id, intent);
        if (result.error) {
          this.send(id, { t: "error", message: result.error });
          return;
        }
        this.game = result.state;
        this.broadcastState();
        // A human move may have created AI obligations (e.g. a 7 forcing discards)
        // or handed the turn to a bot — let the AI seats respond / play on.
        this.driveAi();
        return;
      }
    }
  }

  // --- Server-side AI seats ---------------------------------------------------

  /** Resolve any obligations AI seats owe right now (discards on a 7, trade
   *  responses), then, if the active seat is an AI, schedule its turn. */
  private driveAi(): void {
    if (!this.started || !this.game || this.aiIds.size === 0) return;
    if (!this.hasConnectedHuman()) return; // paused while no human is watching
    if (this.pumpAiObligations()) this.broadcastState();
    this.scheduleAi();
  }

  /** Apply every AI obligation available this instant (off-turn too). Returns
   *  true if anything changed. */
  private pumpAiObligations(): boolean {
    let changed = false;
    for (let guard = 0; guard < 64; guard++) {
      let acted = false;
      for (const aiId of this.aiIds) {
        if (!this.game) break;
        const intent = aiObligation(this.game, aiId);
        if (!intent) continue;
        const res = applyIntent(this.game, aiId, intent);
        if (!res.error) {
          this.game = res.state;
          acted = true;
          changed = true;
        }
      }
      if (!acted) break;
    }
    return changed;
  }

  /** If the active seat is an AI (and the game is live), step it after a delay. */
  private scheduleAi(): void {
    if (!this.game || this.game.phaseState.phase === "gameOver") return;
    if (!this.hasConnectedHuman()) return;
    const active = this.game.players[this.game.phaseState.activePlayerIndex];
    if (!active || !this.aiIds.has(active.id)) return;
    const seatId = active.id;
    setTimeout(() => this.stepAi(seatId), this.aiStepDelay());
  }

  /** Delay before the AI's next act — slowed right down during an encounter so
   *  players can read what's happening; otherwise the host-chosen bot speed. */
  private aiStepDelay(): number {
    if (this.game?.phaseState.phase === "encounter") return ENCOUNTER_AI_DELAY;
    return BOT_SPEED_MS[this.config.botSpeed ?? "normal"];
  }

  private stepAi(seatId: string): void {
    if (!this.started || !this.game) return;
    if (!this.aiIds.has(seatId)) return; // a returning human reclaimed this seat
    if (!this.hasConnectedHuman()) return; // abandoned — pause until someone returns
    const active = this.game.players[this.game.phaseState.activePlayerIndex];
    if (!active || active.id !== seatId) return; // turn already advanced
    const intent = aiTurnAction(this.game, seatId);
    if (!intent) {
      // Waiting on something (e.g. a human discard) — retry shortly.
      setTimeout(() => this.stepAi(seatId), this.aiStepDelay());
      return;
    }
    let res = applyIntent(this.game, seatId, intent);
    if (res.error) {
      // Never let a bot spin on a perpetually-invalid intent: force phase progress.
      const phase = this.game.phaseState.phase;
      const fallback: ClientIntent | null =
        phase === "tradeBuild" ? { t: "endTradeBuild" } : phase === "flight" ? { t: "endTurn" } : null;
      if (fallback) {
        const fres = applyIntent(this.game, seatId, fallback);
        if (!fres.error) res = fres;
      }
    }
    if (!res.error) {
      this.game = res.state;
      this.pumpAiObligations();
      this.broadcastState();
    }
    this.scheduleAi();
  }
}
