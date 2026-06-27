// Pure rules engine for Catan: Starfarers.
//
// applyIntent(state, playerId, intent) -> { state, error? } is a pure reducer:
// it deep-clones the input, mutates the clone, and returns it. The same engine
// runs locally for single-player (human + AI both emit intents) and will run
// server-side for LAN multiplayer — only the transport differs.

import {
  BALL_VALUE,
  MOTHERSHIP_BALLS,
  PLANET_RESOURCE,
  RESOURCES,
  type BallColor,
  type GameState,
  type GameStats,
  type Planet,
  type PlayerState,
  type Resource,
  type ResourceBag,
  type Sector,
  type Ship,
  type ShipKind,
  type UpgradeKind,
  type TurnPhase,
  type AlienCiv,
} from "./types.js";
import {
  BUILD_COSTS,
  FRIENDLY_ROBBER_VP,
  MAX_UPGRADES,
  OUTPOST_DOCKS,
  POST_ENCOUNTER_BASE_SPEED,
  UPGRADE_SUPPLY,
  VP,
  reserveDrawForVP,
} from "./constants.js";
import {
  scientistBonus,
  greenFolkResources,
  diplomatDiscardLimit,
  tradeRatioFor,
  hasCard,
  availableFriendshipCards,
  claimedFriendshipCards,
  FRIENDSHIP_CARDS,
} from "./friendship.js";
import {
  beginEncounter,
  resolveEncounter,
  confirmAllPlayerEncounter,
  encounterShake,
  ENCOUNTER_CARDS,
} from "./encounters.js";
import type { ClientIntent, DevAction } from "./protocol.js";

export type Rng = () => number;

export interface IntentResult {
  state: GameState;
  error?: string;
}

const clone = (s: GameState): GameState =>
  typeof structuredClone === "function"
    ? structuredClone(s)
    : (JSON.parse(JSON.stringify(s)) as GameState);

const fail = (state: GameState, error: string): IntentResult => ({ state, error });

function handTotal(p: PlayerState): number {
  return RESOURCES.reduce((sum, r) => sum + p.hand[r], 0);
}

function rollDie(rng: Rng): number {
  return 1 + Math.floor(rng() * 6);
}

/**
 * Produce the next [d1, d2] for a production roll. With the Deck-of-36 variant on
 * (config.deck36Dice), draw from a deck containing every one of the 36 (d1,d2)
 * combinations exactly once — so over a full cycle the number distribution is
 * perfectly even (no long droughts or streaks). Otherwise roll two fair dice.
 */
function nextDice(state: GameState, rng: Rng): [number, number] {
  if (!state.config.deck36Dice) return [rollDie(rng), rollDie(rng)];
  if (!state.diceDeck || state.diceDeck.length === 0) {
    // Fresh shuffled deck of codes 0..35 (code = (d1-1)*6 + (d2-1)).
    const deck = Array.from({ length: 36 }, (_, i) => i);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    state.diceDeck = deck;
  }
  const code = state.diceDeck.pop()!;
  return [Math.floor(code / 6) + 1, (code % 6) + 1];
}

/** Friendly Bandit was removed as a variant (playtest #62): a 7 may now steal
 *  from any player who holds cards, regardless of VP. Kept as a function so all
 *  call sites stay unchanged; the deprecated config flag is ignored. */
function canStealFrom(_state: GameState, _p: PlayerState): boolean {
  return true;
}

/** Move `n` of resource `r` from bank into a hand, clamped to what the bank has. */
function payFromBank(bank: ResourceBag, hand: ResourceBag, r: Resource, n: number): number {
  const got = Math.min(n, bank[r]);
  bank[r] -= got;
  hand[r] += got;
  return got;
}

/** Draw `n` random resource cards from a face-down pile (weighted by counts). */
function drawRandom(pile: ResourceBag, hand: ResourceBag, n: number, rng: Rng): number {
  let drawn = 0;
  for (let i = 0; i < n; i++) {
    const avail = RESOURCES.filter((r) => pile[r] > 0);
    if (avail.length === 0) break;
    const total = avail.reduce((s, r) => s + pile[r], 0);
    let pick = Math.floor(rng() * total);
    let chosen: Resource = avail[0]!;
    for (const r of avail) {
      if (pick < pile[r]) {
        chosen = r;
        break;
      }
      pick -= pile[r];
    }
    pile[chosen]--;
    hand[chosen]++;
    drawn++;
  }
  return drawn;
}

function activePlayer(state: GameState): PlayerState {
  return state.players[state.phaseState.activePlayerIndex]!;
}

function log(state: GameState, line: string): void {
  state.log.push(line);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

// --- Cost / VP helpers --------------------------------------------------------

type Cost = Partial<ResourceBag>;

function canAfford(hand: ResourceBag, cost: Cost): boolean {
  return RESOURCES.every((r) => hand[r] >= (cost[r] ?? 0));
}

function pay(hand: ResourceBag, bank: ResourceBag, cost: Cost): void {
  for (const r of RESOURCES) {
    const n = cost[r] ?? 0;
    hand[r] -= n;
    bank[r] += n;
  }
}

/** Spaceport-site intersections for a player where a new ship can spawn (no ship there). */
/** Open space points a player can launch a new ship onto: the unoccupied
 *  intersections directly adjacent to each of their spaceports (left/right of
 *  the dock), never the spaceport's own site. */
export function shipLaunchSites(player: PlayerState, state: GameState): string[] {
  const out = new Set<string>();
  for (const b of state.buildings) {
    if (b.kind !== "spaceport" || b.owner !== player.id) continue;
    const inter = state.intersections[b.intersectionId];
    if (!inter) continue;
    for (const nb of inter.neighbors) {
      const nbInter = state.intersections[nb];
      // The shared center of a 3-planet system (adjacent to 3 planets) is a
      // move-through point only — no piece, not even a ship, may be built there.
      if (nbInter && nbInter.adjacentPlanets.length >= 3) continue;
      if (!isOccupied(state, nb)) out.add(nb);
    }
  }
  return [...out].sort();
}

// --- Set-up phase helpers -----------------------------------------------------

/** Planet ids belonging to the Catanian Colonies (home) systems. */
function homePlanetIds(state: GameState): Set<string> {
  const ids = new Set<string>();
  for (const sec of state.sectors) {
    if (!sec.home) continue;
    for (const p of sec.planets) ids.add(p.id);
  }
  return ids;
}

/** Unoccupied colony sites within the Catanian Colonies (edges between 2 home planets). */
export function catanianColonySites(state: GameState): string[] {
  const homeIds = homePlanetIds(state);
  const taken = new Set(state.buildings.map((b) => b.intersectionId));
  return Object.values(state.intersections)
    .filter(
      (inter) =>
        inter.adjacentPlanets.length === 2 &&
        inter.adjacentPlanets.every((pid) => homeIds.has(pid)) &&
        !taken.has(inter.id),
    )
    .map((inter) => inter.id)
    .sort();
}

/** Seat order for a set-up round: odd rounds clockwise, even rounds counter-clockwise. */
function setupRoundOrder(round: number, start: number, n: number): number[] {
  const cw = Array.from({ length: n }, (_, i) => (start + i) % n);
  return round % 2 === 1 ? cw : [...cw].reverse();
}

/** Point activePlayerIndex at whoever the set-up state currently awaits. */
function syncSetupActive(state: GameState): void {
  const su = state.phaseState.setup;
  if (!su) return;
  const idx = su.order[su.pos];
  if (idx != null) state.phaseState.activePlayerIndex = idx;
}

/** Deal starting hands + fame medal pieces and begin the first production. */
function finishSetup(state: GameState, rng: Rng): void {
  const su = state.phaseState.setup!;
  for (const p of state.players) {
    drawRandom(state.reservePile, p.hand, 3, rng);
    p.fameMedalPieces += 1;
  }
  const start = su.startPlayerIndex ?? 0;
  state.phaseState.setup = undefined;
  state.phaseState.phase = "production";
  state.phaseState.activePlayerIndex = start;
  // Clear the dice left over from the roll-for-order step. The production roll
  // button (and the turn-timer auto-roll) only fire when lastRoll is empty, so
  // a stale value here would make the very first roll of the game do nothing —
  // freezing the table on turn one. (Regular turns are cleared by endTurn.)
  state.phaseState.lastRoll = undefined;
  recomputeVp(state);
  log(
    state,
    `Set-up complete. Each Starfarer drew 3 resources and 1 fame medal piece. ${state.players[start]!.name} begins — roll for production!`,
  );
}

/** Advance set-up after a player finishes their action for the current round. */
function advanceSetup(state: GameState, rng: Rng): void {
  const su = state.phaseState.setup!;
  su.pos += 1;
  if (su.pos < su.order.length) {
    if (su.round === 4) su.r4step = "upgrade";
    syncSetupActive(state);
    return;
  }
  // Round complete.
  if (su.round >= 4) {
    finishSetup(state, rng);
    return;
  }
  su.round += 1;
  su.pos = 0;
  su.order = setupRoundOrder(su.round, su.startPlayerIndex ?? 0, state.players.length);
  if (su.round === 4) {
    su.bonusPool = ["booster", "booster", "cannon", "freightPod"];
    su.r4step = "upgrade";
  }
  syncSetupActive(state);
}

/** Recompute every player's VP from board state — the single source of truth. */
export function recomputeVp(state: GameState): void {
  for (const p of state.players) {
    let vp = 0;
    for (const b of state.buildings) {
      if (b.owner !== p.id) continue;
      vp += b.kind === "spaceport" ? VP.spaceport : VP.colony;
    }
    // Trade stations are NOT worth VP themselves — they earn a friendship card
    // and (when you hold the most at an outpost) its +2 VP friendship marker.
    vp += p.friendshipMarkers.length * VP.friendshipMarker;
    vp += p.victoryMedals; // pirate-base / ice-planet conquest medals
    vp += Math.floor(p.fameMedalPieces / 2) * VP.fameMedalPair;
    p.victoryPoints = vp;
  }

  // Immediate victory (P6j): the instant any player reaches the target the game
  // stops — we don't wait for the current turn to finish. Recompute runs after
  // every mutation, so a colony/marker/medal that crosses 15 ends play at once.
  // Setup is exempt (players hold their starting points before play begins).
  if (state.phaseState.phase !== "gameOver" && state.phaseState.phase !== "setup") {
    const target = state.config.targetVictoryPoints;
    let champ: PlayerState | null = null;
    for (const p of state.players) {
      if (p.victoryPoints < target) continue;
      // Tie-break toward the active player, else highest VP.
      if (!champ || p.id === activePlayer(state).id || p.victoryPoints > champ.victoryPoints) {
        champ = p;
      }
    }
    if (champ) {
      state.phaseState.phase = "gameOver";
      state.phaseState.winner = champ.id;
      log(state, `${champ.name} reached ${champ.victoryPoints} VP and wins the game!`);
    }
  }
}

/** Effective cannon strength = cannons on the mothership + Scientist combat bonus. */
function cannonStrength(p: PlayerState): number {
  return p.upgrades.cannon + scientistBonus(p).combat;
}

/** Find a planet by id across all sectors. */
function findPlanet(state: GameState, pid: string): Planet | undefined {
  for (const sector of state.sectors) {
    const planet = sector.planets.find((pl) => pl.id === pid);
    if (planet) return planet;
  }
  return undefined;
}

/**
 * How short a player is of clearing a planet's special token (rulebook §Pirate
 * Bases and Ice Planets): pirate base needs cannons ≥ value, ice planet needs
 * freight pods ≥ value. Returns { gap, need } where gap === 0 means clearable.
 */
function specialGap(
  player: PlayerState,
  planet: Planet,
): { gap: number; need: "cannon" | "freightPod" } | null {
  if (planet.special === "pirateBase") {
    const value = planet.specialValue ?? 0;
    return { gap: Math.max(0, value - cannonStrength(player)), need: "cannon" };
  }
  if (planet.special === "icePlanet") {
    const value = planet.specialValue ?? 0;
    return { gap: Math.max(0, value - player.upgrades.freightPod), need: "freightPod" };
  }
  return null;
}

/**
 * Why a colony ship parked at `intersectionId` cannot establish a colony there
 * right now (pirate base / ice planet not yet clearable). Returns a human-readable
 * reason, or null if the site is settle-able. The HUD uses this to grey the
 * "Establish Colony" button and show a notification (R12); the actual rule is
 * still enforced in `doEstablishColony`.
 */
export function colonyEstablishBlock(
  state: GameState,
  player: PlayerState,
  intersectionId: string,
): string | null {
  const inter = state.intersections[intersectionId];
  if (!inter) return null;
  for (const pid of inter.adjacentPlanets) {
    const planet = findPlanet(state, pid);
    if (!planet || planet.special === "none") continue;
    const req = specialGap(player, planet);
    if (!req || req.gap <= 0) continue;
    return planet.special === "pirateBase"
      ? `A pirate base (strength ${planet.specialValue}) blocks this site — you need ${req.gap} more cannon${req.gap === 1 ? "" : "s"} to defeat it before settling.`
      : `An ice planet (terraform ${planet.specialValue}) blocks this site — you need ${req.gap} more freight pod${req.gap === 1 ? "" : "s"} to terraform it before settling.`;
  }
  return null;
}

/** Z2: best-effort stat bump — `stats` is optional on states saved before it existed. */
function bumpStat(
  state: GameState,
  key: Exclude<keyof GameStats, "vpHistory">,
  playerId: string,
  n = 1,
): void {
  const s = state.stats;
  if (!s) return;
  s[key][playerId] = (s[key][playerId] ?? 0) + n;
}

/**
 * Execute a player-to-player swap (proposer gives `give`, receives `want`),
 * clear the pending offer and record it. Returns an error string if the deal is
 * invalid (one-sided, same-for-same, or either side can no longer cover it).
 * Shared by `finalizeTrade` (proposer accepts a counter) and `respondTrade`
 * (a plain accept settles immediately so the trade window closes by itself).
 */
function settleTrade(
  state: GameState,
  proposer: PlayerState,
  partner: PlayerState,
  give: Partial<Record<Resource, number>>,
  want: Partial<Record<Resource, number>>,
): string | undefined {
  const gTot = RESOURCES.reduce((s, r) => s + (give[r] ?? 0), 0);
  const wTot = RESOURCES.reduce((s, r) => s + (want[r] ?? 0), 0);
  if (gTot === 0 || wTot === 0) return "A trade must give and want something — no one-sided gifts.";
  for (const r of RESOURCES) {
    if ((give[r] ?? 0) > 0 && (want[r] ?? 0) > 0)
      return "A trade can't swap a resource for the same resource.";
  }
  for (const r of RESOURCES) {
    if ((give[r] ?? 0) > proposer.hand[r]) return "You can no longer cover that offer.";
    if ((want[r] ?? 0) > partner.hand[r]) return "They can no longer cover that offer.";
  }
  for (const r of RESOURCES) {
    const g = give[r] ?? 0;
    const w = want[r] ?? 0;
    proposer.hand[r] -= g;
    partner.hand[r] += g;
    partner.hand[r] -= w;
    proposer.hand[r] += w;
  }
  state.phaseState.pendingTrade = undefined;
  state.phaseState.lastTrade = { fromId: proposer.id, toId: partner.id, seq: (state.phaseState.lastTrade?.seq ?? 0) + 1 };
  log(state, `${proposer.name} and ${partner.name} completed a trade.`);
  bumpStat(state, "tradesCompleted", proposer.id);
  bumpStat(state, "tradesCompleted", partner.id);
  return undefined;
}

/** Clear a special token: flip it to a +1 VP conquest medal and assign a number. */
function clearSpecial(
  state: GameState,
  player: PlayerState,
  planet: Planet,
  intersectionId: string,
  rng: Rng,
): void {
  const wasPirate = planet.special === "pirateBase";
  planet.special = "none";
  player.victoryMedals += 1;
  bumpStat(state, wasPirate ? "piratesDefeated" : "icePlanetsTerraformed", player.id);
  if (planet.number == null) planet.number = [3, 4, 5, 9, 10, 11][Math.floor(rng() * 6)]!;
  // Signal the client to fly the token + VP medal from the planet to the player.
  state.phaseState.lastClearedSpecial = {
    playerId: player.id,
    kind: wasPirate ? "pirateBase" : "icePlanet",
    intersectionId,
    seq: (state.phaseState.lastClearedSpecial?.seq ?? 0) + 1,
  };
  log(
    state,
    wasPirate
      ? `${player.name} freed a planet from pirates! +1 VP medal.`
      : `${player.name} terraformed an ice planet! +1 VP medal.`,
  );
}

function isOccupied(state: GameState, intersectionId: string): boolean {
  if (state.buildings.some((b) => b.intersectionId === intersectionId)) return true;
  if (state.ships.some((s) => s.intersectionId === intersectionId)) return true;
  return false;
}

// --- Production phase ---

function doProduction(state: GameState, rng: Rng): void {
  const [d1, d2] = nextDice(state, rng);
  const sum = d1 + d2;
  state.phaseState.lastRoll = [d1, d2];
  state.phaseState.rollCount = (state.phaseState.rollCount ?? 0) + 1;
  state.phaseState.lastProduction = [];
  const roller = activePlayer(state);
  log(state, `${roller.name} rolled ${d1} + ${d2} = ${sum}.`);

  if (sum === 7) {
    // A 7: over-limit players discard half; every other player draws 1 card from
    // the bank; then the roller picks an opponent to steal 1 card from.
    const pending: Record<string, number> = {};
    for (const p of state.players) {
      const limit = diplomatDiscardLimit(p);
      const total = handTotal(p);
      if (total > limit) pending[p.id] = Math.floor(total / 2);
    }
    if (Object.keys(pending).length > 0) {
      state.phaseState.pendingDiscards = pending;
      log(state, "A 7 — over-limit players must discard half their cards.");
    }
    // Every NON-roller draws 1 card from the bank — but only AFTER the roller's
    // steal (and any discards) resolve, so the stealer takes a card from a
    // player and never also draws one from the bank. Flag it; resolved below or
    // in stealTarget / discard.
    state.phaseState.pendingSevenBank = true;
    // Roller will choose an opponent to steal from (if any eligible opponent
    // holds cards). Friendly Bandit excludes players under 3 VP.
    if (state.players.some((p) => p.id !== roller.id && handTotal(p) > 0 && canStealFrom(state, p))) {
      state.phaseState.awaitingSteal = true;
      log(state, `${roller.name} may steal 1 card from a player.`);
    }
  } else {
    distributeProduction(state, sum, rng);
  }

  // The active roller draws free reserve-pile cards based on VP (the catch-up
  // bonus) on EVERY roll, including a 7. On a 7 it's deferred until the steal /
  // discards resolve, then fires (in stealTarget / discard).
  const draws = reserveDrawForVP(roller.victoryPoints);
  const deferred = state.phaseState.awaitingSteal || !!state.phaseState.pendingDiscards;
  if (deferred) {
    if (draws > 0) state.phaseState.pendingReserveDraw = { playerId: roller.id, count: draws };
  } else {
    // Nothing to wait on (e.g. a 7 with no one to steal from / no discards):
    // hand out the others' bank cards now, then the roller's reserve bonus.
    giveSevenBankCards(state, rng);
    if (draws > 0) drawReserveBonus(state, rng);
  }

  state.phaseState.phase = "tradeBuild";
}

/** Give every NON-roller 1 card from the bank after a 7 (deferred so it lands
 *  after the steal). The roller is excluded — they take a card via the steal. */
function giveSevenBankCards(state: GameState, rng: Rng): void {
  if (!state.phaseState.pendingSevenBank) return;
  state.phaseState.pendingSevenBank = false;
  const rollerId = activePlayer(state).id;
  for (const p of state.players) {
    if (p.id === rollerId) continue;
    const got = drawRandom(state.supplyBank, p.hand, 1, rng);
    if (got > 0) log(state, `${p.name} drew 1 card from the bank (a 7 was rolled).`);
  }
}

/** Draw the active roller's owed reserve-pile bonus cards (after a 7's steal). */
function drawReserveBonus(state: GameState, rng: Rng): void {
  const pending = state.phaseState.pendingReserveDraw;
  const playerId = pending?.playerId ?? activePlayer(state).id;
  const count = pending?.count ?? reserveDrawForVP(activePlayer(state).victoryPoints);
  const player = state.players.find((p) => p.id === playerId);
  state.phaseState.pendingReserveDraw = undefined;
  if (!player || count <= 0) return;
  const before: ResourceBag = { ...player.hand };
  const got = drawRandom(state.reservePile, player.hand, count, rng);
  if (got > 0) {
    const gains: Partial<ResourceBag> = {};
    for (const r of RESOURCES) {
      const d = player.hand[r] - before[r];
      if (d > 0) gains[r] = d;
    }
    const seq = (state.phaseState.reserveDraw?.seq ?? 0) + 1;
    state.phaseState.reserveDraw = { playerId: player.id, gains, seq };
    log(state, `${player.name} drew ${got} card(s) from the reserve.`);
  }
}

/** A planet numbered 2 also produces on 11, and a planet numbered 3 also on 12
 *  (the rare 2/3/11/12 rolls are paired so those planets fire twice as often). */
function producesOn(planetNumber: number | null, rolled: number): boolean {
  if (planetNumber == null) return false;
  if (planetNumber === 2) return rolled === 2 || rolled === 11;
  if (planetNumber === 3) return rolled === 3 || rolled === 12;
  return planetNumber === rolled;
}

function distributeProduction(state: GameState, rolled: number, rng: Rng): void {
  const planetById = new Map<string, { color: string; rolled: boolean }>();
  for (const sector of state.sectors) {
    for (const planet of sector.planets) {
      if (planet.special !== "none") continue; // pirate base / ice planet block production
      planetById.set(planet.id, {
        color: planet.color,
        rolled: planet.explored && producesOn(planet.number, rolled),
      });
    }
  }

  const playerById = new Map(state.players.map((p) => [p.id, p]));
  const producedAny = new Set<string>();
  const shortfall = new Set<Resource>();
  const gains: string[] = [];
  state.phaseState.productionShortfall = undefined;
  for (const b of state.buildings) {
    const inter = state.intersections[b.intersectionId];
    if (!inter) continue;
    const owner = playerById.get(b.owner);
    if (!owner) continue;
    const yieldPer = b.kind === "spaceport" ? 2 : 1;
    const greenFolk = greenFolkResources(owner);
    for (const pid of inter.adjacentPlanets) {
      const info = planetById.get(pid);
      if (!info || !info.rolled) continue;
      const res = PLANET_RESOURCE[info.color as keyof typeof PLANET_RESOURCE];
      const bonus = greenFolk.has(res) ? 1 : 0;
      const got = payFromBank(state.supplyBank, owner.hand, res, yieldPer + bonus);
      if (got < yieldPer) shortfall.add(res); // the bank ran dry on this resource
      if (got > 0) {
        // Of what was actually paid, the amount above the base yield is the
        // Green Folk bonus (P6h) — the HUD flies those from the friendship card.
        const bonusGot = bonus > 0 ? Math.max(0, got - yieldPer) : 0;
        gains.push(`${owner.name} +${got} ${res}`);
        producedAny.add(owner.id);
        bumpStat(state, "resourcesGained", owner.id, got);
        state.phaseState.lastProduction!.push({
          owner: owner.id,
          intersectionId: b.intersectionId,
          resource: res,
          amount: got,
          bonus: bonusGot,
        });
      }
    }
  }

  // Diplomat "Galactic Relief Fund": a player who produced nothing takes 1 of choice.
  for (const p of state.players) {
    if (!producedAny.has(p.id) && hasCard(p, "diplomats:galacticRelief")) {
      const r = RESOURCES.find((x) => state.supplyBank[x] > 0);
      if (r) {
        state.supplyBank[r]--;
        p.hand[r]++;
        gains.push(`${p.name} +1 ${r} (relief fund)`);
      }
    }
  }

  // Diplomat "A Helping Hand": on the active player's production they draw 1
  // random card from up to 2 richer opponents (opponents with a larger hand).
  const roller = activePlayer(state);
  if (hasCard(roller, "diplomats:helpingHand")) {
    const richer = state.players
      .filter((o) => o.id !== roller.id && handTotal(o) > handTotal(roller))
      .sort((a, b) => handTotal(b) - handTotal(a))
      .slice(0, 2);
    for (const victim of richer) {
      const avail = RESOURCES.filter((r) => victim.hand[r] > 0);
      if (avail.length === 0) continue;
      const r = avail[Math.floor(rng() * avail.length)]!;
      victim.hand[r]--;
      roller.hand[r]++;
      gains.push(`${roller.name} takes 1 ${r} from ${victim.name} (helping hand)`);
    }
  }

  if (gains.length) log(state, `Production: ${gains.join(", ")}.`);
  else log(state, "Production: nobody produced on this number.");

  // If the bank ran out of a resource that was owed this roll, tell everyone.
  if (shortfall.size) {
    state.phaseState.productionShortfall = [...shortfall];
    for (const r of shortfall) log(state, `The bank is out of ${r} — that production was lost.`);
  }
}

// --- Flight phase ---

function shipSpeed(state: GameState): number {
  if (state.phaseState.moveBudget != null) return state.phaseState.moveBudget;
  return state.phaseState.shake?.speed ?? 0;
}

function doShake(state: GameState, rng: Rng): void {
  const bag = [...MOTHERSHIP_BALLS];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  const balls: [BallColor, BallColor] = [bag[0]!, bag[1]!];
  const who = activePlayer(state);
  const bonus = scientistBonus(who);
  const hasEncounter = balls.includes("black");
  const baseSpeed = hasEncounter
    ? POST_ENCOUNTER_BASE_SPEED
    : BALL_VALUE[balls[0]] + BALL_VALUE[balls[1]];
  const speed = baseSpeed + who.upgrades.booster + bonus.speed;
  const combat = BALL_VALUE[balls[0]] + BALL_VALUE[balls[1]] + who.upgrades.cannon + bonus.combat;
  state.phaseState.shake = { balls, speed, combat, encounter: hasEncounter };
  state.phaseState.shakeCount = (state.phaseState.shakeCount ?? 0) + 1;
  log(
    state,
    `${who.name} shook the mothership: ${balls.join(" + ")} (speed ${speed}${hasEncounter ? ", encounter!" : ""}).`,
  );

  if (hasEncounter) {
    // Post-encounter base speed is set when the encounter resolves.
    beginEncounter(state, who.id, rng);
  } else {
    state.phaseState.moveBudget = speed;
  }
}

/**
 * When a ship reaches an intersection, reveal the ENTIRE planetary system (sector)
 * of any adjacent planet — not just the single touched planet (fog-map rule N4) —
 * and "discover" any outpost the intersection docks to so its alliance art shows.
 */
/** #25: would moving ONTO this intersection make first contact with an unknown
 *  sector (an undiscovered sector / unexplored planet adjacent to it)? Used to
 *  force a ship to stop the moment it reaches an unexplored system. Mirrors the
 *  touched-sector logic in revealAround, but only reports whether anything new
 *  would be revealed. */
function wouldRevealSomething(state: GameState, intersectionId: string): boolean {
  const inter = state.intersections[intersectionId];
  if (!inter) return false;
  const sectors = new Set<Sector>();
  for (const pid of inter.adjacentPlanets) {
    for (const sector of state.sectors) {
      if (sector.planets.some((pl) => pl.id === pid)) sectors.add(sector);
    }
  }
  if (inter.dockingPointOf) {
    for (const sector of state.sectors) if (sector.id === inter.dockingPointOf) sectors.add(sector);
  }
  if (inter.revealsSectors) {
    for (const sid of inter.revealsSectors) {
      for (const sector of state.sectors) if (sector.id === sid) sectors.add(sector);
    }
  }
  for (const sector of sectors) {
    if (!sector.discovered) return true;
    if (sector.planets.some((pl) => !pl.explored)) return true;
  }
  return false;
}

function revealAround(state: GameState, intersectionId: string, rng: Rng): void {
  const inter = state.intersections[intersectionId];
  if (!inter) return;
  const opts = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];
  const touchedSectors = new Set<Sector>();
  // Any sector that owns an adjacent planet -> reveal the whole system.
  for (const pid of inter.adjacentPlanets) {
    for (const sector of state.sectors) {
      if (sector.planets.some((pl) => pl.id === pid)) touchedSectors.add(sector);
    }
  }
  // Docking to an outpost discovers that outpost sector too.
  if (inter.dockingPointOf) {
    for (const sector of state.sectors) {
      if (sector.id === inter.dockingPointOf) touchedSectors.add(sector);
    }
  }
  // Approaching a disguised "???" outpost (any corner of its triangle) charts it.
  if (inter.revealsSectors) {
    for (const sid of inter.revealsSectors) {
      for (const sector of state.sectors) {
        if (sector.id === sid) touchedSectors.add(sector);
      }
    }
  }
  for (const sector of touchedSectors) {
    let revealedAny = false;
    if (!sector.discovered) {
      sector.discovered = true;
      revealedAny = true;
    }
    for (const planet of sector.planets) {
      if (!planet.explored) {
        planet.explored = true;
        revealedAny = true;
        if (planet.number == null) {
          planet.number = opts[Math.floor(rng() * opts.length)]!;
        }
      }
    }
    if (revealedAny) {
      const label =
        sector.kind === "outpost"
          ? `an outpost (${sector.outpostCiv ?? "alien"})`
          : sector.kind === "emptyCluster"
          ? "empty space"
          : "a planetary system";
      log(state, `${activePlayer(state).name} charted ${label}.`);
    }
  }
}

/**
 * When a player's ship sits adjacent to a pirate base / ice planet and they meet
 * the requirement (cannons / freight pods), the token is immediately cleared
 * (rulebook §Pirate Bases and Ice Planets) and becomes a +1 VP conquest medal.
 * Called on movement AND right after buying a cannon/freight pod, so a token
 * breaks the instant the requirement is met — no need to move again.
 */
function resolveAdjacentSpecials(
  state: GameState,
  player: PlayerState,
  intersectionId: string,
  rng: Rng,
): void {
  const inter = state.intersections[intersectionId];
  if (!inter) return;
  for (const pid of inter.adjacentPlanets) {
    const planet = findPlanet(state, pid);
    if (!planet || planet.special === "none") continue;
    const req = specialGap(player, planet);
    if (req && req.gap === 0) clearSpecial(state, player, planet, intersectionId, rng);
  }
}

/** Re-scan all of a player's ships and clear any special they now qualify to clear. */
function resolveSpecialsForPlayerShips(state: GameState, player: PlayerState, rng: Rng): void {
  for (const ship of state.ships) {
    if (ship.owner === player.id) resolveAdjacentSpecials(state, player, ship.intersectionId, rng);
  }
}

// --- Turn flow ---

function endTurn(state: GameState): void {
  recomputeVp(state);
  // Z2: one VP snapshot per player per completed turn — the win-screen chart.
  if (state.stats) {
    for (const p of state.players) {
      (state.stats.vpHistory[p.id] ??= []).push(p.victoryPoints);
    }
  }
  const finished = activePlayer(state);
  if (finished.victoryPoints >= state.config.targetVictoryPoints) {
    state.phaseState.phase = "gameOver";
    state.phaseState.winner = finished.id;
    log(state, `${finished.name} reached ${finished.victoryPoints} VP and wins!`);
    return;
  }
  // Reset per-turn ship movement.
  for (const s of state.ships) {
    s.movedThisTurn = false;
    s.distanceMoved = 0;
  }
  const next = (state.phaseState.activePlayerIndex + 1) % state.players.length;
  state.phaseState.activePlayerIndex = next;
  state.phaseState.phase = "production";
  state.phaseState.shake = undefined;
  state.phaseState.lastRoll = undefined;
  state.phaseState.moveBudget = undefined;
  state.phaseState.frozenShipId = undefined;
  state.phaseState.pendingTrade = undefined;
  state.phaseState.awaitingSteal = false;
  state.phaseState.pendingFriendship = undefined;
  state.phaseState.fameBoughtBy = undefined;
  state.phaseState.goodsTradeUsedBy = undefined;
  state.phaseState.tradeProposals = undefined;
  log(state, `${state.players[next]!.name}'s turn — production phase.`);
}

const PHASE_LABEL: Record<TurnPhase, string> = {
  setup: "set-up",
  production: "production",
  tradeBuild: "trade & build",
  flight: "flight",
  encounter: "encounter",
  gameOver: "game over",
};

// --- Intent handlers ----------------------------------------------------------

function doBuild(
  state: GameState,
  player: PlayerState,
  what: "colonyShip" | "tradeShip" | "spaceport" | UpgradeKind,
  targetId: string | undefined,
  rng: Rng,
): string | undefined {
  const cost = BUILD_COSTS[what];
  // A free trade ship from an encounter launches at NO resource cost (consumes a
  // free-launch credit instead of paying).
  const freeShip = what === "tradeShip" && (state.phaseState.freeTradeShips?.[player.id] ?? 0) > 0;
  if (!freeShip && !canAfford(player.hand, cost)) return "Not enough resources.";

  if (what === "colonyShip" || what === "tradeShip") {
    if (player.supply.transportShips <= 0) return "No transport ships left in your supply.";
    const sites = shipLaunchSites(player, state);
    if (sites.length === 0) return "No open space point next to a spaceport to launch from.";
    // The launch point must be an open space adjacent to one of your spaceports.
    const launch = targetId && sites.includes(targetId) ? targetId : sites[0]!;
    if (targetId && !sites.includes(targetId))
      return "Launch the ship onto an open point next to your spaceport.";
    if (freeShip) state.phaseState.freeTradeShips![player.id]!--;
    else pay(player.hand, state.supplyBank, cost);
    player.supply.transportShips--;
    const kind: ShipKind = what;
    // #56: a free trade ship launched mid-flight is immediately usable — it may
    // fly and establish on the same turn. (It used to be marked already-moved,
    // which left it locked for the turn: the AI skipped it and a human saw a ship
    // that couldn't act.) distanceMoved 0 gives it a full, fresh movement budget.
    const ship: Ship = {
      id: `ship-${player.id}-${state.ships.length}-${Math.floor(Math.random() * 1e6)}`,
      kind,
      owner: player.id,
      intersectionId: launch,
      movedThisTurn: false,
      distanceMoved: 0,
    };
    state.ships.push(ship);
    log(
      state,
      `${player.name} ${freeShip ? "launched a free" : "built a"} ${what === "colonyShip" ? "colony" : "trade"} ship.`,
    );
    return undefined;
  }

  if (what === "spaceport") {
    const colony = state.buildings.find(
      (b) => b.owner === player.id && b.kind === "colony" && b.intersectionId === targetId,
    );
    if (!colony) return "Select one of your colonies to upgrade to a spaceport.";
    pay(player.hand, state.supplyBank, cost);
    colony.kind = "spaceport";
    log(state, `${player.name} upgraded a colony to a spaceport.`);
    recomputeVp(state);
    return undefined;
  }

  // Upgrade (booster / cannon / freightPod).
  const kind = what as UpgradeKind;
  if (player.upgrades[kind] >= MAX_UPGRADES[kind]) return `Already at max ${kind}s.`;
  const inPlay = state.players.reduce((s, p) => s + p.upgrades[kind], 0);
  if (inPlay >= UPGRADE_SUPPLY[kind]) return `No ${kind}s left in the supply.`;
  pay(player.hand, state.supplyBank, cost);
  player.upgrades[kind]++;
  const upgLabel = kind === "freightPod" ? "freight pod" : kind;
  log(state, `${player.name} added a ${upgLabel}.`);
  state.phaseState.lastUpgrade = {
    playerId: player.id,
    kind,
    seq: (state.phaseState.lastUpgrade?.seq ?? 0) + 1,
  };
  // If a ship is already parked beside a pirate base / ice planet, buying the
  // extra cannon / freight pod that meets the requirement breaks the token right
  // away — no need to move again (rulebook §Pirate Bases and Ice Planets).
  if (kind === "cannon" || kind === "freightPod") {
    resolveSpecialsForPlayerShips(state, player, rng);
    recomputeVp(state);
  }
  return undefined;
}

function doMoveShip(
  state: GameState,
  player: PlayerState,
  shipId: string,
  path: string[],
  rng: Rng,
): string | undefined {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return "No such ship.";
  if (ship.owner !== player.id) return "Not your ship.";
  if (state.phaseState.frozenShipId === shipId)
    return "That ship was damaged in an encounter and cannot move this turn.";
  if (path.length === 0) return "Empty move path.";
  // A ship may move several times per flight phase, in any order with other
  // ships, as long as its running total stays within its speed (e.g. 3+5+2≤10).
  const budget = shipSpeed(state);
  const remaining = budget - ship.distanceMoved;
  if (remaining <= 0) return "That ship has used all of its movement this flight phase.";
  if (path.length > remaining)
    return `Path too long — only ${remaining} of ${budget} moves left for this ship.`;

  let from = ship.intersectionId;
  // #25: a ship must STOP the instant it reaches an unexplored sector. We walk the
  // requested path and cut it short at the first node that makes new contact, so a
  // longer path simply ends there (the rest of the speed is forfeit this step).
  const walked: string[] = [];
  for (const step of path) {
    const inter = state.intersections[from];
    if (!inter || !inter.neighbors.includes(step)) return "Illegal move: not a connected step.";
    // #19: the printed board has no path through the centre of a planetary system
    // (the corner shared by all 3 of its planets) — you fly around, not through.
    const si = state.intersections[step];
    if (si && si.adjacentPlanets.length >= 3) return "No path through the centre of a planet system.";
    walked.push(step);
    from = step;
    // First contact with an unknown sector ends the move on this node.
    if (wouldRevealSomething(state, step)) break;
  }
  const dest = walked[walked.length - 1]!;
  if (isOccupied(state, dest)) return "Destination is occupied.";

  // --- Stopping rules (playtest #20–#22) ---
  const destInter = state.intersections[dest]!;
  if (destInter.dockingPointOf) {
    // #21: an outpost docking point — a colony ship may never stop there, and a
    // trade ship may only stop if it has enough freight pods to establish a
    // station (more than the stations already docked at that outpost).
    if (ship.kind !== "tradeShip") return "Only a trade ship can stop at an outpost docking point.";
    const docked = state.tradeStations.filter((t) => t.outpostId === destInter.dockingPointOf).length;
    if (player.upgrades.freightPod <= docked)
      return `Need more than ${docked} freight pod${docked === 1 ? "" : "s"} to dock here (you have ${player.upgrades.freightPod}).`;
  } else if (ship.kind === "tradeShip" && destInter.adjacentPlanets.length === 2) {
    // #20: a colony site (an edge between exactly 2 planets) is for colony ships
    // only — a trade ship can pass by but can't park there.
    return "Trade ships can't stop on a colony site.";
  }
  // #22: blockade — you can't end a move on a space beside another commander's
  // spaceport (it would wall in their launch sites).
  for (const nb of destInter.neighbors) {
    if (state.buildings.some((b) => b.intersectionId === nb && b.kind === "spaceport" && b.owner !== player.id))
      return "Blockaded — you can't stop right beside another commander's spaceport.";
  }

  ship.intersectionId = dest;
  ship.distanceMoved += walked.length;
  ship.movedThisTurn = ship.distanceMoved >= budget;
  revealAround(state, dest, rng);
  resolveAdjacentSpecials(state, player, dest, rng);
  recomputeVp(state);
  log(state, `${player.name} moved a ship.`);
  return undefined;
}

function doEstablishColony(
  state: GameState,
  player: PlayerState,
  shipId: string,
  rng: Rng,
): string | undefined {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return "No such ship.";
  if (ship.owner !== player.id) return "Not your ship.";
  if (ship.kind !== "colonyShip") return "Only a colony ship can establish a colony.";
  const inter = state.intersections[ship.intersectionId];
  if (!inter) return "Ship is nowhere valid.";
  if (inter.adjacentPlanets.length !== 2)
    return "Not a colony site — build on a system edge (between exactly 2 planets), not the center.";
  // The Catanian Colonies (home systems) are seeded during set-up only; once the
  // game proper begins, no one may build there.
  const homeIds = homePlanetIds(state);
  if (inter.adjacentPlanets.every((pid) => homeIds.has(pid)))
    return "The Catanian Colonies are closed — settle a new system out in space.";
  if (state.buildings.some((b) => b.intersectionId === inter.id)) return "Site already occupied.";

  // Pirate bases / ice planets block the site until you clear them. If you have
  // enough cannons (pirate) / freight pods (ice) the token breaks the moment you
  // settle; otherwise tell the player exactly how many more they need.
  const toClear: Planet[] = [];
  for (const pid of inter.adjacentPlanets) {
    const planet = findPlanet(state, pid);
    if (!planet || planet.special === "none") continue;
    const req = specialGap(player, planet);
    if (!req) continue;
    if (req.gap > 0) {
      const what =
        planet.special === "pirateBase"
          ? `${req.gap} more cannon${req.gap === 1 ? "" : "s"} to defeat the pirate base (needs ${planet.specialValue})`
          : `${req.gap} more freight pod${req.gap === 1 ? "" : "s"} to terraform the ice planet (needs ${planet.specialValue})`;
      return `Can't settle here yet — you need ${what}.`;
    }
    toClear.push(planet);
  }
  if (player.supply.colonies <= 0) return "No colonies left in your supply.";

  for (const planet of toClear) clearSpecial(state, player, planet, inter.id, rng);
  state.ships = state.ships.filter((s) => s.id !== shipId);
  player.supply.transportShips++; // transport ship returns to supply
  player.supply.colonies--;
  state.buildings.push({ kind: "colony", owner: player.id, intersectionId: inter.id });
  log(state, `${player.name} established a colony!`);
  recomputeVp(state);
  return undefined;
}

function doEstablishTradeStation(
  state: GameState,
  player: PlayerState,
  shipId: string,
  dock: number,
): string | undefined {
  const ship = state.ships.find((s) => s.id === shipId);
  if (!ship) return "No such ship.";
  if (ship.owner !== player.id) return "Not your ship.";
  if (ship.kind !== "tradeShip") return "Only a trade ship can establish a trade station.";
  const inter = state.intersections[ship.intersectionId];
  if (!inter || !inter.dockingPointOf) return "Ship is not on an outpost docking point.";
  const outpostId = inter.dockingPointOf;
  if (dock < 0 || dock >= OUTPOST_DOCKS) return "Invalid dock index.";
  const existing = state.tradeStations.filter((t) => t.outpostId === outpostId);
  if (existing.some((t) => t.dock === dock)) return "That dock is taken.";
  // Rulebook: your freight pods must be GREATER THAN the number of trade stations
  // already at this outpost (counting ALL players). First station needs ≥1, and if
  // 3 stations are already docked here you need ≥4 freight pods to add another.
  if (player.upgrades.freightPod <= existing.length)
    return `Need more than ${existing.length} freight pod${existing.length === 1 ? "" : "s"} to dock here (you have ${player.upgrades.freightPod}).`;
  if (player.supply.tradeStations <= 0) return "No trade stations left in your supply.";

  state.ships = state.ships.filter((s) => s.id !== shipId);
  player.supply.transportShips++;
  player.supply.tradeStations--;
  state.tradeStations.push({ owner: player.id, outpostId, dock });
  log(state, `${player.name} established a trade station.`);

  // Offer a friendship-card ability from the outpost's civ (player chooses).
  const sector = state.sectors.find((s) => s.kind === "outpost" && s.id === outpostId);
  const civ = sector?.outpostCiv;
  if (civ) {
    // P6g: friendship cards are unique — exclude any already claimed by others.
    const claimed = claimedFriendshipCards(state.players);
    const options = availableFriendshipCards(player, civ, claimed);
    if (options.length > 0) {
      state.phaseState.pendingFriendship = { playerId: player.id, civ, options };
      log(state, `${player.name} may choose a ${civ} friendship ability.`);
    }
    // Friendship marker (+2 VP) to whoever has the most stations at this outpost.
    awardFriendshipMarker(state, outpostId, civ, player.id);
  }
  recomputeVp(state);
  return undefined;
}

/**
 * Award the friendship marker (+2 VP) for an outpost's civ. Rulebook: the marker
 * stays with whoever has the MOST trade stations at the outpost; to take it from
 * the current holder a rival must build STRICTLY more (a tie keeps the holder).
 * Only the player who just established (`establisherId`) changed their count, so
 * leadership can only flip if that player overtakes the current holder.
 */
function awardFriendshipMarker(
  state: GameState,
  outpostId: string,
  civ: string,
  establisherId: string,
): void {
  const counts = new Map<string, number>();
  for (const t of state.tradeStations) {
    if (t.outpostId === outpostId) counts.set(t.owner, (counts.get(t.owner) ?? 0) + 1);
  }
  const holder = state.players.find((p) => p.friendshipMarkers.includes(civ as never));
  const give = (id: string): void => {
    for (const p of state.players) p.friendshipMarkers = p.friendshipMarkers.filter((c) => c !== civ);
    const p = state.players.find((pl) => pl.id === id);
    if (p) {
      p.friendshipMarkers.push(civ as never);
      log(state, `${p.name} holds the ${civ} friendship marker (+2 VP).`);
    }
  };

  if (!holder) {
    // First station at this outpost — the establisher claims the marker.
    give(establisherId);
    return;
  }
  if (holder.id === establisherId) return; // already holds it; nothing changes.
  // A rival overtakes the holder only by having strictly more stations here.
  const mine = counts.get(establisherId) ?? 0;
  const held = counts.get(holder.id) ?? 0;
  if (mine > held) give(establisherId);
  // Otherwise (tie or fewer) the current holder keeps the marker.
}

/**
 * Apply a single in-game intent. Lobby intents (createRoom/join/etc.) are not
 * handled here. Returns a new state; on validation failure returns the original
 * state plus an error string.
 */
/**
 * TEMPORARY testing/dev hooks, applied to `state` for `playerId`. Routed through
 * the engine so the same chat codes work in single-player AND online multiplayer
 * (the server applies them to its authoritative state and broadcasts). Remove this
 * function and the "dev" intent before any public release.
 */
export function applyDevAction(
  state: GameState,
  playerId: string,
  action: DevAction,
  n: number | undefined,
): void {
  const me = state.players.find((p) => p.id === playerId);
  if (!me) return;
  const ps = state.phaseState;
  switch (action) {
    case "encounter": {
      const cardId = n ?? 1;
      const card = ENCOUNTER_CARDS[cardId];
      if (!card) return;
      ps.phase = "encounter";
      ps.shake = ps.shake ?? { speed: 5, combat: 5, balls: ["red", "blue"], encounter: true };
      ps.moveBudget = ps.moveBudget ?? ps.shake.speed;
      ps.encounter = {
        cardId,
        subjectId: playerId,
        awaiting: card.prompt,
        ...(card.allPlayers ? { allPlayers: true, confirmedBy: [] } : {}),
      };
      break;
    }
    case "upgrades": {
      me.upgrades.booster = MAX_UPGRADES.booster;
      me.upgrades.cannon = MAX_UPGRADES.cannon;
      me.upgrades.freightPod = MAX_UPGRADES.freightPod;
      break;
    }
    case "friendship": {
      const civs: AlienCiv[] = ["greenFolk", "scientists", "diplomats", "merchants"];
      for (const civ of civs) {
        const card = FRIENDSHIP_CARDS.find((c) => c.civ === civ && !me.friendshipCards.includes(c.id));
        if (card) me.friendshipCards.push(card.id);
      }
      break;
    }
    case "jump": {
      (ps.spaceJumps ??= {})[playerId] = (ps.spaceJumps[playerId] ?? 0) + 1;
      break;
    }
    case "vp": {
      me.victoryMedals = (me.victoryMedals ?? 0) + Math.max(0, Math.floor(n ?? 1));
      break;
    }
    case "reveal": {
      for (const sec of state.sectors) {
        sec.discovered = true;
        for (const planet of sec.planets) {
          planet.explored = true;
          if (planet.number == null && planet.special === "none") planet.number = 8;
        }
      }
      break;
    }
    case "resources": {
      // One-shot "warp9" grant for online testing: top up hand + personal supply
      // and clear any pending discard the player owes.
      for (const r of RESOURCES) me.hand[r] = Math.max(me.hand[r], 25);
      me.supply.colonies = Math.max(me.supply.colonies, 20);
      me.supply.tradeStations = Math.max(me.supply.tradeStations, 20);
      me.supply.transportShips = Math.max(me.supply.transportShips, 20);
      me.supply.shipyards = Math.max(me.supply.shipyards, 20);
      if (ps.pendingDiscards && ps.pendingDiscards[playerId]) ps.pendingDiscards[playerId] = 0;
      break;
    }
  }
  recomputeVp(state);
}

export function applyIntent(
  input: GameState,
  playerId: string,
  intent: ClientIntent,
  rng: Rng = Math.random,
): IntentResult {
  const state = clone(input);
  const ps = state.phaseState;

  if (ps.phase === "gameOver") return fail(input, "The game is over.");

  const isActive = activePlayer(state).id === playerId;
  const me = state.players.find((p) => p.id === playerId);
  if (!me) return fail(input, "Unknown player.");

  // Discards after a 7 must be resolved before normal play continues.
  const owesDiscard = (id: string): number => ps.pendingDiscards?.[id] ?? 0;
  const anyDiscardsPending = (): boolean =>
    !!ps.pendingDiscards && Object.values(ps.pendingDiscards).some((n) => n > 0);
  // After a 7, the roller owes a steal before they may build/trade/end.
  const stealPending = (): boolean => !!ps.awaitingSteal;

  switch (intent.t) {
    // --- Set-up phase ---------------------------------------------------------
    case "setupRoll": {
      if (ps.phase !== "setup" || !ps.setup) return fail(input, "Not the set-up phase.");
      const su = ps.setup;
      if (su.step !== "rollStart") return fail(input, "Start player already determined.");
      const idx = state.players.findIndex((p) => p.id === playerId);
      if (idx !== ps.activePlayerIndex) return fail(input, "Not your roll yet.");
      if (su.startRolls[idx] != null) return fail(input, "You already rolled.");
      const d1 = rollDie(rng);
      const d2 = rollDie(rng);
      su.startRolls[idx] = d1 + d2;
      ps.lastRoll = [d1, d2];
      ps.rollCount = (ps.rollCount ?? 0) + 1;
      log(state, `${me.name} rolled ${d1} + ${d2} = ${d1 + d2} for starting position.`);
      const rolled = Object.keys(su.startRolls).length;
      const n = state.players.length;
      if (rolled < n) {
        ps.activePlayerIndex = rolled; // next seat rolls
        return { state };
      }
      // All rolled: highest total wins (ties broken by lowest seat index).
      let best = -1;
      let winner = 0;
      for (let i = 0; i < n; i++) {
        const total = su.startRolls[i] ?? 0;
        if (total > best) {
          best = total;
          winner = i;
        }
      }
      su.startPlayerIndex = winner;
      su.step = "place";
      su.round = 1;
      su.order = setupRoundOrder(1, winner, n);
      su.pos = 0;
      syncSetupActive(state);
      log(
        state,
        `${state.players[winner]!.name} rolled highest and goes first. Round 1 — place your first colony.`,
      );
      return { state };
    }

    case "setupPlaceColony": {
      if (ps.phase !== "setup" || !ps.setup) return fail(input, "Not the set-up phase.");
      const su = ps.setup;
      if (su.step !== "place" || su.round < 1 || su.round > 3)
        return fail(input, "Not a colony-placement round.");
      if (!isActive) return fail(input, "Not your placement.");
      const inter = state.intersections[intent.intersectionId];
      if (!inter) return fail(input, "Unknown site.");
      if (!catanianColonySites(state).includes(intent.intersectionId))
        return fail(input, "Place on an open colony site of the Catanian Colonies.");
      if (me.supply.colonies <= 0) return fail(input, "No colonies left in your supply.");
      state.buildings.push({ kind: "colony", owner: me.id, intersectionId: inter.id });
      me.supply.colonies--;
      recomputeVp(state);
      log(state, `${me.name} placed colony #${su.round} on the Catanian Colonies.`);
      advanceSetup(state, rng);
      return { state };
    }

    case "setupUpgrade": {
      if (ps.phase !== "setup" || !ps.setup) return fail(input, "Not the set-up phase.");
      const su = ps.setup;
      if (su.round !== 4 || su.r4step !== "upgrade") return fail(input, "Not the upgrade step.");
      if (!isActive) return fail(input, "Not your turn in set-up.");
      const colony = state.buildings.find(
        (b) => b.owner === me.id && b.kind === "colony" && b.intersectionId === intent.intersectionId,
      );
      if (!colony) return fail(input, "Pick one of your own colonies to upgrade.");
      colony.kind = "spaceport";
      su.r4step = "ship";
      recomputeVp(state);
      log(state, `${me.name} upgraded a colony to a spaceport.`);
      return { state };
    }

    case "setupPlaceShip": {
      if (ps.phase !== "setup" || !ps.setup) return fail(input, "Not the set-up phase.");
      const su = ps.setup;
      if (su.round !== 4 || su.r4step !== "ship") return fail(input, "Upgrade a colony first.");
      if (!isActive) return fail(input, "Not your turn in set-up.");
      const sites = shipLaunchSites(me, state);
      if (!sites.includes(intent.intersectionId))
        return fail(input, "Launch the ship onto an open point next to your spaceport.");
      if (me.supply.transportShips <= 0) return fail(input, "No transport ships in your supply.");
      me.supply.transportShips--;
      state.ships.push({
        id: `ship-${me.id}-${state.ships.length}-${Math.floor(rng() * 1e6)}`,
        kind: intent.shipKind,
        owner: me.id,
        intersectionId: intent.intersectionId,
        movedThisTurn: false,
        distanceMoved: 0,
      });
      su.r4step = "bonus";
      log(state, `${me.name} placed a ${intent.shipKind === "colonyShip" ? "colony" : "trade"} ship.`);
      return { state };
    }

    case "setupBonus": {
      if (ps.phase !== "setup" || !ps.setup) return fail(input, "Not the set-up phase.");
      const su = ps.setup;
      if (su.round !== 4 || su.r4step !== "bonus") return fail(input, "Place your ship first.");
      if (!isActive) return fail(input, "Not your turn in set-up.");
      const pool = su.bonusPool ?? [];
      const at = pool.indexOf(intent.upgrade);
      if (at < 0) return fail(input, "That bonus upgrade is no longer available.");
      pool.splice(at, 1);
      su.bonusPool = pool;
      me.upgrades[intent.upgrade]++;
      log(state, `${me.name} took a bonus ${intent.upgrade}.`);
      advanceSetup(state, rng);
      return { state };
    }

    case "rollDice": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "production") return fail(input, "Not the production phase.");
      doProduction(state, rng);
      return { state };
    }

    case "discard": {
      const owed = owesDiscard(playerId);
      if (owed <= 0) return fail(input, "You don't need to discard.");
      const picked = RESOURCES.reduce((s, r) => s + (intent.resources[r] ?? 0), 0);
      if (picked !== owed) return fail(input, `You must discard exactly ${owed} cards.`);
      for (const r of RESOURCES) {
        const n = intent.resources[r] ?? 0;
        if (n > me.hand[r]) return fail(input, `You don't have ${n} ${r}.`);
      }
      for (const r of RESOURCES) {
        const n = intent.resources[r] ?? 0;
        me.hand[r] -= n;
        state.supplyBank[r] += n;
      }
      if (ps.pendingDiscards) {
        delete ps.pendingDiscards[playerId];
        if (Object.keys(ps.pendingDiscards).length === 0) ps.pendingDiscards = undefined;
      }
      log(state, `${me.name} discarded ${owed} card(s).`);
      // Once every discard is in and there's no steal left to wait on, the other
      // players draw their bank cards, then the roller takes the reserve bonus.
      // (If a steal is still pending, stealTarget will do this after the steal.)
      if (!ps.pendingDiscards && !ps.awaitingSteal) {
        giveSevenBankCards(state, rng);
        if (ps.pendingReserveDraw) drawReserveBonus(state, rng);
      }
      return { state };
    }

    case "tradeWithSupply": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "tradeBuild") return fail(input, "Trade with supply during trade & build.");
      if (anyDiscardsPending()) return fail(input, "Resolve discards first.");
      if (stealPending()) return fail(input, "Steal a card first.");
      const giving = RESOURCES.filter((r) => (intent.give[r] ?? 0) > 0);
      const taking = RESOURCES.filter((r) => (intent.take[r] ?? 0) > 0);
      if (giving.length === 0) return fail(input, "Offer at least one resource to trade.");
      if (taking.length === 0) return fail(input, "Choose at least one resource to take.");
      // Compute total buy-power across every given resource: each resource is
      // bought at its own ratio (goods 2:1, others 3:1, better with Merchants),
      // and the amount given must be a whole multiple of that ratio. The bank
      // lets you take that many cards in any mix. e.g. 4 goods (2:1 → 2) + 3 food
      // (3:1 → 1) = 3 cards.
      let bought = 0;
      let usingGoods1to1 = false;
      for (const g of giving) {
        const amt = intent.give[g] ?? 0;
        const ratio = tradeRatioFor(me, g);
        if (amt % ratio !== 0)
          return fail(input, `${g} must be traded in multiples of ${ratio} (its ratio is ${ratio}:1).`);
        if (me.hand[g] < amt) return fail(input, `Not enough ${g}.`);
        bought += amt / ratio;
        if (g === "goods" && ratio === 1) usingGoods1to1 = true;
      }
      const takeTotal = taking.reduce((s, r) => s + (intent.take[r] ?? 0), 0);
      if (takeTotal !== bought)
        return fail(input, `Those resources buy ${bought} card(s), but you asked for ${takeTotal}.`);
      for (const r of taking) {
        if (state.supplyBank[r] < (intent.take[r] ?? 0)) return fail(input, `Supply is short on ${r}.`);
      }
      // Merchant "Trade Advantage" for goods (1:1) is a once-per-turn ability
      // (almanac: Ezzel's Exchange Rate 1:1). Plain 2:1 goods trades are unlimited.
      if (usingGoods1to1) {
        const used = ps.goodsTradeUsedBy ?? [];
        if (used.includes(me.id))
          return fail(input, "You can only use the 1:1 goods trade once per turn.");
        ps.goodsTradeUsedBy = [...used, me.id];
      }
      for (const g of giving) {
        const amt = intent.give[g] ?? 0;
        me.hand[g] -= amt;
        state.supplyBank[g] += amt;
      }
      for (const r of taking) {
        const amt = intent.take[r] ?? 0;
        state.supplyBank[r] -= amt;
        me.hand[r] += amt;
      }
      const giveStr = giving.map((g) => `${intent.give[g]} ${g}`).join(" + ");
      const takeStr = taking.map((r) => `${intent.take[r]} ${r}`).join(" + ");
      log(state, `${me.name} traded ${giveStr} for ${takeStr}.`);
      bumpStat(state, "tradesCompleted", me.id);
      return { state };
    }

    case "build": {
      if (!isActive) return fail(input, "Not your turn.");
      // A free encounter trade ship can be launched during the flight phase too,
      // right after the encounter that granted it.
      const freeShipLaunch =
        intent.what === "tradeShip" && (ps.freeTradeShips?.[playerId] ?? 0) > 0;
      if (ps.phase !== "tradeBuild" && !(ps.phase === "flight" && freeShipLaunch))
        return fail(input, "Can only build during trade & build.");
      if (anyDiscardsPending()) return fail(input, "Resolve discards first.");
      if (stealPending()) return fail(input, "Steal a card first.");
      const err = doBuild(state, me, intent.what, intent.targetId, rng);
      if (err) return fail(input, err);
      return { state };
    }

    case "proposeTrade": {
      if (!isActive) return fail(input, "Only the active player can propose a trade.");
      if (ps.phase !== "tradeBuild") return fail(input, "Propose trades during trade & build.");
      if (ps.pendingTrade) return fail(input, "Cancel your current offer before proposing another.");
      const giveTotal = RESOURCES.reduce((s, r) => s + (intent.give[r] ?? 0), 0);
      const wantTotal = RESOURCES.reduce((s, r) => s + (intent.want[r] ?? 0), 0);
      // A player-to-player trade is an exchange: both sides must offer something.
      // Giving resources for nothing (or asking for nothing) is not allowed.
      if (giveTotal === 0 || wantTotal === 0)
        return fail(input, "A trade must give and want something — no one-sided gifts.");
      // You can only swap different resources — never the same one both ways.
      for (const r of RESOURCES) {
        if ((intent.give[r] ?? 0) > 0 && (intent.want[r] ?? 0) > 0)
          return fail(input, "You can't trade a resource for the same resource.");
      }
      for (const r of RESOURCES) {
        if ((intent.give[r] ?? 0) > me.hand[r]) return fail(input, "You can't give what you don't have.");
      }
      ps.pendingTrade = {
        fromId: me.id,
        give: { ...intent.give },
        want: { ...intent.want },
        responses: [],
      };
      ps.tradeProposals = (ps.tradeProposals ?? 0) + 1;
      log(state, `${me.name} offers a trade to the table.`);
      return { state };
    }

    case "respondTrade": {
      const offer = ps.pendingTrade;
      if (!offer) return fail(input, "No trade to respond to.");
      if (offer.fromId === playerId) return fail(input, "You can't respond to your own offer.");
      const responses = offer.responses.filter((r) => r.playerId !== playerId);
      if (!intent.accept) {
        responses.push({ playerId, kind: "decline" });
        offer.responses = responses;
        log(state, `${me.name} declined the trade.`);
        return { state };
      }
      const isCounter = intent.counterGive !== undefined || intent.counterWant !== undefined;
      if (isCounter) {
        responses.push({
          playerId,
          kind: "counter",
          give: { ...(intent.counterGive ?? {}) },
          want: { ...(intent.counterWant ?? {}) },
        });
        log(state, `${me.name} counters the trade.`);
      } else {
        // Plain accept of the offer AS-IS settles the trade immediately — the
        // proposer already consented to these exact terms, so there's nothing
        // left to confirm and the trade window closes by itself for everyone.
        const proposer = state.players.find((p) => p.id === offer.fromId);
        if (!proposer) return fail(input, "The proposer left the game.");
        const err = settleTrade(state, proposer, me, offer.give, offer.want);
        if (err) return fail(input, err);
        return { state };
      }
      offer.responses = responses;
      return { state };
    }

    case "finalizeTrade": {
      const offer = ps.pendingTrade;
      if (!offer) return fail(input, "No trade to finalize.");
      if (offer.fromId !== playerId) return fail(input, "Only the proposer can finalize the trade.");
      const resp = offer.responses.find((r) => r.playerId === intent.withId);
      if (!resp || resp.kind === "decline") return fail(input, "That player isn't offering a deal.");
      const partner = state.players.find((p) => p.id === intent.withId);
      if (!partner) return fail(input, "Unknown trade partner.");
      // A counter overrides the original deal (still from the proposer's perspective).
      const give = resp.kind === "counter" ? (resp.give ?? {}) : offer.give;
      const want = resp.kind === "counter" ? (resp.want ?? {}) : offer.want;
      const err = settleTrade(state, me, partner, give, want);
      if (err) return fail(input, err);
      return { state };
    }

    case "cancelTrade": {
      const offer = ps.pendingTrade;
      if (!offer) return fail(input, "No trade to cancel.");
      if (offer.fromId !== playerId) return fail(input, "Only the proposer can cancel the trade.");
      ps.pendingTrade = undefined;
      log(state, `${me.name} withdrew the trade offer.`);
      return { state };
    }

    case "endTradeBuild": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "tradeBuild") return fail(input, "Not the trade & build phase.");
      if (anyDiscardsPending()) return fail(input, "Resolve discards first.");
      if (stealPending()) return fail(input, "Steal a card first.");
      if (ps.pendingTrade) return fail(input, "Resolve or cancel your trade offer first.");
      ps.phase = "flight";
      log(state, `${activePlayer(state).name} enters the flight phase.`);
      return { state };
    }

    case "shakeMothership": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "flight") return fail(input, "Can only shake during flight.");
      if (ps.shake) return fail(input, "Already shook this flight phase.");
      doShake(state, rng);
      return { state };
    }

    case "buyFame": {
      // Diplomat "Fame for Sale": pay 1 goods for 1 fame medal piece, once/turn.
      if (!isActive) return fail(input, "Not your turn.");
      if (!hasCard(me, "diplomats:fameForSale"))
        return fail(input, "You need the Diplomat 'Fame for Sale' alliance.");
      const used = ps.fameBoughtBy ?? [];
      if (used.includes(me.id)) return fail(input, "Already bought fame this turn.");
      if (me.hand.goods < 1) return fail(input, "Need 1 goods to buy fame.");
      me.hand.goods--;
      state.supplyBank.goods++;
      me.fameMedalPieces++;
      ps.fameBoughtBy = [...used, me.id];
      log(state, `${me.name} buys 1 fame medal piece for 1 goods (Fame for Sale).`);
      recomputeVp(state);
      return { state };
    }

    case "encounterChoice": {
      if (ps.phase !== "encounter" || !ps.encounter) return fail(input, "No active encounter.");
      // Wear & Tear (all-player) cards: any player confirms; the card stays up
      // until everyone has, then resolves once.
      if (ps.encounter.allPlayers) {
        confirmAllPlayerEncounter(state, playerId, rng, intent.choice);
        recomputeVp(state);
        return { state };
      }
      if (ps.encounter.subjectId !== playerId) return fail(input, "Not your encounter.");
      resolveEncounter(state, intent.choice, rng, intent.resources);
      recomputeVp(state);
      return { state };
    }

    case "encounterShake": {
      if (ps.phase !== "encounter" || !ps.encounter || ps.encounter.awaiting !== "duel")
        return fail(input, "No duel to shake for right now.");
      if (!encounterShake(state, playerId, rng)) return fail(input, "It's not your shake.");
      recomputeVp(state);
      return { state };
    }

    case "dev": {
      // TEMPORARY testing hook — works for any player, on or off turn. Remove later.
      applyDevAction(state, playerId, intent.action, intent.n);
      return { state };
    }

    case "moveShip": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "flight") return fail(input, "Move ships during flight.");
      if (!ps.shake) return fail(input, "Shake the mothership first.");
      const err = doMoveShip(state, me, intent.shipId, intent.path, rng);
      if (err) return fail(input, err);
      bumpStat(state, "distanceFlown", me.id, intent.path.length);
      return { state };
    }

    case "spaceJump": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "flight") return fail(input, "Space jump during flight.");
      if ((ps.spaceJumps?.[me.id] ?? 0) <= 0)
        return fail(input, "You have no space jump available (earn one from an encounter).");
      const ship = state.ships.find((s) => s.id === intent.shipId);
      if (!ship || ship.owner !== me.id) return fail(input, "Not your ship.");
      if (!state.intersections[intent.toIntersectionId]) return fail(input, "Unknown destination.");
      if (isOccupied(state, intent.toIntersectionId)) return fail(input, "Destination occupied.");
      ship.intersectionId = intent.toIntersectionId;
      ship.movedThisTurn = true;
      ps.spaceJumps![me.id]!--; // consume the granted jump
      revealAround(state, intent.toIntersectionId, rng);
      resolveAdjacentSpecials(state, me, intent.toIntersectionId, rng);
      recomputeVp(state);
      log(state, `${me.name} made a space jump.`);
      return { state };
    }

    case "establishColony": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "flight") return fail(input, "Establish colonies during flight.");
      const err = doEstablishColony(state, me, intent.shipId, rng);
      if (err) return fail(input, err);
      return { state };
    }

    case "establishTradeStation": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase !== "flight") return fail(input, "Establish trade stations during flight.");
      const err = doEstablishTradeStation(state, me, intent.shipId, intent.dock);
      if (err) return fail(input, err);
      return { state };
    }

    case "chooseFriendship": {
      const pf = ps.pendingFriendship;
      if (!pf) return fail(input, "No friendship ability to choose.");
      if (pf.playerId !== playerId) return fail(input, "That choice isn't yours.");
      if (!pf.options.includes(intent.cardId)) return fail(input, "Invalid friendship card.");
      if (!me.friendshipCards.includes(intent.cardId)) me.friendshipCards.push(intent.cardId);
      ps.pendingFriendship = undefined;
      log(state, `${me.name} gained a ${pf.civ} ability.`);
      recomputeVp(state);
      return { state };
    }

    case "endTurn": {
      if (!isActive) return fail(input, "Not your turn.");
      if (ps.phase === "encounter") return fail(input, "Resolve the encounter first.");
      if (anyDiscardsPending()) return fail(input, "Resolve discards first.");
      if (stealPending()) return fail(input, "Steal a card first.");
      if (ps.pendingFriendship) return fail(input, "Choose your friendship ability first.");
      // #20: a colony ship may not loiter on a colony site — if one ends the turn
      // parked on an establishable site, settle it now so it can't sit there a
      // second turn blocking the spot. (Colony only: a trade station grants a
      // player-chosen friendship card, so those stay a manual bubble action — #21.)
      for (const s of state.ships.filter((sh) => sh.owner === me.id && sh.kind === "colonyShip")) {
        const it = state.intersections[s.intersectionId];
        if (it && it.adjacentPlanets.length === 2 && !state.buildings.some((b) => b.intersectionId === it.id)) {
          doEstablishColony(state, me, s.id, rng); // ignores the error if it can't settle here
        }
      }
      endTurn(state);
      return { state };
    }

    case "stealTarget": {
      if (!isActive) return fail(input, "Only the roller can steal.");
      if (!ps.awaitingSteal) return fail(input, "There is nothing to steal right now.");
      if (anyDiscardsPending()) return fail(input, "Resolve discards first.");
      const target = state.players.find((p) => p.id === intent.targetId);
      if (!target || target.id === me.id) return fail(input, "Pick an opponent to steal from.");
      if (handTotal(target) <= 0) return fail(input, "That player has no cards to steal.");
      if (!canStealFrom(state, target))
        return fail(input, `Friendly Bandit: can't steal from players who haven't earned ${FRIENDLY_ROBBER_VP} VP yet.`);
      drawRandom(target.hand, me.hand, 1, rng);
      ps.awaitingSteal = false;
      ps.lastSteal = { fromId: target.id, toId: me.id, seq: (ps.lastSteal?.seq ?? 0) + 1 };
      log(state, `${me.name} stole 1 card from ${target.name}.`);
      // Now (after the steal) the other players each draw their bank card, then
      // the roller takes the 7's reserve-pile bonus. (Discards are already done —
      // stealTarget requires it above.)
      giveSevenBankCards(state, rng);
      if (ps.pendingReserveDraw) drawReserveBonus(state, rng);
      return { state };
    }

    default:
      return fail(input, `Unknown or non-game intent in phase ${PHASE_LABEL[ps.phase]}.`);
  }
}
