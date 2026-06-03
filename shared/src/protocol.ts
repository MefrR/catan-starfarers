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
}

export interface LobbyState {
  roomCode: string;
  players: LobbyPlayer[];
  started: boolean;
  config: GameConfig;
}

/** Intents the client sends to the server. The server validates everything. */
export type ClientIntent =
  | { t: "createRoom"; name: string }
  | { t: "joinRoom"; roomCode: string; name: string }
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
  | { t: "proposeTrade"; give: Partial<Record<Resource, number>>; want: Partial<Record<Resource, number>> }
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
  | { t: "endTurn" };

/** Server -> client messages. */
export type ServerMessage =
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
