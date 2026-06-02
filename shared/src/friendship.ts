// Friendship-card powers for the four outpost civilizations.
//
// Cards are identified by namespaced string ids ("greenFolk:fuel",
// "scientists:boosters", ...) stored on PlayerState.friendshipCards. The
// engine queries the helpers below at each trigger point (production, shake,
// discard threshold, trade ratio) so a player's collected cards passively
// change the rules in their favor.

import { DISCARD_LIMIT, DISCARD_LIMIT_REDUCED_TRIBUTE } from "./constants.js";
import { RESOURCES, type AlienCiv, type PlayerState, type Resource } from "./types.js";

type Rng = () => number;

export interface FriendshipCardDef {
  id: string;
  civ: AlienCiv;
  name: string;
  text: string;
}

/** Every grantable friendship card, grouped by civ. Travelers are encounter-only. */
export const FRIENDSHIP_CARDS: FriendshipCardDef[] = [
  // Green Folk — Production Increase: +1 of a resource type when it's produced.
  ...RESOURCES.map((r) => ({
    id: `greenFolk:${r}`,
    civ: "greenFolk" as AlienCiv,
    name: "Production Increase",
    text: `When your colonies produce ${r}, gain 1 extra ${r}.`,
  })),
  // Scientists — Improved Upgrades: virtual boosters / cannons.
  {
    id: "scientists:boosters",
    civ: "scientists",
    name: "Improved Boosters",
    text: "Your ships gain +2 speed (as if you had 2 extra boosters).",
  },
  {
    id: "scientists:cannons",
    civ: "scientists",
    name: "Improved Cannons",
    text: "Your ships gain +2 combat strength (as if you had 2 extra cannons).",
  },
  // Diplomats.
  {
    id: "diplomats:reducedTribute",
    civ: "diplomats",
    name: "Reduced Tribute",
    text: "You only discard on a 7 if you hold more than 12 resource cards.",
  },
  {
    id: "diplomats:fameForSale",
    civ: "diplomats",
    name: "Fame for Sale",
    text: "Once per turn you may pay 1 goods for 1 fame medal piece.",
  },
  {
    id: "diplomats:helpingHand",
    civ: "diplomats",
    name: "A Helping Hand",
    text: "On your production, draw 1 random card from up to 2 richer opponents.",
  },
  {
    id: "diplomats:galacticRelief",
    civ: "diplomats",
    name: "Galactic Relief Fund",
    text: "If production gives you nothing (not on a 7), take 1 resource of choice.",
  },
  // Merchants — better trade ratios per resource. Goods are already 2:1
  // normally, so their Trade Advantage improves them all the way to 1:1.
  ...RESOURCES.map((r) => ({
    id: `merchants:${r}`,
    civ: "merchants" as AlienCiv,
    name: "Trade Advantage",
    text:
      r === "goods"
        ? "Trade goods with the supply at 1:1."
        : `Trade ${r} with the supply at 2:1.`,
  })),
];

const CARDS_BY_CIV = new Map<AlienCiv, FriendshipCardDef[]>();
for (const c of FRIENDSHIP_CARDS) {
  const list = CARDS_BY_CIV.get(c.civ) ?? [];
  list.push(c);
  CARDS_BY_CIV.set(c.civ, list);
}

const has = (p: PlayerState, id: string): boolean => p.friendshipCards.includes(id);

/** Speed/combat bonus from Scientist "Improved Upgrades" cards. */
export function scientistBonus(p: PlayerState): { speed: number; combat: number } {
  return {
    speed: has(p, "scientists:boosters") ? 2 : 0,
    combat: has(p, "scientists:cannons") ? 2 : 0,
  };
}

/** Resources for which this player has a Green Folk production bonus. */
export function greenFolkResources(p: PlayerState): Set<Resource> {
  const set = new Set<Resource>();
  for (const r of RESOURCES) if (has(p, `greenFolk:${r}`)) set.add(r);
  return set;
}

/** Discard threshold on a 7 (12 with Diplomat Reduced Tribute, else 7). */
export function diplomatDiscardLimit(p: PlayerState): number {
  return has(p, "diplomats:reducedTribute") ? DISCARD_LIMIT_REDUCED_TRIBUTE : DISCARD_LIMIT;
}

/**
 * Supply trade ratio for giving `r` (rulebook §Trade With the Supply):
 *   - Goods are special — 2:1 normally; the Merchant "Trade Advantage" for goods
 *     improves them to 1:1.
 *   - Every other resource is 3:1 normally; 2:1 with the matching Merchant card.
 */
export function tradeRatioFor(p: PlayerState, r: Resource): number {
  const merchant = has(p, `merchants:${r}`);
  if (r === "goods") return merchant ? 1 : 2;
  return merchant ? 2 : 3;
}

export const hasCard = has;

/** The set of friendship-card ids already held by ANY player (P6g: cards are
 *  physical and unique — once one is taken nobody else can draw the same one). */
export function claimedFriendshipCards(players: readonly PlayerState[]): Set<string> {
  const set = new Set<string>();
  for (const p of players) for (const id of p.friendshipCards) set.add(id);
  return set;
}

/**
 * Pick the most useful not-yet-held card from a civ; returns its id or null.
 * `claimed` excludes cards already taken by other players (global uniqueness, P6g).
 */
export function pickFriendshipCard(
  p: PlayerState,
  civ: AlienCiv,
  rng: Rng,
  claimed: ReadonlySet<string> = new Set(),
): string | null {
  const pool = (CARDS_BY_CIV.get(civ) ?? []).filter((c) => !has(p, c.id) && !claimed.has(c.id));
  if (pool.length === 0) return null;
  return pool[Math.floor(rng() * pool.length)]!.id;
}

/**
 * Friendship-card ids from a civ the player can still take: not already held by
 * them and not already claimed by any other player (P6g global uniqueness).
 */
export function availableFriendshipCards(
  p: PlayerState,
  civ: AlienCiv,
  claimed: ReadonlySet<string> = new Set(),
): string[] {
  return (CARDS_BY_CIV.get(civ) ?? [])
    .filter((c) => !has(p, c.id) && !claimed.has(c.id))
    .map((c) => c.id);
}

/** Look up a friendship card definition by id. */
export function friendshipCardById(id: string): FriendshipCardDef | undefined {
  return FRIENDSHIP_CARDS.find((c) => c.id === id);
}
