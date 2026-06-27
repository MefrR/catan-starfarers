// The 32 encounter cards.
//
// The almanac groups encounters into categories (merchants, pirate combat,
// distress calls, travelers, wear & tear) and each card offers either a
// numeric choice (0-3) or a yes/no question, then resolves a concrete result.
// The card art/OCR isn't reproducible verbatim, so each card here implements a
// faithful version of its category's mechanics with concrete resource/fame
// outcomes. The reducer drives the flow:
//   beginEncounter -> phase "encounter", awaiting a choice
//   resolveEncounter(choice) -> applies the outcome, returns to flight.

import { POST_ENCOUNTER_BASE_SPEED } from "./constants.js";
import { scientistBonus } from "./friendship.js";
import {
  BALL_VALUE,
  MOTHERSHIP_BALLS,
  RESOURCES,
  type GameState,
  type PlayerId,
  type PlayerState,
  type Resource,
  type UpgradeKind,
} from "./types.js";

type Rng = () => number;

type Awaiting = "number" | "yesno" | "resolve" | "combat" | "selectShip" | "confirm" | "duel";

export interface EncounterCard {
  id: number;
  category: "merchant" | "pirate" | "distress" | "traveler" | "wearTear" | "bounty";
  prompt: Awaiting;
  title: string;
  text: string;
  /** Affects EVERY player — the card stays up until all players confirm. */
  allPlayers?: boolean;
  /** Short outcome captions for a number prompt, indexed by the offer (0-3). */
  choiceHints?: string[];
  /** Outcome captions for a yes/no prompt. */
  yesHint?: string;
  noHint?: string;
  /** Wear & Tear: players holding MORE than this many upgrades scrap one (P6i). */
  wearTearThreshold?: number;
  /** "New Encounters": after this card resolves, shuffle the deck and draw a
   *  fresh encounter card for the subject (both Wear & Tear cards do this). */
  newEncounter?: boolean;
  resolve: (ctx: EncounterCtx) => void;
  /** Cards with an interactive duel: applied once both motherships have shaken
   *  (won = the subject's shake ≥ the rival's). */
  resolveDuel?: (ctx: EncounterCtx, won: boolean) => void;
}

interface EncounterCtx {
  state: GameState;
  subject: PlayerState;
  choice: number | boolean;
  rng: Rng;
  log: (line: string) => void;
}

// --- low-level effect helpers -------------------------------------------------

function logTo(state: GameState, line: string): void {
  state.log.push(line);
  if (state.log.length > 200) state.log.splice(0, state.log.length - 200);
}

/** Resource the player holds the least of (helpful auto-pick for "of your choice"). */
function scarcest(p: PlayerState): Resource {
  return RESOURCES.reduce((best, r) => (p.hand[r] < p.hand[best] ? r : best), RESOURCES[0]!);
}

function takeChoice(state: GameState, p: PlayerState, n: number): number {
  let got = 0;
  for (let i = 0; i < n; i++) {
    const r = scarcest(p);
    if (state.supplyBank[r] <= 0) {
      const alt = RESOURCES.find((x) => state.supplyBank[x] > 0);
      if (!alt) break;
      state.supplyBank[alt]--;
      p.hand[alt]++;
    } else {
      state.supplyBank[r]--;
      p.hand[r]++;
    }
    got++;
  }
  return got;
}

function takeSpecific(state: GameState, p: PlayerState, r: Resource, n: number): number {
  const got = Math.min(n, state.supplyBank[r]);
  state.supplyBank[r] -= got;
  p.hand[r] += got;
  return got;
}

function gainFame(p: PlayerState, n: number): void {
  p.fameMedalPieces += n;
}

function loseFame(p: PlayerState, n: number): void {
  p.fameMedalPieces = Math.max(0, p.fameMedalPieces - n);
}

/** Add one free upgrade, preferring whatever helps most and isn't maxed. */
function addFreeUpgrade(p: PlayerState): UpgradeKind | null {
  const order: UpgradeKind[] = ["booster", "cannon", "freightPod"];
  for (const u of order) {
    if (p.upgrades[u] < 6) {
      p.upgrades[u]++;
      return u;
    }
  }
  return null;
}

/** Queue a follow-up player decision onto the active encounter. */
function enqueueStep(
  state: GameState,
  step: { kind: "giveResources"; count: number } | { kind: "selectShip" },
): void {
  const enc = state.phaseState.encounter;
  if (!enc) return;
  (enc.pendingSteps ??= []).push(step);
}

/**
 * Queue a ship-immobilize decision (almanac: "Choose 1 of your ships. It cannot
 * move this turn."). The step auto-resolves later if the subject has 0 or 1 ship.
 */
function damageOneShip(ctx: EncounterCtx): void {
  enqueueStep(ctx.state, { kind: "selectShip" });
}

/** Queue a "hand over N resources of your choice" decision. */
function requestLoss(ctx: EncounterCtx, n: number): void {
  if (n > 0) enqueueStep(ctx.state, { kind: "giveResources", count: n });
}

/** #28: record a reward to grant AFTER the subject pays/donates (applied at
 *  closeEncounter once the giveResources step resolves), instead of inline. */
function deferReward(
  ctx: EncounterCtx,
  reward: { take?: number; fame?: number; freeUpgrade?: boolean; rob?: boolean },
): void {
  const enc = ctx.state.phaseState.encounter;
  if (!enc) return;
  const cur = enc.pendingReward ?? {};
  enc.pendingReward = {
    take: (cur.take ?? 0) + (reward.take ?? 0),
    fame: (cur.fame ?? 0) + (reward.fame ?? 0),
    freeUpgrade: cur.freeUpgrade || reward.freeUpgrade,
    rob: cur.rob || reward.rob,
  };
}

/**
 * Activate the next queued follow-up step, auto-resolving any that present no
 * real choice (no ships / only one ship; hand already at-or-below the amount
 * owed). Returns true if the encounter is now waiting on the subject.
 */
function advanceEncounterSteps(state: GameState): boolean {
  const enc = state.phaseState.encounter;
  if (!enc) return false;
  while (enc.pendingSteps && enc.pendingSteps.length > 0) {
    const step = enc.pendingSteps[0]!;
    const subject = state.players.find((p) => p.id === enc.subjectId)!;
    if (step.kind === "giveResources") {
      const total = RESOURCES.reduce((s, r) => s + subject.hand[r], 0);
      if (total <= step.count) {
        // No choice — surrender the whole hand.
        let lost = 0;
        for (const r of RESOURCES) {
          state.supplyBank[r] += subject.hand[r];
          lost += subject.hand[r];
          subject.hand[r] = 0;
        }
        if (lost > 0) logTo(state, `${subject.name} hands over ${lost} resource(s).`);
        enc.pendingSteps.shift();
        continue;
      }
      enc.awaiting = "giveResources";
      enc.lossCount = step.count;
      return true;
    }
    // selectShip
    const myShips = state.ships.filter((s) => s.owner === subject.id);
    if (myShips.length === 0) {
      enc.pendingSteps.shift();
      continue;
    }
    if (myShips.length === 1) {
      state.phaseState.frozenShipId = myShips[0]!.id;
      logTo(state, `${subject.name}'s ship is damaged and cannot move this turn.`);
      enc.pendingSteps.shift();
      continue;
    }
    enc.awaiting = "selectShip";
    return true;
  }
  return false;
}

/** Apply the subject's chosen resource surrender (the "giveResources" step). */
function applyChosenLoss(
  state: GameState,
  enc: NonNullable<GameState["phaseState"]["encounter"]>,
  resources: Partial<Record<Resource, number>> | undefined,
): void {
  const subject = state.players.find((p) => p.id === enc.subjectId);
  if (!subject) return;
  const want = enc.lossCount ?? 0;
  let took = 0;
  const chosen = resources ?? {};
  for (const r of RESOURCES) {
    if (took >= want) break;
    const take = Math.min(chosen[r] ?? 0, subject.hand[r], want - took);
    subject.hand[r] -= take;
    state.supplyBank[r] += take;
    took += take;
  }
  // Honor the full amount owed even if the chosen bag fell short (AI / mismatch):
  // make up the difference from the subject's most-abundant resources.
  while (took < want) {
    const avail = RESOURCES.filter((r) => subject.hand[r] > 0).sort(
      (a, b) => subject.hand[b] - subject.hand[a],
    );
    if (avail.length === 0) break;
    const r = avail[0]!;
    subject.hand[r]--;
    state.supplyBank[r]++;
    took++;
  }
  enc.lossCount = undefined;
  if (took > 0) logTo(state, `${subject.name} hands over ${took} resource(s).`);
}

/** Apply the chosen ship-freeze (the "selectShip" step). */
function applyShipFreeze(state: GameState, subjectId: PlayerId, choice: number | boolean): void {
  const subject = state.players.find((p) => p.id === subjectId);
  if (!subject) return;
  const myShips = state.ships.filter((s) => s.owner === subject.id);
  if (myShips.length === 0) return;
  const idx = typeof choice === "number" ? Math.floor(choice) : 0;
  const ship = myShips[Math.max(0, Math.min(myShips.length - 1, idx))]!;
  state.phaseState.frozenShipId = ship.id;
  logTo(state, `${subject.name} immobilizes one ship for this flight phase.`);
}

/** Discard the active encounter and return to flight with the proper move budget. */
/** #28: grant any reward that was deferred until after the subject paid/donated.
 *  Runs at close, once all pending steps (the giveResources surrender) are done. */
function applyPendingReward(state: GameState, rng: Rng): void {
  const enc = state.phaseState.encounter;
  const reward = enc?.pendingReward;
  if (!enc || !reward) return;
  const subject = state.players.find((p) => p.id === enc.subjectId);
  if (subject) {
    if (reward.take) takeChoice(state, subject, reward.take);
    if (reward.fame) gainFame(subject, reward.fame);
    if (reward.freeUpgrade) addFreeUpgrade(subject);
    if (reward.rob) robEachOpponent(state, subject, rng, (l) => logTo(state, l));
  }
  enc.pendingReward = undefined;
}

function closeEncounter(state: GameState, cardId: number, rng: Rng): void {
  // Pay-then-reward: the subject's surrender resolved through the pending steps
  // before we reach here, so granting the reward now keeps the order correct.
  const subjectId = state.phaseState.encounter?.subjectId;
  applyPendingReward(state, rng);
  state.encounterDiscard.push(cardId);
  // #38b: recompute post-encounter speed/combat from the subject's CURRENT
  // upgrades. The shake folded boosters in BEFORE the encounter ran, so a free
  // booster/cannon awarded by the card (e.g. a traveler's gift) was missing —
  // post-encounter speed wrongly stayed at the pre-reward value. Recompute now.
  const subject = state.players.find((p) => p.id === subjectId);
  if (subject && state.phaseState.shake) {
    const bonus = scientistBonus(subject);
    state.phaseState.shake.speed = POST_ENCOUNTER_BASE_SPEED + subject.upgrades.booster + bonus.speed;
  }
  state.phaseState.encounter = undefined;
  state.phaseState.phase = "flight";
  state.phaseState.moveBudget = state.phaseState.shake?.speed ?? POST_ENCOUNTER_BASE_SPEED;
}

/** Shake combat strength for a player: 2 balls + cannons + scientist bonus. */
function shakeCombat(p: PlayerState, rng: Rng): number {
  const bag = [...MOTHERSHIP_BALLS];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  const base = BALL_VALUE[bag[0]!] + BALL_VALUE[bag[1]!];
  return base + p.upgrades.cannon + scientistBonus(p).combat;
}

/** Shake speed for a player: 2 balls + boosters + scientist bonus. */
function shakeSpeed(p: PlayerState, rng: Rng): number {
  const bag = [...MOTHERSHIP_BALLS];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [bag[i], bag[j]] = [bag[j]!, bag[i]!];
  }
  return BALL_VALUE[bag[0]!] + BALL_VALUE[bag[1]!] + p.upgrades.booster + scientistBonus(p).speed;
}

/** The opponent `offset` seats away (skipping the subject; wraps; offset may be
 *  negative for "to the left"). Falls back to the nearest other player. */
function relativeOpponent(state: GameState, subject: PlayerState, offset: number): PlayerState | null {
  const n = state.players.length;
  if (n < 2) return null;
  const me = state.players.findIndex((p) => p.id === subject.id);
  for (let step = 0; step < n; step++) {
    const idx = ((me + offset + step * Math.sign(offset || 1)) % n + n) % n;
    if (idx !== me) return state.players[idx]!;
  }
  return state.players.find((p) => p.id !== subject.id) ?? null;
}

/** Begin an INTERACTIVE duel: the subject and a relative rival each shake their
 *  mothership (the rival acts as the pirate/opponent). The card's `resolveDuel`
 *  applies the outcome once both rolls are in. Returns nothing — the encounter
 *  now awaits the shakes. If there's no rival (solo), resolve immediately. */
function setupDuel(ctx: EncounterCtx, offset: number, stat: "combat" | "speed"): void {
  const { state, subject, rng, log } = ctx;
  const opp = relativeOpponent(state, subject, offset);
  const enc = state.phaseState.encounter;
  if (!enc) return;
  if (!opp) {
    // No rival to fight — the subject just shakes against a fixed threshold.
    const mine = stat === "combat" ? shakeCombat(subject, rng) : shakeSpeed(subject, rng);
    const card = ENCOUNTER_CARDS[enc.cardId];
    card?.resolveDuel?.(ctx, mine >= 7);
    return;
  }
  enc.duel = { opponentId: opp.id, stat };
  enc.awaiting = "duel";
  log(`${subject.name} faces off against ${opp.name} — both shake their motherships.`);
}

/**
 * Record one player's duel shake. When both the subject and the rival have
 * shaken, the higher result wins (subject wins ties) and the card's resolveDuel
 * applies the outcome, then the encounter advances/closes. Returns true if the
 * shake was accepted.
 */
export function encounterShake(state: GameState, playerId: PlayerId, rng: Rng): boolean {
  const enc = state.phaseState.encounter;
  if (!enc || enc.awaiting !== "duel" || !enc.duel) return false;
  const subject = state.players.find((p) => p.id === enc.subjectId);
  const opp = state.players.find((p) => p.id === enc.duel!.opponentId);
  if (!subject || !opp) return false;
  const shake = (p: PlayerState): number =>
    enc.duel!.stat === "combat" ? shakeCombat(p, rng) : shakeSpeed(p, rng);
  if (playerId === subject.id && enc.duel.subjectRoll == null) {
    enc.duel.subjectRoll = shake(subject);
    logTo(state, `${subject.name} shakes: ${enc.duel.subjectRoll}.`);
  } else if (playerId === opp.id && enc.duel.oppRoll == null) {
    enc.duel.oppRoll = shake(opp);
    logTo(state, `${opp.name} (the rival) shakes: ${enc.duel.oppRoll}.`);
  } else {
    return false;
  }
  if (enc.duel.subjectRoll != null && enc.duel.oppRoll != null) {
    const won = enc.duel.subjectRoll >= enc.duel.oppRoll;
    const card = ENCOUNTER_CARDS[enc.cardId]!;
    logTo(state, `${subject.name} ${enc.duel.subjectRoll} vs ${opp.name} ${enc.duel.oppRoll} — ${won ? "victory!" : "defeat."}`);
    // Stash the result so the client can reveal both motherships' rolls together
    // (with a WON/LOST verdict) before the outcome resolves.
    state.phaseState.duelResult = {
      subjectId: subject.id,
      opponentId: opp.id,
      subjectRoll: enc.duel.subjectRoll,
      oppRoll: enc.duel.oppRoll,
      won,
      stat: enc.duel.stat,
      seq: (state.phaseState.duelResult?.seq ?? 0) + 1,
    };
    enc.duel = undefined;
    enc.awaiting = "resolve";
    card.resolveDuel?.({ state, subject, choice: won, rng, log: (l) => logTo(state, l) }, won);
    if (advanceEncounterSteps(state)) return true;
    closeEncounter(state, enc.cardId, rng);
  }
  return true;
}

/** Grant a free trade ship: add the piece to supply AND a free-launch credit so
 *  the player can deploy it at no resource cost (launchable in flight or build). */
function grantTradeShip(state: GameState, p: PlayerState, log: (s: string) => void): void {
  p.supply.transportShips++;
  (state.phaseState.freeTradeShips ??= {})[p.id] = (state.phaseState.freeTradeShips[p.id] ?? 0) + 1;
  log(`${p.name} receives a free trade ship — launch it for free next to a spaceport.`);
}

/** Rob 1 random resource from every opponent into the subject's hand. */
function robEachOpponent(state: GameState, subject: PlayerState, rng: Rng, log: (s: string) => void): void {
  for (const p of state.players) {
    if (p.id === subject.id) continue;
    const pool: Resource[] = [];
    for (const r of RESOURCES) for (let i = 0; i < p.hand[r]; i++) pool.push(r);
    if (pool.length === 0) continue;
    const r = pool[Math.floor(rng() * pool.length)]!;
    p.hand[r]--;
    subject.hand[r]++;
  }
  log(`${subject.name} plunders 1 resource from each opponent.`);
}

/** Space-jump reward: grant a free jump the player may use to move ONE of their
 *  ships to any open intersection on the map this flight phase. */
function spaceJumpReward(state: GameState, p: PlayerState, log: (s: string) => void): void {
  (state.phaseState.spaceJumps ??= {})[p.id] = (state.phaseState.spaceJumps[p.id] ?? 0) + 1;
  log(`${p.name} earns a SPACE JUMP — move one ship to any open point on the map.`);
}

/** Remove one of the subject's mothership upgrades (engine-picked order). */
function scrapUpgrade(p: PlayerState, log: (s: string) => void): void {
  const order: UpgradeKind[] = ["freightPod", "cannon", "booster"];
  const u = order.find((k) => p.upgrades[k] > 0);
  if (u) {
    p.upgrades[u]--;
    log(`${p.name} loses a ${u} (ship damaged).`);
  }
}

// --- card builders ------------------------------------------------------------

/** Friendly merchant: offer 0-3 resources, get a scaled reward. */
function merchantCard(id: number): EncounterCard {
  return {
    id,
    category: "merchant",
    prompt: "number",
    title: "A Friendly Merchant",
    text: "Offer 0-3 resources as a gift.",
    choiceHints: [
      "Pity gift: +1 goods",
      "Give 1 → +1 resource & +1 fame medal piece",
      "Give 2 → +2 resources & +1 fame medal piece",
      "Give 3 → +2 resources & +2 fame medal pieces",
    ],
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) {
        requestLoss(ctx, offer);
        log(`${subject.name} offers the merchant ${offer} resource(s) of their choice.`);
      }
      // #28: the reward is DEFERRED — it's granted at closeEncounter, after the
      // subject has actually handed over their offer (the giveResources step).
      if (offer <= 0) {
        const g = takeSpecific(state, subject, "goods", 1); // no payment → grant now
        if (g) log(`The merchant pities ${subject.name}: +1 goods.`);
      } else if (offer === 1) {
        deferReward(ctx, { take: 1, fame: 1 });
        log(`The merchant is flattered: ${subject.name} gains 1 resource + 1 fame.`);
      } else if (offer === 2) {
        deferReward(ctx, { take: 2, fame: 1 });
        log(`The merchant is pleased: ${subject.name} gains 2 resources + 1 fame.`);
      } else {
        deferReward(ctx, { take: 2, fame: 2 });
        log(`The merchant is delighted: ${subject.name} gains 2 resources + 2 fame.`);
      }
    },
  };
}

/**
 * Pirate posing as a merchant. The prompt gives NOTHING away — it looks like a
 * friendly trade. Whatever you offer, it's revealed as a pirate: it grabs your
 * offering and cripples one of your ships (you pick which), then flees. Cards 7
 * and 8 share the mechanic but read differently.
 */
function disguisedPirateCard(id: number): EncounterCard {
  const seven = id === 7;
  return {
    id,
    category: "merchant",
    prompt: "number",
    title: seven ? "A Merchant" : "A Trader Hails You",
    text: "Offer 0-3 resources as a gift.",
    // No choiceHints on purpose — the betrayal is a surprise revealed only
    // after you commit, for the chooser AND spectators.
    resolve: (ctx) => {
      const { subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) requestLoss(ctx, offer); // it grabs whatever you handed over
      damageOneShip(ctx); // and cripples a ship you choose
      log(
        seven
          ? `HA! No merchant at all — a pirate in disguise! It snatched ${subject.name}'s offering, crippled a ship and ran. Choose the ship that can't move this turn.`
          : `It was never a trader — pirates! They blasted one of ${subject.name}'s ships and fled with the goods. Pick the ship that's stuck this turn.`,
      );
    },
  };
}

/** Travelers: donate 0-3 resources for fame / upgrades. */
function travelerCard(id: number): EncounterCard {
  return {
    id,
    category: "traveler",
    prompt: "number",
    title: "Wandering Travelers",
    text: "Donate 0-3 resources to the travelers.",
    choiceHints: [
      "Donate nothing — they drift away",
      "Give 1 → +1 fame medal piece",
      "Give 2 → +1 fame medal piece & a free upgrade",
      "Give 3 → +2 fame medal pieces & a free upgrade",
    ],
    resolve: (ctx) => {
      const { subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) {
        requestLoss(ctx, offer);
        log(`${subject.name} donates ${offer} resource(s) of their choice to the travelers.`);
      }
      // #28: rewards deferred until after the donation is actually handed over.
      if (offer <= 0) {
        log("The travelers shrug and drift away.");
      } else if (offer === 1) {
        deferReward(ctx, { fame: 1 });
        log(`The travelers are grateful: ${subject.name} +1 fame.`);
      } else if (offer === 2) {
        deferReward(ctx, { fame: 1, freeUpgrade: true });
        log(`The travelers reward ${subject.name}: +1 fame & a free upgrade.`);
      } else {
        deferReward(ctx, { fame: 2, freeUpgrade: true });
        log(`The travelers honor ${subject.name}: +2 fame & a free upgrade.`);
      }
    },
  };
}

/** Pull a numeric offer 0-3 out of the committed choice. */
function clampOffer(ctx: EncounterCtx): number {
  const n = typeof ctx.choice === "number" ? Math.floor(ctx.choice) : 0;
  return Math.max(0, Math.min(3, n));
}

/** The committed 0-3 offer, capped to what the subject can actually pay. */
function offerWithinHand(ctx: EncounterCtx): number {
  const total = RESOURCES.reduce((s, r) => s + ctx.subject.hand[r], 0);
  return Math.min(clampOffer(ctx), total);
}

/** Wear & Tear: remove one upgrade from every player above a threshold. */
function wearTearCard(id: number, threshold: number, councilFame: boolean): EncounterCard {
  return {
    id,
    category: "wearTear",
    prompt: "resolve",
    allPlayers: true,
    wearTearThreshold: threshold,
    newEncounter: true, // both W&T cards then shuffle the deck and draw a new card
    title: "Wear and Tear",
    text: `Each player with more than ${threshold} upgrades removes one. Then a new encounter is drawn.`,
    resolve: (ctx) => {
      const { state, log } = ctx;
      // P6i: each over-the-limit player chose which upgrade to scrap (stored on
      // the encounter); honor that pick, falling back to the default order.
      const choices = state.phaseState.encounter?.wearTearChoices ?? {};
      for (const p of state.players) {
        const total = p.upgrades.booster + p.upgrades.cannon + p.upgrades.freightPod;
        if (total > threshold) {
          const order: UpgradeKind[] = ["booster", "cannon", "freightPod"];
          const picked = choices[p.id];
          const u =
            picked && p.upgrades[picked] > 0 ? picked : order.find((k) => p.upgrades[k] > 0);
          if (u) {
            p.upgrades[u]--;
            log(`${p.name} loses a ${u} to wear and tear.`);
          }
        }
      }
      if (councilFame) {
        let max = 0;
        for (const p of state.players) max = Math.max(max, p.upgrades.freightPod);
        if (max > 0) {
          for (const p of state.players) {
            if (p.upgrades.freightPod === max) {
              gainFame(p, 1);
              log(`Galactic Council: ${p.name} has the most freight pods, +1 fame.`);
            }
          }
        }
      }
    },
  };
}

/** Merchant prince: a stingy offer is punished, a generous one earns a ship. */
function merchantPrinceCard(id: number): EncounterCard {
  return {
    id,
    category: "merchant",
    prompt: "number",
    title: "A Merchant Prince",
    text: "Offer 0-3 resources as a gift.",
    choiceHints: [
      "Offer nothing — he sabotages a ship & −1 fame",
      "Give 1 → he's unimpressed, −1 fame",
      "Give 2 → +1 resource & +1 fame medal piece",
      "Give 3 → he gifts you a trade ship",
    ],
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) requestLoss(ctx, offer);
      if (offer <= 0) {
        loseFame(subject, 1);
        damageOneShip(ctx);
        log(`The prince is insulted: −1 fame and a ship is sabotaged.`);
      } else if (offer === 1) {
        loseFame(subject, 1);
        log(`The prince is unimpressed: −1 fame.`);
      } else if (offer === 2) {
        takeChoice(state, subject, 1);
        gainFame(subject, 1);
        log(`The prince is satisfied: +1 resource, +1 fame.`);
      } else {
        grantTradeShip(state, subject, log);
        log(`The prince is delighted and gifts ${subject.name} a trade ship.`);
      }
    },
  };
}

/** A grasping merchant: a small gift lets him shake down your rivals for you. */
function merchantRaiderCard(id: number): EncounterCard {
  return {
    id,
    category: "merchant",
    prompt: "number",
    title: "A Grasping Merchant",
    text: "Offer 0-3 resources as a gift.",
    choiceHints: [
      "Offer nothing — a pity gift: +1 food, −1 fame",
      "Give 1 → he robs each rival for you, but −2 fame",
      "Give 2 → +1 resource & +1 fame medal piece",
      "Give 3 → +2 resources & +1 fame medal piece",
    ],
    resolve: (ctx) => {
      const { state, subject, rng, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) requestLoss(ctx, offer);
      if (offer <= 0) {
        takeSpecific(state, subject, "food", 1);
        loseFame(subject, 1);
        log(`A pity gift: +1 food, −1 fame.`);
      } else if (offer === 1) {
        robEachOpponent(state, subject, rng, log);
        loseFame(subject, 2);
        log(`The galaxy frowns on the shakedown: −2 fame.`);
      } else if (offer === 2) {
        takeChoice(state, subject, 1);
        gainFame(subject, 1);
        log(`Satisfied: +1 resource, +1 fame.`);
      } else {
        takeChoice(state, subject, 2);
        gainFame(subject, 1);
        log(`Delighted: +2 resources, +1 fame.`);
      }
    },
  };
}

/** Pirate demands tribute: surrender (yes) or duel a relative opponent (no). */
function pirateDuelDemandCard(
  id: number,
  offset: number,
  opts: { surrenderFame?: number; winCarbon?: boolean } = {},
): EncounterCard {
  return {
    id,
    category: "pirate",
    prompt: "yesno",
    title: "Space Pirates",
    text: "Pirates demand 2 of your resources. Do you surrender them?",
    yesHint: `Surrender 2 resources${opts.surrenderFame ? ` (−${opts.surrenderFame} fame)` : ""}`,
    noHint: "Fight! Shake vs a rival's strength",
    resolve: (ctx) => {
      const { subject, log } = ctx;
      if (ctx.choice === true) {
        requestLoss(ctx, 2);
        if (opts.surrenderFame) loseFame(subject, opts.surrenderFame);
        log(`${subject.name} hands the pirates 2 resources and they leave.`);
        return;
      }
      setupDuel(ctx, offset, "combat");
    },
    resolveDuel: (ctx, won) => {
      const { state, subject, log } = ctx;
      if (won) {
        if (opts.winCarbon) { takeSpecific(state, subject, "carbon", 2); gainFame(subject, 1); log(`Victory! You blast the pirates and seize 2 carbon and 1 fame.`); }
        else { grantTradeShip(state, subject, log); gainFame(subject, 1); log(`Victory! You capture the pirate ship — a free trade ship and 1 fame.`); }
      } else {
        gainFame(subject, 1);
        scrapUpgrade(subject, log);
        log(`Defeat — your ship is damaged (lose an upgrade), but you earn 1 fame for your courage.`);
      }
    },
  };
}

/** Pirate attacks: flee (yes) on boosters or fight (no) a relative opponent. */
function pirateFleeCard(id: number, offset: number, win: "upgrade" | "ship"): EncounterCard {
  return {
    id,
    category: "pirate",
    prompt: "yesno",
    title: "Pirate Ambush",
    text: "A pirate attacks! Do you flee?",
    yesHint: "Flee — escape if your boosters beat theirs (else fight)",
    noHint: "Stand and fight — shake vs their strength",
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      const opp = relativeOpponent(state, subject, offset);
      if (ctx.choice === true) {
        if (!opp || subject.upgrades.booster >= opp.upgrades.booster) {
          log(`${subject.name} fires the boosters and outruns the pirate — escape!`);
          return;
        }
        log(`${subject.name} is too slow to flee — forced to fight!`);
      }
      setupDuel(ctx, offset, "combat");
    },
    resolveDuel: (ctx, won) => {
      const { state, subject, log } = ctx;
      if (won) {
        if (win === "upgrade") { addFreeUpgrade(subject); gainFame(subject, 1); log(`Victory! You salvage alien tech — a free upgrade and 1 fame.`); }
        else { grantTradeShip(state, subject, log); log(`Victory! You seize the pirate ship — a free trade ship.`); }
      } else {
        if (win === "upgrade") scrapUpgrade(subject, log);
        else damageOneShip(ctx);
        log(`Defeat — the pirate cripples your ship.`);
      }
    },
  };
}

/** Pirate offers to rob your rivals for a bribe: pay 1 (yes), then a shake
 *  decides the outcome; refuse (no) for an honesty fame. */
function pirateBribeCard(id: number, refuseFame: number): EncounterCard {
  return {
    id,
    category: "pirate",
    prompt: "yesno",
    title: "A Pirate's Bargain",
    text: "A pirate offers to rob your rivals for 1 resource. Pay him?",
    yesHint: "Pay 1 resource — then a risky shake decides the haul",
    noHint: refuseFame ? "Refuse — +1 fame for your honesty" : "Refuse and fly on",
    resolve: (ctx) => {
      const { subject, rng, log } = ctx;
      if (ctx.choice !== true) {
        if (refuseFame) gainFame(subject, refuseFame);
        log(`${subject.name} refuses the pirate's bargain.`);
        return;
      }
      requestLoss(ctx, 1);
      // #28: the haul is DEFERRED — the rivals are robbed only after the subject
      // has actually paid the pirate their 1 resource (the giveResources step).
      const roll = Math.floor(rng() * 5) + 1; // 1..5
      if (roll <= 2) {
        deferReward(ctx, { rob: true });
        log(`The pirate takes the coin and raids your rivals…`);
      } else if (roll <= 4) {
        deferReward(ctx, { rob: true });
        loseFame(subject, 1);
        log(`The pirate raids your rivals, but word gets out: −1 fame.`);
      } else {
        loseFame(subject, 1);
        log(`The pirate cheats ${subject.name} and vanishes: −1 fame.`);
      }
    },
  };
}

/** Pirate "fair trade": accept (yes) to swap 1 for 2, then a shake risks the
 *  galactic police; decline (no) for an honesty fame on some cards. */
function pirateTradeCard(id: number, refuseFame: number): EncounterCard {
  return {
    id,
    category: "pirate",
    prompt: "yesno",
    title: "Black-Market Trade",
    text: "Pirates offer 2 resources for 1 of yours. Accept the trade?",
    yesHint: "Trade 1 → 2, but the police might confiscate it",
    noHint: refuseFame ? "Decline — +1 fame for your honesty" : "Decline and fly on",
    resolve: (ctx) => {
      const { state, subject, rng, log } = ctx;
      if (ctx.choice !== true) {
        if (refuseFame) gainFame(subject, refuseFame);
        log(`${subject.name} declines the black-market trade.`);
        return;
      }
      requestLoss(ctx, 1);
      takeChoice(state, subject, 2);
      const roll = Math.floor(rng() * 5) + 1; // 1..5
      if (roll === 3) {
        // Police confiscate the goods just received.
        let conf = 2;
        for (const r of RESOURCES) {
          while (conf > 0 && subject.hand[r] > 0) { subject.hand[r]--; state.supplyBank[r]++; conf--; }
        }
        loseFame(subject, 1);
        log(`Galactic police confiscate the goods: −1 fame.`);
      } else if (roll >= 4) {
        loseFame(subject, 1);
        log(`${subject.name} is accused of trafficking: −1 fame.`);
      } else {
        if (refuseFame) gainFame(subject, refuseFame);
        log(`The trade goes smoothly.`);
      }
    },
  };
}

/** Rescue under fire: choose to fight (yes) a relative opponent, or flee (no). */
function rescueDuelCard(
  id: number,
  offset: number,
  win: "resources" | "goods" | "spaceJump" | "ship",
  refuseFame: number,
): EncounterCard {
  return {
    id,
    category: "distress",
    prompt: "yesno",
    title: "Rescue Under Fire",
    text: "A ship is besieged by pirates. Come to the rescue?",
    yesHint: "Fight the pirates — shake vs their strength",
    noHint: refuseFame ? "Refuse — −1 fame, your cowardice is known" : "Fly on",
    resolve: (ctx) => {
      const { subject, log } = ctx;
      if (ctx.choice !== true) {
        if (refuseFame) loseFame(subject, refuseFame);
        log(`${subject.name} flies on — the galaxy notes the cowardice.`);
        return;
      }
      setupDuel(ctx, offset, "combat");
    },
    resolveDuel: (ctx, won) => {
      const { state, subject, log } = ctx;
      if (won) {
        if (win === "resources") { takeChoice(state, subject, 2); log(`Victory! You drive off the pirates and the grateful crew gives you 2 resources and 1 fame.`); }
        else if (win === "goods") { takeSpecific(state, subject, "goods", 2); log(`Victory! You rescue a merchant — 2 goods and 1 fame.`); }
        else if (win === "ship") { grantTradeShip(state, subject, log); log(`Victory! The rescued ship joins you — a free trade ship and 1 fame.`); }
        else { spaceJumpReward(state, subject, log); log(`Victory! The rescued pilot opens a wormhole — a space jump and 1 fame.`); }
        gainFame(subject, 1);
      } else {
        damageOneShip(ctx);
        log(`Defeat — the pirates damage one of your ships.`);
      }
    },
  };
}

/** Distress near a sun: race to help (yes) on speed, or refuse (no). */
function distressSpeedCard(
  id: number,
  offset: number,
  win: "upgrade" | "ship" | "rob",
  refuseFame: number,
): EncounterCard {
  return {
    id,
    category: "distress",
    prompt: "yesno",
    title: "Distress Call",
    text: "A ship is falling into a sun. Respond to the call?",
    yesHint: "Race to help — shake vs a rival's speed",
    noHint: refuseFame ? "Ignore it — −1 fame" : "Fly on",
    resolve: (ctx) => {
      const { subject, log } = ctx;
      if (ctx.choice !== true) {
        if (refuseFame) loseFame(subject, refuseFame);
        log(`${subject.name} ignores the distress call — the ship falls into the sun.`);
        return;
      }
      setupDuel(ctx, offset, "speed");
    },
    resolveDuel: (ctx, won) => {
      const { state, subject, rng, log } = ctx;
      if (won) {
        if (win === "upgrade") { addFreeUpgrade(subject); log(`You reach the ship in time and rescue a scientist — a free upgrade and 1 fame.`); }
        else if (win === "ship") { grantTradeShip(state, subject, log); log(`You rescue a merchant in time — a free trade ship and 1 fame.`); }
        else { robEachOpponent(state, subject, rng, log); log(`You rescue a benefactor who rewards you — 1 resource from each rival and 1 fame.`); }
        gainFame(subject, 1);
      } else {
        scrapUpgrade(subject, log);
        log(`Too slow — the rescue fails and your ship is damaged.`);
      }
    },
  };
}

/** Wormhole: attempt a space jump (yes) on speed, or decline (no). */
function wormholeCard(id: number, offset: number): EncounterCard {
  return {
    id,
    category: "distress",
    prompt: "yesno",
    title: "A Wormhole",
    text: "A wormhole shimmers ahead. Attempt a space jump?",
    yesHint: "Attempt the jump — shake vs a rival's speed",
    noHint: "Decline and fly on",
    resolve: (ctx) => {
      const { subject, log } = ctx;
      if (ctx.choice !== true) {
        log(`${subject.name} steers clear of the wormhole and flies on.`);
        return;
      }
      setupDuel(ctx, offset, "speed");
    },
    resolveDuel: (ctx, won) => {
      const { state, subject, log } = ctx;
      if (won) {
        spaceJumpReward(state, subject, log);
        log(`You ride the wormhole — a space jump!`);
      } else {
        damageOneShip(ctx);
        log(`The wormhole destabilizes and damages one of your ships.`);
      }
    },
  };
}

/** Travelers reward a space jump on a generous donation. */
function travelerJumpCard(id: number): EncounterCard {
  return {
    id,
    category: "traveler",
    prompt: "number",
    title: "Wandering Travelers",
    text: "Donate 0-3 resources to the travelers.",
    choiceHints: [
      "Donate nothing — they curse you: scrap an upgrade, −1 fame",
      "Give 1 → +1 fame medal piece",
      "Give 2 → they grant a space jump",
      "Give 3 → they grant a space jump",
    ],
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) requestLoss(ctx, offer);
      if (offer <= 0) {
        scrapUpgrade(subject, log);
        loseFame(subject, 1);
        log(`The travelers curse ${subject.name}.`);
      } else if (offer === 1) {
        gainFame(subject, 1);
        log(`The travelers bless ${subject.name}: +1 fame.`);
      } else {
        spaceJumpReward(state, subject, log);
      }
    },
  };
}

/** Travelers gift a trade ship on a generous donation. */
function travelerShipCard(id: number): EncounterCard {
  return {
    id,
    category: "traveler",
    prompt: "number",
    title: "Wandering Travelers",
    text: "Donate 0-3 resources to the travelers.",
    choiceHints: [
      "Donate nothing — they drift away",
      "Give 1 → +1 fame medal piece",
      "Give 2 → +1 fame medal piece",
      "Give 3 → they gift you a trade ship",
    ],
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) requestLoss(ctx, offer);
      if (offer <= 0) {
        log(`The travelers drift away.`);
      } else if (offer <= 2) {
        gainFame(subject, 1);
        log(`The travelers are grateful: +1 fame.`);
      } else {
        grantTradeShip(state, subject, log);
      }
    },
  };
}

// --- the deck (32 cards) ------------------------------------------------------

function buildDeck(): Record<number, EncounterCard> {
  // Rebuilt to mirror the printed encounter deck (offsets: +1 = the player to
  // your right, -1 = your left, ±2 = two seats over). Outcomes stay hidden from
  // the chooser; spectators see the result.
  const cards: EncounterCard[] = [
    // Merchants (friendly offers)
    merchantCard(1),
    merchantCard(2),
    merchantCard(3),
    merchantPrinceCard(4),
    merchantPrinceCard(5),
    merchantRaiderCard(6),
    // Merchant that turns out to be a pirate
    disguisedPirateCard(7),
    disguisedPirateCard(8),
    // Pirates demand tribute — surrender or duel a rival
    pirateDuelDemandCard(9, 1, { winCarbon: true }),
    pirateDuelDemandCard(10, 2, { surrenderFame: 1, winCarbon: true }),
    pirateDuelDemandCard(11, 1, {}),
    // Pirate ambush — flee on boosters or fight
    pirateFleeCard(12, 1, "upgrade"),
    pirateFleeCard(13, -1, "ship"),
    pirateFleeCard(14, -2, "upgrade"),
    // Pirate's bargain — bribe to rob your rivals
    pirateBribeCard(15, 1),
    pirateBribeCard(16, 0),
    // Black-market trade — risk the galactic police
    pirateTradeCard(17, 1),
    pirateTradeCard(18, 0),
    // Rescue a ship under fire (combat vs a rival)
    rescueDuelCard(19, 1, "resources", 1),
    rescueDuelCard(20, 2, "goods", 0),
    rescueDuelCard(21, -1, "spaceJump", 1),
    // Distress near a sun (speed race vs a rival)
    distressSpeedCard(22, 1, "upgrade", 1),
    distressSpeedCard(23, 2, "ship", 0),
    distressSpeedCard(24, -1, "rob", 1),
    // Wormholes — attempt a space jump
    wormholeCard(25, -1),
    wormholeCard(26, 1),
    // Travelers
    travelerCard(27),
    travelerJumpCard(28),
    travelerShipCard(29),
    travelerCard(30),
    // Wear & Tear (all players)
    wearTearCard(31, 8, false),
    wearTearCard(32, 6, true),
  ];
  const table: Record<number, EncounterCard> = {};
  for (const c of cards) table[c.id] = c;
  return table;
}

export const ENCOUNTER_CARDS: Record<number, EncounterCard> = buildDeck();

/** Draw the top encounter card, reshuffling the discard pile if the deck is empty. */
export function beginEncounter(state: GameState, subjectId: PlayerId, rng: Rng): void {
  if (state.encounterDeck.length === 0) {
    const pool = state.encounterDiscard.splice(0);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    state.encounterDeck = pool;
  }
  const cardId = state.encounterDeck.shift();
  if (cardId == null) {
    logTo(state, "No encounter cards remain.");
    return;
  }
  const card = ENCOUNTER_CARDS[cardId]!;
  // Z2: stats — the subject faced an encounter (optional on older saves).
  if (state.stats) {
    state.stats.encountersFaced[subjectId] = (state.stats.encountersFaced[subjectId] ?? 0) + 1;
  }
  state.phaseState.phase = "encounter";
  state.phaseState.encounter = {
    cardId,
    subjectId,
    awaiting: card.prompt,
    ...(card.allPlayers ? { allPlayers: true, confirmedBy: [] } : {}),
  };
  logTo(state, `Encounter: ${card.title} — ${card.text}`);
}

/**
 * Record one player's confirmation of an all-player card (Wear & Tear). The card
 * stays on-screen until EVERY connected player has confirmed; only then does the
 * outcome resolve and the deck advance. Returns true once fully resolved.
 */
export function confirmAllPlayerEncounter(
  state: GameState,
  playerId: PlayerId,
  rng: Rng,
  choice?: number | boolean,
): boolean {
  const enc = state.phaseState.encounter;
  if (!enc || !enc.allPlayers) return false;
  // P6i: a Wear & Tear confirmation may carry which upgrade to scrap, encoded as
  // a 0/1/2 index (booster/cannon/freightPod). Record it for this player.
  if (typeof choice === "number") {
    const map: UpgradeKind[] = ["booster", "cannon", "freightPod"];
    const u = map[Math.max(0, Math.min(2, Math.floor(choice)))];
    if (u) (enc.wearTearChoices ??= {})[playerId] = u;
  }
  enc.confirmedBy = enc.confirmedBy ?? [];
  if (!enc.confirmedBy.includes(playerId)) enc.confirmedBy.push(playerId);
  const everyone = state.players.filter((p) => p.connected).map((p) => p.id);
  const allIn = everyone.every((id) => enc.confirmedBy!.includes(id));
  if (!allIn) return false;
  const card = ENCOUNTER_CARDS[enc.cardId]!;
  const subjectId = enc.subjectId;
  const subject = state.players.find((p) => p.id === subjectId)!;
  card.resolve({ state, subject, choice: 0, rng, log: (line) => logTo(state, line) });
  state.encounterDiscard.push(enc.cardId);
  state.phaseState.encounter = undefined;
  // "New Encounters" (both Wear & Tear cards): shuffle the ENTIRE deck (remaining
  // + discard) and draw a fresh encounter for the subject, instead of returning
  // straight to flight.
  if (card.newEncounter) {
    logTo(state, "New encounters: the deck is reshuffled and a new card is drawn.");
    const pool = [...state.encounterDeck, ...state.encounterDiscard];
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
    }
    state.encounterDeck = pool;
    state.encounterDiscard = [];
    beginEncounter(state, subjectId, rng); // draws the top of the reshuffled deck
    return true;
  }
  state.phaseState.phase = "flight";
  state.phaseState.moveBudget =
    state.phaseState.moveBudget ?? state.phaseState.shake?.speed ?? POST_ENCOUNTER_BASE_SPEED;
  return true;
}

/** Resolve the active encounter with the subject's committed choice. */
export function resolveEncounter(
  state: GameState,
  choice: number | boolean,
  rng: Rng,
  resources?: Partial<Record<Resource, number>>,
): void {
  const enc = state.phaseState.encounter;
  if (!enc) return;

  // Follow-up steps queued by the card's main outcome are resolved here, one at
  // a time. Each finished step is popped, then the next is activated; when none
  // remain the encounter closes.
  if (enc.awaiting === "giveResources") {
    applyChosenLoss(state, enc, resources);
    enc.pendingSteps?.shift();
    if (advanceEncounterSteps(state)) return;
    closeEncounter(state, enc.cardId, rng);
    return;
  }
  if (enc.awaiting === "selectShip") {
    applyShipFreeze(state, enc.subjectId, choice);
    enc.pendingSteps?.shift();
    if (advanceEncounterSteps(state)) return;
    closeEncounter(state, enc.cardId, rng);
    return;
  }

  // First decision: run the card's main outcome, which may queue follow-up steps
  // (surrender resources of your choice, immobilize a ship on a combat defeat).
  const card = ENCOUNTER_CARDS[enc.cardId]!;
  const subject = state.players.find((p) => p.id === enc.subjectId)!;
  card.resolve({ state, subject, choice, rng, log: (line) => logTo(state, line) });

  // The card may have set up an interactive duel (subject vs a rival, each
  // shaking their mothership). If so, keep the encounter open — both seats need
  // the "Shake the mothership" button — instead of closing it out from under them.
  if (state.phaseState.encounter?.awaiting === "duel") return;

  if (advanceEncounterSteps(state)) return; // waiting on a queued decision

  // After an encounter the base speed is 3, but boosters (and the Scientist
  // "Improved Boosters" friendship) STILL add to it — the shake already folded
  // those into shake.speed (POST_ENCOUNTER_BASE_SPEED + boosters + bonus).
  closeEncounter(state, enc.cardId, rng);
}
