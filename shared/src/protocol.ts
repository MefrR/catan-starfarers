// Wire protocol between client and authoritative server (Socket.IO events).
import type { GameState, GameConfig, PlayerColor, Resource, UpgradeKind } from "./types.js";

export interface LobbyPlayer {
  id: string;
  name: string;
  color: PlayerColor;
  connected: boolean;
  isHost: boolean;
  /** True for an AI seat the host added (no socket; played by the server). */
  isAI?: boolean;
  /** True when a disconnected human's seat has been taken over by the server AI
   *  after the grace period (distinct from a host-added AI). */
  aiControlled?: boolean;
}

export interface LobbyState {
  roomCode: string;
  players: LobbyPlayer[];
  started: boolean;
  config: GameConfig;
  /** Room visibility (public = listed in the browser). Shown read-only to guests. */
  isPublic: boolean;
}

/** Intents the client sends to the server. The server validates everything. */
export type ClientIntent =
  | { t: "createRoom"; name: string; public?: boolean; username?: string }
  | { t: "joinRoom"; roomCode: string; name: string; username?: string }
  | { t: "listRooms" } // ask the server for the browsable public-room list
  | { t: "leaveBrowsing" } // stop receiving public-room list updates
  | {
      t: "setRoomConfig"; // host: pre-game settings (shown in the browser / applied at start)
      fogMap?: boolean;
      turnSeconds?: number;
      targetVictoryPoints?: number;
      botSpeed?: "relaxed" | "normal" | "fast";
      friendlyRobber?: boolean;
      hideBank?: boolean;
      balancedLayout?: boolean;
      layout?: "official" | "balanced" | "unbalanced";
      deck36Dice?: boolean;
      reservePile?: boolean;
      isPublic?: boolean; // room visibility, now toggled inside the lobby
    }
  | { t: "rejoin"; roomCode: string; playerId: string }
  | { t: "setColor"; color: PlayerColor }
  | { t: "startGame"; config: Partial<GameConfig> }
  | { t: "playAgain" } // host only: after a game ends, return everyone to the lobby
  | { t: "leaveRoom" } // leave the room entirely (Back button in the lobby)
  | { t: "chat"; text: string } // real player-to-player chat, relayed to the room
  | { t: "addAi" } // host only: add an AI opponent seat
  | { t: "removeAi"; id: string } // host only: remove an AI opponent seat
  // --- Set-up phase (4-round Catanian Colonies placement) ---
  | { t: "setupRoll" } // roll both dice to determine the starting player
  | { t: "setupPlaceColony"; intersectionId: string } // rounds 1-3
  | { t: "setupUpgrade"; intersectionId: string } // round 4: colony -> spaceport
  | { t: "setupPlaceShip"; shipKind: "colonyShip" | "tradeShip"; intersectionId: string } // round 4
  | { t: "setupBonus"; upgrade: UpgradeKind } // round 4: take a bonus mothership upgrade
  | { t: "rollDice" }
  | { t: "discard"; resources: Partial<Record<Resource, number>> }
  | { t: "stealTarget"; targetId: string }
  | { t: "tradeWithSupply"; give: Partial<Record<Resource, number>>; take: Partial<Record<Resource, number>> }
  | { t: "proposeTrade"; give: Partial<Record<Resource, number>>; want: Partial<Record<Resource, number>>; wantAny?: boolean }
  | {
      t: "respondTrade";
      accept: boolean;
      counterGive?: Partial<Record<Resource, number>>;
      counterWant?: Partial<Record<Resource, number>>;
    }
  | { t: "finalizeTrade"; withId: string }
  | { t: "cancelTrade" }
  | { t: "build"; what: "colonyShip" | "tradeShip" | "spaceport" | UpgradeKind; targetId?: string }
  | { t: "endTradeBuild" }
  | { t: "shakeMothership" }
  | { t: "moveShip"; shipId: string; path: string[] }
  | { t: "establishColony"; shipId: string }
  | { t: "establishTradeStation"; shipId: string; dock: number }
  | { t: "chooseFriendship"; cardId: string }
  | { t: "buyFame" } // Diplomat "Fame for Sale": pay 1 goods for 1 fame piece (once/turn)
  | {
      t: "encounterChoice";
      choice: number | boolean;
      /** For a "give resources" follow-up: which specific cards to hand over. */
      resources?: Partial<Record<Resource, number>>;
    }
  | { t: "spaceJump"; shipId: string; toIntersectionId: string }
  | { t: "encounterShake" } // duel: the subject or the designated rival shakes
  // TEMPORARY: testing/dev hooks routed through the engine so they also work in
  // multiplayer (force an encounter, grant upgrades, etc.). Remove before release.
  | { t: "dev"; action: DevAction; n?: number }
  | { t: "endTurn" };

/** TEMPORARY dev/testing actions (single-player chat codes, also enabled online). */
export type DevAction = "encounter" | "upgrades" | "friendship" | "jump" | "vp" | "reveal" | "resources";

/** A joinable public room, summarised for the lobby browser. */
export interface RoomSummary {
  code: string;
  host: string;
  players: number;
  max: number;
  fog: boolean; // Uncharted (fog) vs Charted map
  timer: number; // per-turn seconds (0 = no limit)
}

/** Server -> client messages. */
export type ServerMessage =
  | { t: "roomList"; rooms: RoomSummary[] }
  | { t: "lobby"; lobby: LobbyState; youId: string }
  | { t: "state"; state: GameState; youId: string }
  | { t: "error"; message: string }
  | { t: "chat"; fromId: string; name: string; color: PlayerColor; text: string }
  | { t: "log"; line: string }
  | { t: "tradeOffer"; tradeId: string; fromId: string; give: Partial<Record<Resource, number>>; want: Partial<Record<Resource, number>> };

export const SOCKET_EVENT = {
  intent: "intent",
  message: "message",
} as const;
