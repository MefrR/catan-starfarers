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
import { createGameState, applyIntent } from "@starfarers/shared";

interface Member {
  id: string;
  name: string;
  socket: Socket | null;
  color: LobbyPlayer["color"];
  isHost: boolean;
  connected: boolean;
}

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

  constructor(code: string) {
    this.code = code;
  }

  get isEmpty(): boolean {
    return [...this.members.values()].every((m) => !m.connected);
  }

  get hasStarted(): boolean {
    return this.started;
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
        return;
      }
    }
  }
}
