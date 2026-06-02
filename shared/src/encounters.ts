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

type Awaiting = "number" | "yesno" | "resolve" | "combat" | "selectShip" | "confirm";

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
  resolve: (ctx: EncounterCtx) => void;
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
function closeEncounter(state: GameState, cardId: number): void {
  state.encounterDiscard.push(cardId);
  state.phaseState.encounter = undefined;
  state.phaseState.phase = "flight";
  state.phaseState.moveBudget =
    state.phaseState.moveBudget ?? state.phaseState.shake?.speed ?? POST_ENCOUNTER_BASE_SPEED;
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

function pirateCombat(ctx: EncounterCtx, threshold: number, reward: () => void): void {
  const { subject, rng, log } = ctx;
  const strength = shakeCombat(subject, rng);
  if (strength >= threshold) {
    log(`${subject.name} fights the pirates (combat ${strength} vs ${threshold}) — VICTORY!`);
    reward();
  } else {
    log(`${subject.name} fights the pirates (combat ${strength} vs ${threshold}) — defeat.`);
    gainFame(subject, 1);
    log(`${subject.name} earns 1 fame medal piece for their courage, but a ship is damaged.`);
    damageOneShip(ctx);
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
      if (offer <= 0) {
        const g = takeSpecific(state, subject, "goods", 1);
        if (g) log(`The merchant pities ${subject.name}: +1 goods.`);
      } else if (offer === 1) {
        takeChoice(state, subject, 1);
        gainFame(subject, 1);
        log(`The merchant is flattered: ${subject.name} gains 1 resource + 1 fame.`);
      } else if (offer === 2) {
        takeChoice(state, subject, 2);
        gainFame(subject, 1);
        log(`The merchant is pleased: ${subject.name} gains 2 resources + 1 fame.`);
      } else {
        takeChoice(state, subject, 2);
        gainFame(subject, 2);
        log(`The merchant is delighted: ${subject.name} gains 2 resources + 2 fame.`);
      }
    },
  };
}

/** Pirate posing as a merchant: any gift is stolen, then combat. */
function disguisedPirateCard(id: number): EncounterCard {
  return {
    id,
    category: "merchant",
    prompt: "number",
    title: "A Merchant... or is it?",
    text: "Offer 0-3 resources as a gift.",
    choiceHints: [
      "Offer nothing — then it attacks!",
      "Lose 1 gift, then combat (≥7 → +2 carbon & +1 fame)",
      "Lose 2 gifts, then combat (≥7 → +2 carbon & +1 fame)",
      "Lose 3 gifts, then combat (≥7 → +2 carbon & +1 fame)",
    ],
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      const offer = offerWithinHand(ctx);
      if (offer > 0) {
        requestLoss(ctx, offer);
        log(`It's a pirate in disguise! ${subject.name} must hand over the ${offer} offered resource(s).`);
      } else {
        log(`It's a pirate in disguise!`);
      }
      pirateCombat(ctx, 7, () => {
        takeSpecific(state, subject, "carbon", 2);
        gainFame(subject, 1);
        log(`${subject.name} seizes the pirate's cargo: +2 carbon, +1 fame.`);
      });
    },
  };
}

/** Pirate demands tribute: surrender (yes) or fight (no). */
function pirateDemandCard(id: number, threshold: number): EncounterCard {
  return {
    id,
    category: "pirate",
    prompt: "yesno",
    title: "Space Pirates",
    text: "Pirates demand 2 of your resources. Do you surrender them?",
    yesHint: "Surrender 2 resources — they leave peacefully",
    noHint: `Fight! (combat ≥${threshold} → +2 carbon & +1 fame)`,
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      if (ctx.choice === true) {
        requestLoss(ctx, 2);
        log(`${subject.name} surrenders 2 resources of their choice; the pirates leave peacefully.`);
      } else {
        pirateCombat(ctx, threshold, () => {
          takeSpecific(state, subject, "carbon", 2);
          gainFame(subject, 1);
          log(`${subject.name} seizes the pirate's cargo: +2 carbon, +1 fame.`);
        });
      }
    },
  };
}

/** Distress call: help (yes) costs a resource for fame + upgrade, or refuse (no). */
function distressCard(id: number): EncounterCard {
  return {
    id,
    category: "distress",
    prompt: "yesno",
    title: "Distress Call",
    text: "A stranded ship calls for help. Do you assist?",
    yesHint: "Give 1 resource → +1 fame medal piece & a free upgrade",
    noHint: "Ignore them → −1 fame medal piece",
    resolve: (ctx) => {
      const { subject, log } = ctx;
      if (ctx.choice === true) {
        requestLoss(ctx, 1);
        gainFame(subject, 1);
        const up = addFreeUpgrade(subject);
        log(
          `${subject.name} helps (gives 1 resource of their choice): +1 fame${up ? `, free ${up}` : ""}.`,
        );
      } else {
        loseFame(subject, 1);
        log(`${subject.name} ignores the distress call: -1 fame.`);
      }
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
      if (offer <= 0) {
        log("The travelers shrug and drift away.");
      } else if (offer === 1) {
        gainFame(subject, 1);
        log(`The travelers are grateful: ${subject.name} +1 fame.`);
      } else if (offer === 2) {
        gainFame(subject, 1);
        const up = addFreeUpgrade(subject);
        log(`The travelers reward ${subject.name}: +1 fame${up ? `, free ${up}` : ""}.`);
      } else {
        gainFame(subject, 2);
        const up = addFreeUpgrade(subject);
        log(`The travelers honor ${subject.name}: +2 fame${up ? `, free ${up}` : ""}.`);
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
    title: "Wear and Tear",
    text: `Each player with more than ${threshold} upgrades removes one.`,
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

/** Pure-bounty auto cards: fame / free upgrade / resources, no choice. */
function bountyCard(id: number, kind: "fame" | "upgrade" | "resources"): EncounterCard {
  const text =
    kind === "fame"
      ? "You are celebrated across the galaxy."
      : kind === "upgrade"
        ? "An ally gifts you new technology."
        : "You salvage a derelict freighter.";
  return {
    id,
    category: "bounty",
    prompt: "confirm",
    title: "Fortune",
    text,
    resolve: (ctx) => {
      const { state, subject, log } = ctx;
      if (kind === "fame") {
        gainFame(subject, 1);
        log(`${subject.name} receives 1 fame medal piece.`);
      } else if (kind === "upgrade") {
        const up = addFreeUpgrade(subject);
        log(up ? `${subject.name} installs a free ${up}.` : `${subject.name}'s upgrades are maxed.`);
      } else {
        takeChoice(state, subject, 2);
        log(`${subject.name} salvages 2 resources.`);
      }
    },
  };
}

// --- the deck (32 cards) ------------------------------------------------------

function buildDeck(): Record<number, EncounterCard> {
  const cards: EncounterCard[] = [
    merchantCard(1),
    merchantCard(2),
    merchantCard(3),
    merchantCard(4),
    merchantCard(5),
    merchantCard(6),
    disguisedPirateCard(7),
    disguisedPirateCard(8),
    pirateDemandCard(9, 5),
    pirateDemandCard(10, 6),
    pirateDemandCard(11, 7),
    pirateDemandCard(12, 7),
    pirateDemandCard(13, 8),
    pirateDemandCard(14, 8),
    pirateDemandCard(15, 9),
    pirateDemandCard(16, 10),
    distressCard(17),
    distressCard(18),
    distressCard(19),
    distressCard(20),
    bountyCard(21, "fame"),
    bountyCard(22, "fame"),
    bountyCard(23, "upgrade"),
    bountyCard(24, "upgrade"),
    bountyCard(25, "resources"),
    bountyCard(26, "resources"),
    travelerCard(27),
    travelerCard(28),
    travelerCard(29),
    travelerCard(30),
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
  const subject = state.players.find((p) => p.id === enc.subjectId)!;
  card.resolve({ state, subject, choice: 0, rng, log: (line) => logTo(state, line) });
  state.encounterDiscard.push(enc.cardId);
  state.phaseState.encounter = undefined;
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
    closeEncounter(state, enc.cardId);
    return;
  }
  if (enc.awaiting === "selectShip") {
    applyShipFreeze(state, enc.subjectId, choice);
    enc.pendingSteps?.shift();
    if (advanceEncounterSteps(state)) return;
    closeEncounter(state, enc.cardId);
    return;
  }

  // First decision: run the card's main outcome, which may queue follow-up steps
  // (surrender resources of your choice, immobilize a ship on a combat defeat).
  const card = ENCOUNTER_CARDS[enc.cardId]!;
  const subject = state.players.find((p) => p.id === enc.subjectId)!;
  card.resolve({ state, subject, choice, rng, log: (line) => logTo(state, line) });

  if (advanceEncounterSteps(state)) return; // waiting on a queued decision

  // After an encounter the base speed is 3, but boosters (and the Scientist
  // "Improved Boosters" friendship) STILL add to it — the shake already folded
  // those into shake.speed (POST_ENCOUNTER_BASE_SPEED + boosters + bonus).
  closeEncounter(state, enc.cardId);
}
