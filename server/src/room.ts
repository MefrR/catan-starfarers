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
  isAI?: boolean;
}

/** Pacing for server-driven AI seats (ms) so humans can follow along. */
const AI_DELAY = 800;
/** Encounters resolve far slower so players can read the card and the AI's
 *  choice before it flashes past (5s minimum per AI encounter act). */
const ENCOUNTER_AI_DELAY = 5000;
const AI_NAMES = ["Nova", "Orion", "Vega", "Lyra", "Atlas", "Cygnus"];

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
  /** Member ids that are AI seats (played by the server). */
  private aiIds = new Set<string>();
  private aiSeq = 0;
  /** Public rooms show up in the lobby browser; private ones are code-only. */
  isPublic = false;

  constructor(code: string) {
    this.code = code;
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

  /** Compact card for the lobby room list. */
  summary(): { code: string; host: string; players: number; max: number } {
    const host = [...this.members.values()].find((m) => m.isHost);
    return {
      code: this.code,
      host: host?.name ?? "Commander",
      players: this.members.size,
      max: this.config.playerCount,
    };
  }

  hasMember(id: string): boolean {
    return this.members.has(id);
  }

  /** Reattach a returning player's socket (reconnect by player id). */
  reattach(id: string, socket: Socket): boolean {
    const m = this.members.get(id);
    if (!m) return false;
    m.socket = socket;
    m.connected = true;
    return true;
  }

  private nextColor(): LobbyPlayer["color"] {
    const used = new Set([...this.members.values()].map((m) => m.color));
    return PLAYER_COLORS.find((c) => !used.has(c)) ?? "yellow";
  }

  addMember(id: string, name: string, socket: Socket): Member {
    const existing = this.members.get(id);
    if (existing) {
      existing.socket = socket;
      existing.connected = true;
      existing.name = name || existing.name;
      return existing;
    }
    const member: Member = {
      id,
      name: name || `Starfarer ${this.members.size + 1}`,
      socket,
      color: this.nextColor(),
      isHost: this.members.size === 0,
      connected: true,
    };
    this.members.set(id, member);
    return member;
  }

  markDisconnected(id: string): void {
    const m = this.members.get(id);
    if (m) {
      m.connected = false;
      m.socket = null;
    }
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

  broadcastState(): void {
    if (!this.game) return;
    for (const m of this.members.values()) {
      m.socket?.emit(SOCKET_EVENT.message, { t: "state", state: this.game, youId: m.id });
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
        // Remove the member from the room and tell the rest. If the host leaves,
        // promote the next remaining member so the room stays controllable.
        this.members.delete(id);
        if (member.isHost) {
          const next = [...this.members.values()][0];
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
        this.broadcastLobby();
        return;
      }
      default: {
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
    const active = this.game.players[this.game.phaseState.activePlayerIndex];
    if (!active || !this.aiIds.has(active.id)) return;
    const seatId = active.id;
    setTimeout(() => this.stepAi(seatId), this.aiStepDelay());
  }

  /** Delay before the AI's next act — slowed right down during an encounter so
   *  players can read what's happening. */
  private aiStepDelay(): number {
    return this.game?.phaseState.phase === "encounter" ? ENCOUNTER_AI_DELAY : AI_DELAY;
  }

  private stepAi(seatId: string): void {
    if (!this.started || !this.game) return;
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
