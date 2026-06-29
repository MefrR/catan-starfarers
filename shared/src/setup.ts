// Builds the initial GameState from a lobby/new-game roster + generated board.
// Lives in shared so both the local single-player driver and the (future)
// authoritative server build identical starting states.
import { generateBoard } from "./board.js";
import { recomputeVp } from "./engine.js";
import {
  PLAYER_PIECES,
  RESERVE_PER_TYPE,
  UNLIMITED_POOL,
  DEFAULT_TARGET_VP,
} from "./constants.js";
import {
  emptyBag,
  type Building,
  type GameConfig,
  type GameState,
  type PlayerColor,
  type PlayerState,
  type ResourceBag,
  type Sector,
  type Intersection,
} from "./types.js";

export interface SetupMember {
  id: string;
  name: string;
  color: PlayerColor;
  connected: boolean;
}

const bagOf = (n: number): ResourceBag => ({ ore: n, fuel: n, carbon: n, food: n, goods: n });

/** Colony-site intersections that belong to a given planetary system. */
function homeColonySites(
  sector: Sector,
  intersections: Record<string, Intersection>,
): Intersection[] {
  const planetIds = new Set(sector.planets.map((p) => p.id));
  return Object.values(intersections)
    .filter((inter) => {
      const own = inter.adjacentPlanets.filter((pid) => planetIds.has(pid));
      // Edge sites only (shared by exactly 2 planets); never the system center.
      return own.length === 2 && inter.adjacentPlanets.length === 2;
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function createGameState(
  members: SetupMember[],
  config: Partial<GameConfig>,
): GameState {
  const cfg: GameConfig = {
    playerCount: members.length,
    setup: "beginner",
    targetVictoryPoints: DEFAULT_TARGET_VP,
    ...config,
  };

  // #15/#16 Map layout mode. "official" = the recommended FIXED board (a constant
  // seed, so the same arrangement every game) with the balance repair on;
  // "balanced" = randomized each game with the repair; "unbalanced" = randomized,
  // raw. Falls back to the old balancedLayout boolean for back-compat.
  const layout =
    cfg.layout ?? (cfg.balancedLayout === false ? "unbalanced" : "balanced");
  const OFFICIAL_SEED = 0x57a4; // fixed → the recommended layout reproduces exactly
  const { sectors, intersections } = generateBoard({
    setup: "beginner",
    seed: layout === "official" ? OFFICIAL_SEED : Date.now() & 0xffff,
    randomizeLayout: cfg.fogMap,
    balancedLayout: layout !== "unbalanced",
  });
  void homeColonySites; // retained helper (used by tests / future variants)

  // Fog map (N3/N4): every non-home planetary system and every outpost starts
  // "uncharted" — planets are flipped face-down (shown as blank discs with an
  // outline) and revealed in full when a player's ship reaches them. Home systems
  // stay fully charted so each player can seed their starting colonies fairly.
  if (cfg.fogMap) {
    for (const sector of sectors) {
      if (sector.home) continue;
      if (sector.kind === "planetarySystem") {
        sector.discovered = false;
        for (const planet of sector.planets) {
          planet.explored = false;
          planet.number = null;
        }
      } else if (sector.kind === "outpost" || sector.kind === "emptyCluster") {
        sector.discovered = false;
      }
    }
  }

  const players: PlayerState[] = members.map((m) => ({
    id: m.id,
    name: m.name,
    color: m.color,
    connected: m.connected,
    hand: emptyBag(),
    victoryPoints: 0,
    fameMedalPieces: 0,
    victoryMedals: 0,
    upgrades: { booster: 0, cannon: 0, freightPod: 0 },
    friendshipCards: [],
    friendshipMarkers: [],
    supply: {
      colonies: PLAYER_PIECES.colonies,
      tradeStations: PLAYER_PIECES.tradeStations,
      transportShips: PLAYER_PIECES.transportShips,
      shipyards: PLAYER_PIECES.shipyards,
    },
  }));

  // No auto-placement: the game opens in the faithful 4-round set-up phase, where
  // every player rolls for start order and then seeds their Catanian Colonies.
  const buildings: Building[] = [];

  const state: GameState = {
    id: `g${Date.now().toString(36)}`,
    phaseState: {
      activePlayerIndex: 0,
      phase: "setup",
      setup: {
        step: "rollStart",
        startRolls: {},
        round: 0,
        order: [],
        pos: 0,
      },
    },
    players,
    sectors,
    intersections,
    buildings,
    ships: [],
    tradeStations: [],
    // Reserve-pile limitation (host variant): ON (default) → faithful finite pools
    // (reserve 8/type, bank 20/type) that can run dry. OFF → effectively unlimited
    // so resources never run out (the UI shows ∞ for these).
    reservePile: bagOf(cfg.reservePileLimit === false ? UNLIMITED_POOL : RESERVE_PER_TYPE),
    // The supply bank holds 20 of each resource (100 cards total). Production can
    // run a resource dry — handled in distributeProduction with a notice to all.
    supplyBank: bagOf(cfg.reservePileLimit === false ? UNLIMITED_POOL : 20),
    encounterDeck: shuffle(Array.from({ length: 32 }, (_, i) => i + 1)),
    encounterDiscard: [],
    config: cfg,
    log: ["Set-up phase — each player rolls for the starting position. Roll the dice!"],
    stats: {
      vpHistory: Object.fromEntries(players.map((p) => [p.id, [] as number[]])),
      resourcesGained: Object.fromEntries(players.map((p) => [p.id, 0])),
      encountersFaced: Object.fromEntries(players.map((p) => [p.id, 0])),
      piratesDefeated: Object.fromEntries(players.map((p) => [p.id, 0])),
      icePlanetsTerraformed: Object.fromEntries(players.map((p) => [p.id, 0])),
      tradesCompleted: Object.fromEntries(players.map((p) => [p.id, 0])),
      distanceFlown: Object.fromEntries(players.map((p) => [p.id, 0])),
    },
  };
  recomputeVp(state);
  return state;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
