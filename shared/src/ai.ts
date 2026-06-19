import { BUILD_COSTS, MAX_UPGRADES } from "./constants.js";
import {
  RESOURCES,
  type AiDifficulty,
  type GameState,
  type Planet,
  type PlayerState,
  type Resource,
  type ResourceBag,
} from "./types.js";
import type { ClientIntent } from "./protocol.js";
import { catanianColonySites, shipLaunchSites } from "./engine.js";
import { tradeRatioFor } from "./friendship.js";

// Greedy single-player opponent. It plays to accrue VP so games actually reach
// the target: expand colonies, upgrade spaceports, grab useful upgrades, fly
// ships toward open colony sites / outpost docks, and resolve encounters.
//
// Two entry points:
//   aiObligation  — discard / trade-response any AI seat owes, even off-turn.
//   aiTurnAction  — the active AI seat's main decision for the current phase.

const RES_VALUE: Record<Resource, number> = { ore: 3, fuel: 2, carbon: 3, food: 1, goods: 4 };

// --- difficulty -------------------------------------------------------------

interface Knobs {
  /** Most boosters the AI will stockpile. */
  boosterCap: number;
  /** Build trade ships and race to dock outposts (friendship markers = +2 VP). */
  buildTradeShips: boolean;
  /** Most colony ships the AI keeps in flight at once (expand on several fronts). */
  maxColonyShips: number;
  /** Most trade ships in flight at once (more = grab more outposts). */
  maxTradeShips: number;
  /** Build cannons to conquer pirate bases (each cleared base = +1 VP). */
  buildCannons: boolean;
  /** Pursue ice planets & pirate bases: build pods/cannons and settle them. */
  clearSpecials: boolean;
  /** Make proactive player-to-player trade offers to fill build gaps. */
  proposeTrades: boolean;
  /** Default gift offered to a friendly merchant / travelers (for fame). */
  encounterGift: number;
  /** Push new colonies outward BEFORE upgrading home colonies into spaceports. */
  expandFirst: boolean;
  /** Only upgrade colonies at least this fraction of the map radius from centre
   *  into spaceports — so a "fly further" AI builds them in mid/far space, not on
   *  its starting cluster. 0 = upgrade any colony. */
  spaceportMinDistFrac: number;
  /** Buy a couple of boosters early (while ships are out) so the fleet reaches
   *  deeper space rather than settling whatever's nearest home. */
  earlyBoosters: boolean;
}

const KNOBS: Record<AiDifficulty, Knobs> = {
  easy: {
    boosterCap: 1,
    buildTradeShips: true,
    maxColonyShips: 1,
    maxTradeShips: 1,
    buildCannons: false,
    clearSpecials: false,
    proposeTrades: true, // every AI now initiates trades on its turn
    encounterGift: 0,
    expandFirst: false,
    spaceportMinDistFrac: 0,
    earlyBoosters: false,
  },
  normal: {
    boosterCap: 3,
    buildTradeShips: true,
    maxColonyShips: 2,
    maxTradeShips: 1,
    buildCannons: true,
    clearSpecials: true,
    proposeTrades: true,
    encounterGift: 1,
    expandFirst: false,
    spaceportMinDistFrac: 0,
    earlyBoosters: false,
  },
  hard: {
    boosterCap: 6,
    buildTradeShips: true,
    maxColonyShips: 3,
    maxTradeShips: 3, // chase several outposts at once
    buildCannons: true,
    clearSpecials: true,
    proposeTrades: true,
    encounterGift: 1,
    expandFirst: true, // colonise mid/far space before converting home colonies
    spaceportMinDistFrac: 0.42, // spaceports only out past the inner cluster
    earlyBoosters: true, // fly further
  },
};

function knobs(state: GameState): Knobs {
  return KNOBS[state.config.aiDifficulty ?? "normal"];
}

function seat(state: GameState, id: string): PlayerState {
  return state.players.find((p) => p.id === id)!;
}

function canAfford(hand: ResourceBag, cost: Partial<ResourceBag>): boolean {
  return RESOURCES.every((r) => hand[r] >= (cost[r] ?? 0));
}

const handTotal = (p: PlayerState): number => RESOURCES.reduce((s, r) => s + p.hand[r], 0);

/** Obligations a seat must satisfy regardless of whose turn it is. */
export function aiObligation(state: GameState, seatId: string): ClientIntent | null {
  const ps = state.phaseState;
  const me = seat(state, seatId);

  // Forced discard after a 7: drop the lowest-value surplus.
  const owed = ps.pendingDiscards?.[seatId] ?? 0;
  if (owed > 0) {
    const resources: Partial<Record<Resource, number>> = {};
    let left = owed;
    const order = [...RESOURCES].sort((a, b) => RES_VALUE[a] - RES_VALUE[b]);
    for (const r of order) {
      if (left <= 0) break;
      const take = Math.min(left, me.hand[r]);
      if (take > 0) {
        resources[r] = take;
        left -= take;
      }
    }
    return { t: "discard", resources };
  }

  // Wear & Tear (all-player) encounter: confirm so the table can proceed, even
  // when it's another player's turn.
  if (
    ps.phase === "encounter" &&
    ps.encounter?.allPlayers &&
    !(ps.encounter.confirmedBy ?? []).includes(seatId)
  ) {
    return { t: "encounterChoice", choice: 0 };
  }

  // Duel: if I'm the subject or the designated rival and haven't shaken yet,
  // shake my mothership so the fight resolves (works off-turn for the rival).
  if (ps.phase === "encounter" && ps.encounter?.awaiting === "duel" && ps.encounter.duel) {
    const d = ps.encounter.duel;
    if (ps.encounter.subjectId === seatId && d.subjectRoll == null) return { t: "encounterShake" };
    if (d.opponentId === seatId && d.oppRoll == null) return { t: "encounterShake" };
  }

  // Respond to a live broadcast trade offer (if I haven't already responded and
  // it isn't my own). `give`/`want` are from the PROPOSER's perspective: I would
  // receive `give` and pay `want`.
  if (ps.pendingTrade && ps.pendingTrade.fromId !== seatId) {
    const offer = ps.pendingTrade;
    if (!offer.responses.some((r) => r.playerId === seatId)) {
      let myGain = 0; // value of cards I receive
      let myCost = 0; // value of cards I pay
      let canCover = true;
      for (const r of RESOURCES) {
        const g = offer.give[r] ?? 0;
        const w = offer.want[r] ?? 0;
        myGain += g * RES_VALUE[r];
        myCost += w * RES_VALUE[r];
        if (w > me.hand[r]) canCover = false;
      }
      const net = myGain - myCost;
      if (canCover && net >= 0) {
        return { t: "respondTrade", accept: true };
      }
      // Slightly unfavorable but close: counter by asking the proposer to pay me
      // one fewer of the costliest resource they wanted.
      if (canCover && net >= -RES_VALUE.goods) {
        const drop = RESOURCES.filter((r) => (offer.want[r] ?? 0) > 0).sort(
          (a, b) => RES_VALUE[b] - RES_VALUE[a],
        )[0];
        if (drop) {
          const counterWant: Partial<Record<Resource, number>> = {};
          for (const r of RESOURCES) {
            const w = offer.want[r] ?? 0;
            if (w > 0) counterWant[r] = r === drop ? w - 1 : w;
          }
          return {
            t: "respondTrade",
            accept: true,
            counterGive: { ...offer.give },
            counterWant,
          };
        }
      }
      return { t: "respondTrade", accept: false };
    }
  }

  return null;
}

/** The active AI seat's action for the current phase. */
export function aiTurnAction(state: GameState, seatId: string): ClientIntent | null {
  const ps = state.phaseState;
  const me = seat(state, seatId);

  switch (ps.phase) {
    case "setup":
      return setupAction(state, me);

    case "production":
      return { t: "rollDice" };

    case "encounter":
      if (ps.encounter?.subjectId === seatId) {
        // Surrender resources of our choice: give away our least-valuable cards.
        if (ps.encounter.awaiting === "giveResources") {
          const owed = ps.encounter.lossCount ?? 0;
          const give: Partial<Record<Resource, number>> = {};
          let left = owed;
          const order = [...RESOURCES].sort((a, b) => RES_VALUE[a] - RES_VALUE[b]);
          for (const r of order) {
            if (left <= 0) break;
            const take = Math.min(left, me.hand[r]);
            if (take > 0) {
              give[r] = take;
              left -= take;
            }
          }
          return { t: "encounterChoice", choice: 0, resources: give };
        }
        // Combat defeat: immobilize the ship that has already travelled the most
        // (least useful to keep moving), defaulting to the first.
        if (ps.encounter.awaiting === "selectShip") {
          const myShips = state.ships.filter((s) => s.owner === seatId);
          let pick = 0;
          let mostMoved = -1;
          myShips.forEach((s, i) => {
            if (s.distanceMoved > mostMoved) {
              mostMoved = s.distanceMoved;
              pick = i;
            }
          });
          return { t: "encounterChoice", choice: pick };
        }
        // "number" offers: give a modest gift if we can afford it (harder AIs
        // pay for fame more readily).
        if (ps.encounter.awaiting === "number") {
          const want = knobs(state).encounterGift;
          const offer = handTotal(me) >= want + 2 ? want : 0;
          return { t: "encounterChoice", choice: offer };
        }
        // yes/no: cooperate (help / surrender small tribute) by default.
        return { t: "encounterChoice", choice: true };
      }
      return null;

    case "tradeBuild":
      return tradeBuildAction(state, me);

    case "flight":
      return flightAction(state, me);

    default:
      return null;
  }
}

/** The active AI seat's set-up move (roll for start, then 4-round placement). */
function setupAction(state: GameState, me: PlayerState): ClientIntent | null {
  const su = state.phaseState.setup;
  if (!su) return null;

  if (su.step === "rollStart") return { t: "setupRoll" };

  // Rounds 1-3: drop a colony on the best open Catanian Colonies site.
  if (su.round >= 1 && su.round <= 3) {
    const site = bestColonySite(state);
    if (site) return { t: "setupPlaceColony", intersectionId: site };
    return null;
  }

  // Round 4: upgrade a colony, place a ship, then take a bonus upgrade.
  if (su.round === 4) {
    if (su.r4step === "upgrade") {
      const colony = state.buildings.find((b) => b.owner === me.id && b.kind === "colony");
      if (colony) return { t: "setupUpgrade", intersectionId: colony.intersectionId };
      return null;
    }
    if (su.r4step === "ship") {
      const sites = shipLaunchSites(me, state);
      const launch = sites[0];
      if (launch) return { t: "setupPlaceShip", shipKind: "colonyShip", intersectionId: launch };
      return null;
    }
    if (su.r4step === "bonus") {
      const pool = su.bonusPool ?? [];
      const pick = pool.includes("booster") ? "booster" : pool[0];
      if (pick) return { t: "setupBonus", upgrade: pick };
      return null;
    }
  }
  return null;
}

/** Pick the colony site whose two planets give the best production (pips × value). */
function bestColonySite(state: GameState): string | null {
  const sites = catanianColonySites(state);
  if (sites.length === 0) return null;
  const planetById = new Map<string, { res: Resource; num: number | null }>();
  for (const sec of state.sectors) {
    for (const p of sec.planets) {
      const res = ({ red: "ore", orange: "fuel", blue: "carbon", green: "food", multicolor: "goods" } as const)[p.color];
      planetById.set(p.id, { res, num: p.number });
    }
  }
  const pip = (n: number | null): number => (n == null ? 0 : 6 - Math.abs(7 - n));
  let best: string | null = null;
  let bestScore = -1;
  for (const id of sites) {
    const inter = state.intersections[id];
    if (!inter) continue;
    let score = 0;
    for (const pid of inter.adjacentPlanets) {
      const info = planetById.get(pid);
      if (info) score += pip(info.num) * RES_VALUE[info.res];
    }
    if (score > bestScore) {
      bestScore = score;
      best = id;
    }
  }
  return best;
}

function tradeBuildAction(state: GameState, me: PlayerState): ClientIntent {
  // If I already have a live offer on the table, resolve it: take the best
  // acceptable response, otherwise withdraw it so the turn can continue.
  const mine = state.phaseState.pendingTrade;
  if (mine && mine.fromId === me.id) {
    const decision = resolveMyOffer(me, mine);
    if (decision) return decision;
  }

  // After a 7: steal from the opponent holding the most cards.
  if (state.phaseState.awaitingSteal) {
    let target: PlayerState | null = null;
    for (const p of state.players) {
      if (p.id === me.id) continue;
      if (handTotal(p) <= 0) continue;
      if (!target || handTotal(p) > handTotal(target)) target = p;
    }
    if (target) return { t: "stealTarget", targetId: target.id };
  }

  // Block until everyone (incl. the human) has resolved forced discards.
  if (state.phaseState.pendingDiscards && Object.keys(state.phaseState.pendingDiscards).length > 0) {
    return { t: "endTradeBuild" }; // engine rejects if discards pending; harmless retry
  }

  const k = knobs(state);

  const canBuildColonyShip =
    canAfford(me.hand, BUILD_COSTS.colonyShip) &&
    me.supply.transportShips > 0 &&
    me.supply.colonies > 0 &&
    hasOpenSpaceportSite(state, me) &&
    countOwnShips(state, me, "colonyShip") < k.maxColonyShips;

  // 0. Fly-further AIs (hard) push a new colony ship outward BEFORE converting a
  //    home colony into a spaceport — they colonise mid/far space first.
  if (k.expandFirst && canBuildColonyShip) {
    return { t: "build", what: "colonyShip" };
  }

  // 1. Upgrade a colony to a spaceport (net +1 VP, and a new launch pad for
  //    expanding farther out). Prefer the colony farthest from home; the hard
  //    AI only upgrades colonies already out past the inner cluster.
  const upgradeColony = bestSpaceportColony(state, me, k.spaceportMinDistFrac);
  if (upgradeColony && canAfford(me.hand, BUILD_COSTS.spaceport)) {
    return { t: "build", what: "spaceport", targetId: upgradeColony.intersectionId };
  }

  // 2. Build a colony ship to expand, if we have a launch site and transport.
  //    Harder AIs keep several colony ships in flight to grab sites on multiple
  //    fronts before opponents can.
  if (canBuildColonyShip) {
    return { t: "build", what: "colonyShip" };
  }

  // 3. Build a trade ship to race toward an outpost dock — a friendship marker
  //    is worth +2 VP. Harder AIs keep several in flight to grab more outposts.
  if (
    k.buildTradeShips &&
    canAfford(me.hand, BUILD_COSTS.tradeShip) &&
    me.supply.transportShips > 0 &&
    me.supply.tradeStations > 0 &&
    hasOpenSpaceportSite(state, me) &&
    countOwnShips(state, me, "tradeShip") < k.maxTradeShips &&
    openDockExists(state)
  ) {
    return { t: "build", what: "tradeShip" };
  }

  // 3a. Fly further: a couple of early boosters so the fleet reaches deep space
  //     instead of settling whatever's nearest home (hard AI).
  if (
    k.earlyBoosters &&
    me.upgrades.booster < 2 &&
    canAfford(me.hand, BUILD_COSTS.booster) &&
    countShips(state, me) > 0
  ) {
    return { t: "build", what: "booster" };
  }

  // 3b. Freight pods are the gate the AI used to ignore: docking a trade station
  //     requires MORE pods than stations already at that outpost (so the first
  //     station needs ≥1), and terraforming an ice planet needs pods ≥ its
  //     threshold (+1 VP medal). Build toward whichever goal is higher.
  const podGoal = freightPodGoal(state, me, k);
  if (
    me.upgrades.freightPod < podGoal &&
    canAfford(me.hand, BUILD_COSTS.freightPod)
  ) {
    return { t: "build", what: "freightPod" };
  }

  // 4. Cannons conquer pirate bases (each cleared base = +1 VP) and win pirate
  //    encounters. Build toward the easiest standing base's strength.
  const cannonGoal = cannonBuildGoal(state, me, k);
  if (
    me.upgrades.cannon < cannonGoal &&
    canAfford(me.hand, BUILD_COSTS.cannon)
  ) {
    return { t: "build", what: "cannon" };
  }

  // 4a. Trade toward a pod/cannon goal so the AI can actually take outposts and
  //     ice/pirate planets instead of stalling for lack of one resource.
  if (podGoal > me.upgrades.freightPod) {
    const t = bankTradeToward(me, BUILD_COSTS.freightPod);
    if (t) return t;
  }
  if (cannonGoal > me.upgrades.cannon) {
    const t = bankTradeToward(me, BUILD_COSTS.cannon);
    if (t) return t;
  }

  // 4b. If a colony is waiting to become a spaceport (+1 VP), funnel spare
  //     resources toward its carbon/food cost BEFORE spending fuel on boosters —
  //     otherwise the AI hoards dead-end boosters and never converts colonies
  //     into victory points, stalling games short of 15.
  if (upgradeColony) {
    const towardSpaceport = bankTradeToward(me, BUILD_COSTS.spaceport);
    if (towardSpaceport) return towardSpaceport;
  }

  // 5. A booster helps every ship reach farther.
  if (
    canAfford(me.hand, BUILD_COSTS.booster) &&
    me.upgrades.booster < k.boosterCap &&
    countShips(state, me) > 0
  ) {
    return { t: "build", what: "booster" };
  }

  // 6. Bank-trade toward our next expansion build if one resource short with surplus.
  const trade =
    bankTradeToward(me, BUILD_COSTS.spaceport) ?? bankTradeToward(me, BUILD_COSTS.colonyShip);
  if (trade) return trade;

  // 7. Otherwise initiate a player-to-player offer (once per turn) to fill a gap
  //    toward a useful build that the bank can't cover from our surplus. Every
  //    difficulty now does this — the AI actively trades on its turn.
  if (k.proposeTrades && (state.phaseState.tradeProposals ?? 0) === 0 && !state.phaseState.pendingTrade) {
    const offer =
      proposeToward(me, BUILD_COSTS.spaceport) ??
      proposeToward(me, BUILD_COSTS.colonyShip) ??
      proposeToward(me, BUILD_COSTS.tradeShip) ??
      proposeToward(me, BUILD_COSTS.freightPod) ??
      proposeToward(me, BUILD_COSTS.cannon);
    if (offer) return offer;
  }

  return { t: "endTradeBuild" };
}

/**
 * Evaluate the responses to my own broadcast offer. Finalize with the partner
 * giving me the best net value (>= 0). If nobody offers an acceptable deal and
 * every opponent has weighed in, withdraw the offer so my turn can proceed.
 */
function resolveMyOffer(me: PlayerState, offer: NonNullable<GameState["phaseState"]["pendingTrade"]>): ClientIntent | null {
  const value = (bag: Partial<ResourceBag>) =>
    RESOURCES.reduce((s, r) => s + (bag[r] ?? 0) * RES_VALUE[r], 0);

  let bestId: string | null = null;
  let bestNet = -Infinity;
  for (const resp of offer.responses) {
    if (resp.kind === "decline") continue;
    const give = resp.kind === "counter" ? resp.give ?? {} : offer.give;
    const want = resp.kind === "counter" ? resp.want ?? {} : offer.want;
    // I can only finalize a deal whose `give` side I can still cover.
    if (!RESOURCES.every((r) => me.hand[r] >= (give[r] ?? 0))) continue;
    const net = value(want) - value(give); // resources I gain minus resources I pay
    if (net > bestNet) {
      bestNet = net;
      bestId = resp.playerId;
    }
  }

  if (bestId && bestNet >= 0) return { t: "finalizeTrade", withId: bestId };
  // No worthwhile deal on the table — drop the offer (AI responders answer
  // synchronously, so by now everyone who would has responded).
  return { t: "cancelTrade" };
}

/**
 * Build a fair player offer toward `cost`: give one unit of our most abundant
 * non-needed resource for one unit of the resource we're short on. Returns null
 * if we already meet the cost or lack a comfortable surplus to part with.
 */
function proposeToward(me: PlayerState, cost: Partial<ResourceBag>): ClientIntent | null {
  const need = RESOURCES.find((r) => me.hand[r] < (cost[r] ?? 0));
  if (!need) return null;
  // Most-abundant resource we don't need for this build and can spare (keep >=2).
  let surplus: Resource | null = null;
  for (const r of RESOURCES) {
    if (r === need) continue;
    const spare = me.hand[r] - (cost[r] ?? 0);
    if (spare >= 3 && (!surplus || me.hand[r] > me.hand[surplus])) surplus = r;
  }
  if (!surplus) return null;
  return { t: "proposeTrade", give: { [surplus]: 1 }, want: { [need]: 1 } };
}

function flightAction(state: GameState, me: PlayerState): ClientIntent {
  // Resolve a friendship-ability choice from a just-built trade station.
  const pf = state.phaseState.pendingFriendship;
  if (pf && pf.playerId === me.id && pf.options.length > 0) {
    return { t: "chooseFriendship", cardId: pf.options[0]! };
  }
  if (!state.phaseState.shake) return { t: "shakeMothership" };
  const speed = state.phaseState.moveBudget ?? state.phaseState.shake.speed;

  const myShips = state.ships.filter((s) => s.owner === me.id);
  for (const ship of myShips) {
    // Already on a target → establish. Colony ships settle open sites (including
    // ice/pirate planets they can now clear for a +1 VP medal); trade ships dock
    // only where they actually carry enough freight pods (> stations already
    // there) — otherwise the engine rejects it and the turn stalls.
    if (ship.kind === "colonyShip" && isSettleableSite(state, me, ship.intersectionId)) {
      return { t: "establishColony", shipId: ship.id };
    }
    if (
      ship.kind === "tradeShip" &&
      isOpenDock(state, ship.intersectionId) &&
      canDockHere(state, me, ship.intersectionId)
    ) {
      const dock = freeDockIndex(state, ship.intersectionId);
      return { t: "establishTradeStation", shipId: ship.id, dock };
    }
  }

  for (const ship of myShips) {
    if (ship.movedThisTurn) continue;
    // An encounter may freeze one ship for the turn — never try to move it, or the
    // engine rejects every move and the turn can't advance.
    if (state.phaseState.frozenShipId === ship.id) continue;
    // A ship may move repeatedly until its cumulative distance reaches its speed.
    const remaining = speed - ship.distanceMoved;
    if (remaining <= 0) continue;
    const targetTest =
      ship.kind === "colonyShip"
        ? (id: string) => isSettleableSite(state, me, id)
        : (id: string) => isOpenDock(state, id) && canDockHere(state, me, id);
    let step = moveTowardTarget(state, ship.intersectionId, targetTest, remaining);
    // A trade ship with no dock it can yet afford still pushes toward the nearest
    // open dock so it's in position once a pod is built next turn.
    if (!step && ship.kind === "tradeShip") {
      step = moveTowardTarget(state, ship.intersectionId, (id) => isOpenDock(state, id), remaining);
    }
    if (step && step.length > 0) {
      return { t: "moveShip", shipId: ship.id, path: step };
    }
  }

  return { t: "endTurn" };
}

// --- board helpers ------------------------------------------------------------

function countShips(state: GameState, me: PlayerState): number {
  return state.ships.filter((s) => s.owner === me.id).length;
}

function countOwnShips(state: GameState, me: PlayerState, kind: "colonyShip" | "tradeShip"): number {
  return state.ships.filter((s) => s.owner === me.id && s.kind === kind).length;
}

function meHasTradeShip(state: GameState, me: PlayerState): boolean {
  return state.ships.some((s) => s.owner === me.id && s.kind === "tradeShip");
}

/** Any unoccupied outpost docking point still open anywhere on the board. */
function openDockExists(state: GameState): boolean {
  return Object.values(state.intersections).some(
    (inter) => inter.dockingPointOf && !state.buildings.some((b) => b.intersectionId === inter.id),
  );
}

/** Look up a planet object anywhere on the board (AI helper). */
function planetById(state: GameState, planetId: string): Planet | null {
  for (const sec of state.sectors) {
    const pl = sec.planets.find((p) => p.id === planetId);
    if (pl) return pl;
  }
  return null;
}

/** Smallest threshold among standing tokens of `kind`, or null if none remain. */
function smallestSpecialThreshold(state: GameState, kind: "pirateBase" | "icePlanet"): number | null {
  let best: number | null = null;
  for (const sec of state.sectors) {
    for (const p of sec.planets) {
      if (p.special !== kind) continue;
      const v = p.specialValue ?? 0;
      if (best === null || v < best) best = v;
    }
  }
  return best;
}

/** Can this player clear `planet`'s token right now (conservative — ignores civ bonuses)? */
function canClearSpecial(me: PlayerState, planet: Planet): boolean {
  const v = planet.specialValue ?? 0;
  if (planet.special === "pirateBase") return me.upgrades.cannon >= v;
  if (planet.special === "icePlanet") return me.upgrades.freightPod >= v;
  return true;
}

/**
 * Target number of freight pods the AI should own: at least 1 to dock the first
 * trade station (the rule that previously blocked every AI dock), and enough to
 * terraform the easiest reachable ice planet for a +1 VP medal.
 */
function freightPodGoal(state: GameState, me: PlayerState, k: Knobs): number {
  let goal = 0;
  if (
    k.buildTradeShips &&
    openDockExists(state) &&
    (meHasTradeShip(state, me) || me.supply.tradeStations > 0)
  ) {
    goal = Math.max(goal, 1);
  }
  if (k.clearSpecials && me.supply.colonies > 0) {
    const ice = smallestSpecialThreshold(state, "icePlanet");
    if (ice !== null) goal = Math.max(goal, ice);
  }
  return Math.min(goal, MAX_UPGRADES.freightPod);
}

/** Target cannon count: enough to defeat the easiest pirate base (+1 VP medal). */
function cannonBuildGoal(state: GameState, me: PlayerState, k: Knobs): number {
  if (!k.buildCannons) return 0;
  let goal = 0;
  if (k.clearSpecials && me.supply.colonies > 0) {
    const pirate = smallestSpecialThreshold(state, "pirateBase");
    if (pirate !== null) goal = Math.max(goal, pirate);
  }
  return Math.min(goal, MAX_UPGRADES.cannon);
}

/** A trade ship here can dock only with MORE freight pods than stations already present. */
function canDockHere(state: GameState, me: PlayerState, id: string): boolean {
  const outpostId = state.intersections[id]?.dockingPointOf;
  if (!outpostId) return false;
  const existing = state.tradeStations.filter((t) => t.outpostId === outpostId).length;
  return me.upgrades.freightPod > existing;
}

/**
 * Pick the player's colony to upgrade into a spaceport. Prefer the colony
 * farthest from the board centre so the fleet pushes outward from the crowded
 * home systems and claims sites/outposts on the frontier.
 *
 * `minDistFrac` (hard AI) skips colonies inside that fraction of the map radius,
 * so spaceports only go up out in mid/far space — not on the starting cluster.
 * If no colony qualifies and the AI can no longer expand outward, it falls back
 * to the farthest colony it has so it still converts VP rather than stalling.
 */
function bestSpaceportColony(
  state: GameState,
  me: PlayerState,
  minDistFrac = 0,
): { intersectionId: string } | null {
  const colonies = state.buildings.filter((b) => b.owner === me.id && b.kind === "colony");
  if (colonies.length === 0) return null;

  // Board centre = mean of all intersection positions (home systems cluster here).
  const all = Object.values(state.intersections);
  let cx = 0;
  let cy = 0;
  let maxR = 0;
  for (const inter of all) {
    cx += inter.x;
    cy += inter.y;
  }
  cx /= all.length || 1;
  cy /= all.length || 1;
  for (const inter of all) {
    const d = Math.hypot(inter.x - cx, inter.y - cy);
    if (d > maxR) maxR = d;
  }
  const minDist = minDistFrac * maxR;

  const ranked = colonies
    .map((c) => {
      const inter = state.intersections[c.intersectionId];
      return { c, dist: inter ? Math.hypot(inter.x - cx, inter.y - cy) : 0 };
    })
    .sort((a, b) => b.dist - a.dist);

  const far = ranked.find((r) => r.dist >= minDist);
  if (far) return far.c;
  // No colony out past the gate. Only fall back to a near one when we truly can't
  // expand further (no launch site / out of ships or colonies) — otherwise keep
  // pushing outward and convert a far colony later.
  if (minDistFrac > 0 && hasOpenSpaceportSite(state, me) && me.supply.transportShips > 0 && me.supply.colonies > 0) {
    return null;
  }
  return ranked[0]!.c;
}

function occupied(state: GameState, id: string): boolean {
  return (
    state.buildings.some((b) => b.intersectionId === id) ||
    state.ships.some((s) => s.intersectionId === id)
  );
}

function hasOpenSpaceportSite(state: GameState, me: PlayerState): boolean {
  // Match the engine's launch rule exactly: a new ship needs an OPEN space point
  // *adjacent* to one of your spaceports (not the spaceport's own site). Using the
  // engine's own helper avoids the AI repeatedly trying to build ships it can't
  // actually launch (which stalled games when every launch point was occupied).
  return shipLaunchSites(me, state).length > 0;
}

/** Planet ids belonging to the (closed-after-setup) Catanian home systems. */
let _homeIdsCache: { state: GameState; ids: Set<string> } | null = null;
function homePlanetIdSet(state: GameState): Set<string> {
  if (_homeIdsCache && _homeIdsCache.state === state) return _homeIdsCache.ids;
  const ids = new Set<string>();
  for (const sec of state.sectors) {
    if (!sec.home) continue;
    for (const p of sec.planets) ids.add(p.id);
  }
  _homeIdsCache = { state, ids };
  return ids;
}

/**
 * A colony site the AI could settle right now. Like an empty 2-planet system
 * edge, but ice/pirate planets count too once the AI carries enough freight
 * pods / cannons to clear them on contact (each cleared token = +1 VP medal).
 */
function isSettleableSite(state: GameState, me: PlayerState, id: string): boolean {
  const inter = state.intersections[id];
  if (!inter || inter.adjacentPlanets.length !== 2) return false;
  if (state.buildings.some((b) => b.intersectionId === id)) return false;
  // The Catanian home colonies are closed once the game proper starts — the
  // engine rejects building there. Excluding them here is the critical fix that
  // stops AI colony ships parking on a neighbouring home edge and trying (and
  // failing) to establish forever instead of flying out to settle real space.
  const homeIds = homePlanetIdSet(state);
  if (inter.adjacentPlanets.every((pid) => homeIds.has(pid))) return false;
  // A pirate base / ice planet blocks the site unless we can clear it now.
  for (const pid of inter.adjacentPlanets) {
    const pl = planetById(state, pid);
    if (pl && pl.special !== "none" && !canClearSpecial(me, pl)) return false;
  }
  return true;
}

function isOpenDock(state: GameState, id: string): boolean {
  const inter = state.intersections[id];
  if (!inter || !inter.dockingPointOf) return false;
  return !state.buildings.some((b) => b.intersectionId === id);
}

function freeDockIndex(state: GameState, id: string): number {
  const outpostId = state.intersections[id]?.dockingPointOf;
  const used = new Set(
    state.tradeStations.filter((t) => t.outpostId === outpostId).map((t) => t.dock),
  );
  for (let i = 0; i < 5; i++) if (!used.has(i)) return i;
  return 0;
}

/** BFS toward the nearest intersection passing `test`; return the path (steps) we can take now. */
function moveTowardTarget(
  state: GameState,
  start: string,
  test: (id: string) => boolean,
  speed: number,
): string[] | null {
  const prev = new Map<string, string>();
  const seen = new Set<string>([start]);
  const queue: string[] = [start];
  let target: string | null = null;
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur !== start && test(cur)) {
      target = cur;
      break;
    }
    for (const nb of state.intersections[cur]?.neighbors ?? []) {
      if (seen.has(nb)) continue;
      // Don't path *through* an occupied node as a destination, but allow pass-through.
      seen.add(nb);
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  if (!target) return null;

  // Reconstruct full path from start to target.
  const full: string[] = [];
  let node = target;
  while (node !== start) {
    full.unshift(node);
    node = prev.get(node)!;
  }
  if (full.length <= speed && !occupied(state, target)) return full;

  // Too far / blocked endpoint: advance to the farthest unoccupied node within speed.
  for (let i = Math.min(speed, full.length) - 1; i >= 0; i--) {
    const cand = full[i]!;
    if (!occupied(state, cand)) return full.slice(0, i + 1);
  }
  return null;
}

/** If one resource short of `cost` and holding >= ratio surplus elsewhere, trade for it. */
function bankTradeToward(me: PlayerState, cost: Partial<ResourceBag>): ClientIntent | null {
  const need = RESOURCES.find((r) => me.hand[r] < (cost[r] ?? 0));
  if (!need) return null;
  // Use the real per-resource bank ratio (goods 2:1, others 3:1, better with
  // Merchant cards) so the give amount is an exact multiple the engine accepts.
  const surplus = RESOURCES.find((r) => {
    if (r === need) return false;
    const keep = cost[r] ?? 0;
    const ratio = tradeRatioFor(me, r);
    return me.hand[r] - keep >= ratio;
  });
  if (!surplus) return null;
  const ratio = tradeRatioFor(me, surplus);
  return { t: "tradeWithSupply", give: { [surplus]: ratio }, take: { [need]: 1 } };
}
