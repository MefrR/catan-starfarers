import type { Resource, ResourceBag, UpgradeKind, PlayerColor } from "./types.js";

/** Build costs (resources paid to supply). Source: rulebook p.5-6. */
export const BUILD_COSTS = {
  colonyShip: { ore: 1, fuel: 1, carbon: 1, food: 1 } as Partial<ResourceBag>,
  tradeShip: { ore: 1, fuel: 1, goods: 2 } as Partial<ResourceBag>,
  spaceport: { carbon: 3, food: 2 } as Partial<ResourceBag>,
  cannon: { carbon: 2 } as Partial<ResourceBag>,
  freightPod: { ore: 2 } as Partial<ResourceBag>,
  booster: { fuel: 2 } as Partial<ResourceBag>,
} as const;

/** Victory point values. */
export const VP = {
  colony: 1,
  spaceport: 2, // total; net +1 when upgrading a colony
  friendshipMarker: 2,
  pirateBaseToken: 1,
  icePlanetToken: 1,
  fameMedalPair: 1, // 2 fame medal pieces = 1 VP
  startingTotal: 4, // 2 colonies + 1 spaceport
} as const;

export const DEFAULT_TARGET_VP = 15;
/** Host-selectable victory-point target range (inclusive). */
export const VP_MIN = 12;
export const VP_MAX = 25;

/** Friendly Bandit: a 7 can't steal from a player with fewer than this many VP. */
export const FRIENDLY_ROBBER_VP = 3;

/** Bot pacing presets (ms between AI actions), keyed by config.botSpeed. */
export type BotSpeed = "relaxed" | "normal" | "fast";
export const BOT_SPEED_MS: Record<BotSpeed, number> = {
  relaxed: 1500,
  normal: 800,
  fast: 120,
};

/** Max upgrades attachable to a mothership. */
export const MAX_UPGRADES: Record<UpgradeKind, number> = {
  booster: 6,
  cannon: 6,
  freightPod: 5,
};

/** Total upgrade pieces in the box (shared supply across players). */
export const UPGRADE_SUPPLY: Record<UpgradeKind, number> = {
  freightPod: 20,
  cannon: 24,
  booster: 24,
};

/** Per-player piece counts (per color). Source: almanac components list. */
export const PLAYER_PIECES = {
  colonies: 9,
  tradeStations: 7,
  transportShips: 3,
  shipyards: 3,
} as const;

/** Resource cards per type in the full deck. */
export const RESOURCE_CARDS_PER_TYPE = 20;

/** Cards taken from each stack to form the reserve pile at setup. */
export const RESERVE_PER_TYPE = 8;

/** Free reserve-pile cards the active roller draws, by current VP. */
export function reserveDrawForVP(vp: number): number {
  if (vp <= 7) return 2; // 4-7 VP
  if (vp <= 9) return 1; // 8-9 VP
  return 0; // 10+ VP
}

/** Discard threshold when a 7 is rolled (discard half if hand > 7). */
export const DISCARD_LIMIT = 7;

/** Hand size requiring discard with Diplomat "Reduced Tribute" card. */
export const DISCARD_LIMIT_REDUCED_TRIBUTE = 12;

export const PLAYER_COLORS: PlayerColor[] = ["yellow", "red", "blue", "black", "green", "white"];

/** 2d6 roll frequency (out of 36) for probability display. */
export const ROLL_FREQUENCY: Record<number, number> = {
  2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 5, 9: 4, 10: 3, 11: 2, 12: 1,
};

export const OUTPOST_DOCKS = 5;

/** Base speed after an encounter is always 3. */
export const POST_ENCOUNTER_BASE_SPEED = 3;

export const RESOURCE_LABEL: Record<Resource, string> = {
  ore: "Ore",
  fuel: "Fuel",
  carbon: "Carbon",
  food: "Food",
  goods: "Goods",
};
