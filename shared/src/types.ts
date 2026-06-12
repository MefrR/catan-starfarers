// Core domain types for Catan: Starfarers
// Source of truth: rulebook.txt + almanac.txt (2019 Kosmos/Catan Studio edition)

export type Resource = "ore" | "fuel" | "carbon" | "food" | "goods";

export const RESOURCES: Resource[] = ["ore", "fuel", "carbon", "food", "goods"];

/** Planet color -> resource it produces. */
export type PlanetColor = "red" | "orange" | "blue" | "green" | "multicolor";

export const PLANET_RESOURCE: Record<PlanetColor, Resource> = {
  red: "ore",
  orange: "fuel",
  blue: "carbon",
  green: "food",
  multicolor: "goods",
};

export type ResourceBag = Record<Resource, number>;

export const emptyBag = (): ResourceBag => ({
  ore: 0,
  fuel: 0,
  carbon: 0,
  food: 0,
  goods: 0,
});

// --- Mothership balls ---
export type BallColor = "yellow" | "red" | "blue" | "black";

/** The 5 balls inside every mothership. */
export const MOTHERSHIP_BALLS: BallColor[] = [
  "yellow",
  "yellow",
  "red",
  "blue",
  "black",
];

/**
 * Numeric value of each ball when summing for speed / combat.
 * Inferred from rulebook examples (blue+red = base speed 4, range 3-5).
 * Black = 0 for combat and triggers an encounter for speed.
 * VERIFY against the physical Turn Overview card art.
 */
export const BALL_VALUE: Record<BallColor, number> = {
  yellow: 2,
  red: 1,
  blue: 3,
  black: 0,
};

// --- Upgrades ---
export type UpgradeKind = "booster" | "cannon" | "freightPod";

// --- Alien civilizations ---
export type AlienCiv = "greenFolk" | "scientists" | "diplomats" | "merchants" | "travelers";

/** Civs that have an outpost on the board (Travelers are encounter-only). */
export const OUTPOST_CIVS: AlienCiv[] = ["greenFolk", "scientists", "diplomats", "merchants"];

// --- Board topology ---
export type SectorKind =
  | "planetarySystem"
  | "outpost"
  | "empty"
  | "emptyCluster"
  | "catanianColony";

export type DiscSpecial = "none" | "pirateBase" | "icePlanet";

export interface Planet {
  id: string;
  color: PlanetColor;
  /** Normalized board-space position (same space as Intersection x,y). */
  x: number;
  y: number;
  /** Production number (2-12). Null until explored. */
  number: number | null;
  /** Hidden face-down until a ship reaches an adjacent intersection. */
  explored: boolean;
  /** Pirate base / ice planet occupy a planet until cleared. */
  special: DiscSpecial;
  /** Combat/freight threshold printed on a pirate-base / ice-planet token. */
  specialValue?: number;
}

export interface Sector {
  id: string;
  kind: SectorKind;
  /** Axial hex coordinates for layout. */
  q: number;
  r: number;
  /** Planets (planetary systems / catanian colonies have 3). */
  planets: Planet[];
  /** Outpost civ, if kind === "outpost". */
  outpostCiv?: AlienCiv;
  /** True once a ship has revealed a face-down sector (variable setups). */
  discovered: boolean;
  /** A Catanian Colonies home system (players seed their start here). */
  home?: boolean;
}

/** A vertex where ships travel and buildings sit. */
export interface Intersection {
  id: string;
  /** Pixel-ish layout position (normalized board space). */
  x: number;
  y: number;
  /** Connected intersection ids (graph edges ships traverse). */
  neighbors: string[];
  /** Planet ids this intersection is adjacent to (for production & building). */
  adjacentPlanets: string[];
  /** Outpost id if this is a docking point. */
  dockingPointOf?: string;
  /**
   * Sector ids charted when a ship reaches this intersection (fog map). Used so an
   * uncharted outpost — which is disguised as a "???" planetary system — reveals on
   * approach, just like a real system, instead of only at its exact docking point.
   */
  revealsSectors?: string[];
}

export type IntersectionRole = "colonySite" | "spaceportSite" | "dockingPoint" | "open";

// --- Player-built pieces on the board ---
export type BuildingKind = "colony" | "spaceport";
export type ShipKind = "colonyShip" | "tradeShip";

export interface Building {
  kind: BuildingKind;
  owner: PlayerId;
  intersectionId: string;
}

export interface Ship {
  id: string;
  kind: ShipKind;
  owner: PlayerId;
  intersectionId: string;
  /** True once the ship has exhausted its movement this flight phase. */
  movedThisTurn: boolean;
  /** Spaces already travelled this flight phase. A ship may move repeatedly
   *  (e.g. 3 then 5 then 2) as long as the running total stays within its speed. */
  distanceMoved: number;
}

export interface TradeStation {
  owner: PlayerId;
  outpostId: string;
  /** Dock index 0-4. */
  dock: number;
}

// --- Players ---
export type PlayerId = string;
export type PlayerColor = "yellow" | "red" | "blue" | "black";

export interface PlayerState {
  id: PlayerId;
  name: string;
  color: PlayerColor;
  connected: boolean;
  hand: ResourceBag;
  victoryPoints: number;
  fameMedalPieces: number;
  /** Permanent fame medals from defeating pirate bases / terraforming ice planets (1 VP each). */
  victoryMedals: number;
  upgrades: Record<UpgradeKind, number>;
  friendshipCards: string[]; // friendship card ids
  friendshipMarkers: AlienCiv[];
  /** Remaining pieces in personal supply. */
  supply: {
    colonies: number;
    tradeStations: number;
    transportShips: number;
    shipyards: number;
  };
}

// --- Game phases ---
export type TurnPhase =
  | "setup"
  | "production"
  | "tradeBuild"
  | "flight"
  | "encounter"
  | "gameOver";

/**
 * The faithful 4-round Catanian Colonies set-up (Almanac §Set-up Phase):
 *   roll for start player → R1 colony (CW) → R2 colony (CCW) → R3 colony (CW)
 *   → R4 upgrade a colony to a spaceport, place a ship, take a bonus upgrade (CCW)
 *   → each draws 3 resources + 1 fame medal piece → first production.
 */
export interface SetupState {
  /** rollStart: each player rolls; place: rounds 1-4 placement. */
  step: "rollStart" | "place";
  /** Dice total each player rolled for start-player determination (by seat index). */
  startRolls: Record<number, number>;
  /** Seat index of the determined starting player. */
  startPlayerIndex?: number;
  /** Current placement round (1-4). */
  round: number;
  /** Seat indices in the order they act this round. */
  order: number[];
  /** Position within `order` (whose placement we await). */
  pos: number;
  /** Round 4 has three ordered sub-actions per player. */
  r4step?: "upgrade" | "ship" | "bonus";
  /** Bonus upgrade pool placed in the middle for round 4 (2 boosters,1 cannon,1 freight pod). */
  bonusPool?: UpgradeKind[];
}

export interface PendingFriendship {
  playerId: PlayerId;
  civ: AlienCiv;
  /** Friendship-card ids the player may choose between. */
  options: string[];
}

export type TradeResponseKind = "accept" | "counter" | "decline";

export interface TradeResponse {
  playerId: PlayerId;
  kind: TradeResponseKind;
  /** For a counter: the deal from the PROPOSER's perspective (gives `give`, receives `want`). */
  give?: Partial<ResourceBag>;
  want?: Partial<ResourceBag>;
}

/** A broadcast player-to-player offer: the proposer offers to all opponents and
 *  later finalizes with one responder (accepting their counter, or the original
 *  offer if they simply accepted). */
export interface PendingTrade {
  fromId: PlayerId;
  give: Partial<ResourceBag>; // resources the proposer gives
  want: Partial<ResourceBag>; // resources the proposer wants
  responses: TradeResponse[];
}

export interface GamePhaseState {
  activePlayerIndex: number;
  phase: TurnPhase;
  /** Set-up phase progress (only present while phase === "setup"). */
  setup?: SetupState;
  lastRoll?: [number, number];
  /** Monotonic counter incremented on every dice roll (drives roll animations). */
  rollCount?: number;
  /** Per-building production from the latest roll (drives fly-to-hand animations). */
  lastProduction?: ProductionEvent[];
  /** Current shake result during flight phase. */
  shake?: { balls: [BallColor, BallColor]; speed: number; combat: number; encounter: boolean };
  /** Monotonic counter incremented on every mothership shake (drives shake animations). */
  shakeCount?: number;
  /** Active encounter, if any. */
  encounter?: EncounterState;
  /** Remaining ship-movement budget this flight phase (set on shake). */
  moveBudget?: number;
  /** A single ship immobilized for this flight phase (pirate-combat defeat — the
   *  owner chooses which). Other ships still move; cleared at end of turn. */
  frozenShipId?: string;
  /** Free space jumps granted (e.g. by an encounter): the player may move one ship
   *  to ANY open intersection on the map. Keyed by player id; decremented on use. */
  spaceJumps?: Record<PlayerId, number>;
  /** Free trade ships granted (e.g. by an encounter): the player may launch this
   *  many trade ships at NO resource cost. Keyed by player id; decremented on use.
   *  Persists across turns until launched. */
  freeTradeShips?: Record<PlayerId, number>;
  /** Resources that production could NOT pay this roll because the bank ran dry —
   *  the client shows an "out of X" notice to everyone. Cleared on the next roll. */
  productionShortfall?: Resource[];
  /** After a 7: players who still owe a discard, and how many cards. */
  pendingDiscards?: Record<PlayerId, number>;
  /** After a 7 + discards: roller must pick a player to steal from. */
  awaitingSteal?: boolean;
  /** The most recent 7-steal — drives a card-fly animation from victim to thief. */
  lastSteal?: { fromId: PlayerId; toId: PlayerId; seq: number };
  /** The most recent completed player-to-player trade — drives a two-way card-fly
   *  animation between the two players (R8). */
  lastTrade?: { fromId: PlayerId; toId: PlayerId; seq: number };
  /** After a 7: reserve-pile bonus owed to the roller, drawn once the steal resolves. */
  pendingReserveDraw?: { playerId: PlayerId; count: number };
  /** The most recent reserve-pile draw — drives the fly-in animation of the specific cards gained. */
  reserveDraw?: { playerId: PlayerId; gains: Partial<ResourceBag>; seq: number };
  /** After building a trade station: the owner must choose a friendship ability. */
  pendingFriendship?: PendingFriendship;
  /** A live player-to-player trade offer awaiting a response. */
  pendingTrade?: PendingTrade;
  /** Players who have used Diplomat "Fame for Sale" this turn (once per turn). */
  fameBoughtBy?: PlayerId[];
  /** Players who have used the Merchant goods 1:1 "Trade Advantage" this turn (once per turn). */
  goodsTradeUsedBy?: PlayerId[];
  /** The most recent mothership upgrade purchase — drives an animation visible to all players (R10). */
  lastUpgrade?: { playerId: PlayerId; kind: UpgradeKind; seq: number };
  /** How many trade offers the active player has broadcast this turn (bounds AI proposals). */
  tradeProposals?: number;
  /**
   * The most recent pirate-base / ice-planet clearing — drives the animation of
   * the token + VP medal flying from the planet to the conquering player. Bumped
   * via `seq` so the client fires the animation exactly once.
   */
  lastClearedSpecial?: {
    playerId: PlayerId;
    kind: "pirateBase" | "icePlanet";
    intersectionId: string;
    seq: number;
  };
  winner?: PlayerId;
}

/** One building's resource yield from a production roll. */
export interface ProductionEvent {
  owner: PlayerId;
  intersectionId: string;
  resource: Resource;
  amount: number;
  /**
   * How many of `amount` are a Green Folk "Production Increase" bonus (P6h). The
   * HUD flies these extra tokens from the player's friendship card, not the planet.
   */
  bonus?: number;
}

export interface EncounterState {
  cardId: number;
  /** Player resolving the encounter. */
  subjectId: PlayerId;
  /** Pending decision the subject must commit before reveal. */
  awaiting: "number" | "yesno" | "resolve" | "combat" | "selectShip" | "giveResources" | "confirm" | "duel";
  /** An interactive duel: the subject and a designated rival each shake their
   *  mothership; the card outcome (resolveDuel) applies once both rolls are in. */
  duel?: {
    opponentId: PlayerId;
    stat: "combat" | "speed";
    subjectRoll?: number;
    oppRoll?: number;
  };
  /**
   * Follow-up decisions a card queues after its main outcome (resolved in order):
   * the subject picks which resources to surrender, and/or which ship a combat
   * defeat immobilizes. Steps with no real choice auto-resolve and are skipped.
   */
  pendingSteps?: Array<{ kind: "giveResources"; count: number } | { kind: "selectShip" }>;
  /** Number of resources owed for the active "giveResources" step. */
  lossCount?: number;
  committedChoice?: number | boolean;
  /** All-player cards (Wear & Tear): the card stays up until everyone confirms. */
  allPlayers?: boolean;
  /** Player ids that have pressed Confirm on an all-player card. */
  confirmedBy?: PlayerId[];
  /**
   * Wear & Tear (P6i): each over-the-limit player chooses which upgrade to scrap.
   * Keyed by player id; applied when the card resolves. Players who don't choose
   * (AI / at-or-below the limit) fall back to the default booster→cannon→pod order.
   */
  wearTearChoices?: Record<PlayerId, UpgradeKind>;
}

/** Z2: per-player aggregates that tell the story of the game on the win screen.
 *  All records are keyed by player id. Optional on GameState so saves from
 *  before this field simply skip the chart. */
export interface GameStats {
  /** VP snapshot per player, appended after every completed turn. */
  vpHistory: Record<PlayerId, number[]>;
  /** Resources gained from production (incl. friendship bonuses). */
  resourcesGained: Record<PlayerId, number>;
  encountersFaced: Record<PlayerId, number>;
  piratesDefeated: Record<PlayerId, number>;
  icePlanetsTerraformed: Record<PlayerId, number>;
  /** Bank + player trades completed (both partners count). */
  tradesCompleted: Record<PlayerId, number>;
  /** Total intersections flown across by their ships. */
  distanceFlown: Record<PlayerId, number>;
}

// --- Full authoritative game state ---
export interface GameState {
  id: string;
  phaseState: GamePhaseState;
  players: PlayerState[];
  sectors: Sector[];
  intersections: Record<string, Intersection>;
  buildings: Building[];
  ships: Ship[];
  tradeStations: TradeStation[];
  /** Reserve pile (face-down) as counts; drawn by the active roller. */
  reservePile: ResourceBag;
  /** The supply bank of resource cards available for production/trade. */
  supplyBank: ResourceBag;
  encounterDeck: number[]; // remaining card ids (top = index 0)
  encounterDiscard: number[];
  config: GameConfig;
  log: string[];
  stats?: GameStats;
}

export interface GameConfig {
  playerCount: number;
  /** Beginner fixed board vs variable/explorer setups. */
  setup: "beginner" | "strategic" | "explorer" | "wild";
  targetVictoryPoints: number; // default 15
  /** When true, non-home planetary systems & outposts start face-down ("uncharted")
   *  and only reveal when a player's ship reaches an adjacent intersection. */
  fogMap?: boolean;
  /** How aggressively the AI opponents play. Defaults to "normal". */
  aiDifficulty?: AiDifficulty;
  /** Optional per-turn time limit in seconds (host-chosen, 15–180 in 5s steps).
   *  0 / undefined = no timer. A successful trade adds TURN_TRADE_BONUS seconds. */
  turnSeconds?: number;
}

/** Time (seconds) added to the active player's turn timer after a successful
 *  bank or player trade. */
export const TURN_TRADE_BONUS = 10;

export type AiDifficulty = "easy" | "normal" | "hard";
