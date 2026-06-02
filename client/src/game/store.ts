import {
  createGameState,
  applyIntent,
  type GameState,
  type GameConfig,
  type ClientIntent,
  type SetupMember,
} from "@starfarers/shared";
import { aiObligation, aiTurnAction } from "./ai.js";

type Listener = (state: GameState) => void;

export interface Seat {
  member: SetupMember;
  isAI: boolean;
}

/**
 * The interface the HUD + board need to drive any game, whether it runs locally
 * (single-player vs AI) or over the network (LAN multiplayer). Both LocalGame and
 * NetworkGame implement it so the UI is transport-agnostic.
 */
export interface GameDriver {
  readonly humanId: string;
  /** True for LAN games (NetworkGame); drives multiplayer-only UI like Play Again. */
  readonly isMultiplayer?: boolean;
  getState(): GameState;
  subscribe(fn: Listener): () => void;
  isHumanTurn(): boolean;
  dispatch(intent: ClientIntent): string | undefined;
}

/** AI move pacing (ms) so the human can watch opponents play. */
const AI_DELAY = 750;

/**
 * Single-player game driver. Holds the authoritative GameState locally, applies
 * the human's intents through the shared engine, and steps AI seats on a timer.
 * The transport is intentionally trivial — for LAN multiplayer this same engine
 * runs on the server and intents travel over the socket instead.
 */
export class LocalGame {
  /** Only the most recently constructed game drives AI timers, so stale
   *  setTimeout chains from a prior game (or a Vite HMR reload) can't fire. */
  private static activeId = 0;
  private readonly id: number;
  private state: GameState;
  private listeners = new Set<Listener>();
  private aiIds: Set<string>;
  readonly humanId: string;

  constructor(seats: Seat[], config: Partial<GameConfig> = {}) {
    this.id = ++LocalGame.activeId;
    this.state = createGameState(
      seats.map((s) => s.member),
      config,
    );
    this.aiIds = new Set(seats.filter((s) => s.isAI).map((s) => s.member.id));
    this.humanId = seats.find((s) => !s.isAI)?.member.id ?? seats[0]!.member.id;
    this.scheduleAI();
  }

  getState(): GameState {
    return this.state;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.state);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }

  private active(): GameState["players"][number] | undefined {
    return this.state.players[this.state.phaseState.activePlayerIndex];
  }

  isHumanTurn(): boolean {
    return this.active()?.id === this.humanId;
  }

  /** Dispatch a human intent. Returns an error string if the engine rejected it. */
  dispatch(intent: ClientIntent): string | undefined {
    if (this.id !== LocalGame.activeId) return "This game is no longer active.";
    const res = applyIntent(this.state, this.humanId, intent);
    if (res.error) return res.error;
    this.state = res.state;
    this.pumpObligations();
    this.emit();
    this.scheduleAI();
    return undefined;
  }

  /** Resolve any AI-owed discards / trade responses immediately (off-turn too). */
  private pumpObligations(): void {
    for (let guard = 0; guard < 64; guard++) {
      let acted = false;
      for (const id of this.aiIds) {
        const intent = aiObligation(this.state, id);
        if (!intent) continue;
        const res = applyIntent(this.state, id, intent);
        if (!res.error) {
          this.state = res.state;
          acted = true;
        }
      }
      if (!acted) break;
    }
  }

  /** If the active seat is an AI (and game is live), step it after a delay. */
  private scheduleAI(): void {
    if (this.id !== LocalGame.activeId) return; // superseded instance
    const active = this.active();
    if (!active || this.state.phaseState.phase === "gameOver") return;
    if (!this.aiIds.has(active.id)) return;
    const seatId = active.id;
    setTimeout(() => this.stepAI(seatId), AI_DELAY);
  }

  private stepAI(seatId: string): void {
    if (this.id !== LocalGame.activeId) return; // superseded instance
    const active = this.active();
    if (!active || active.id !== seatId) return; // turn already advanced
    const intent = aiTurnAction(this.state, seatId);
    if (!intent) {
      // Nothing to do right now (e.g. waiting on the human to discard) — retry later.
      setTimeout(() => this.stepAI(seatId), AI_DELAY);
      return;
    }
    let res = applyIntent(this.state, seatId, intent);
    if (res.error) {
      // The chosen action was rejected. If it's not just a "waiting" case, force
      // phase progress so the AI can never spin on a perpetually-invalid intent.
      const phase = this.state.phaseState.phase;
      const fallback: ClientIntent | null =
        phase === "tradeBuild"
          ? { t: "endTradeBuild" }
          : phase === "flight"
            ? { t: "endTurn" }
            : null;
      if (fallback) {
        const fres = applyIntent(this.state, seatId, fallback);
        if (!fres.error) res = fres;
      }
    }
    if (!res.error) {
      this.state = res.state;
      this.pumpObligations();
      this.emit();
    }
    this.scheduleAI();
  }
}
