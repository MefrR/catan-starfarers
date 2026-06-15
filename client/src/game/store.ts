import {
  createGameState,
  applyIntent,
  RESOURCES,
  type GameState,
  type GameConfig,
  type ClientIntent,
  type SetupMember,
} from "@starfarers/shared";
import { aiObligation, aiTurnAction } from "@starfarers/shared";

type Listener = (state: GameState) => void;

/** Single-player testing hooks (LocalGame only — never wired in multiplayer). */
export interface DevTools {
  /** Force a specific encounter card (1-32) on the human right now. */
  encounter(cardId: number): void;
  /** Max out the human's mothership upgrades. */
  upgrades(): void;
  /** Grant the human one friendship card of every civ. */
  friendship(): void;
  /** Grant the human a free space jump. */
  spaceJump(): void;
  /** Add N victory points to the human (capped near the win). */
  vp(n: number): void;
  /** Reveal the whole map (explore every planet + outpost). */
  reveal(): void;
  /** One-shot grant of a big resource + supply stack (online "warp9"). */
  resources(): void;
}

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
  /** Single-player dev cheat (unlimited resources + supply). Optional: only the
   *  LocalGame driver supports it; LAN games leave it undefined. */
  readonly devMode?: boolean;
  setDevMode?(on: boolean): void;
  /** Single-player testing hooks (undefined in multiplayer). */
  readonly dev?: DevTools;
  /** Multiplayer errors arrive asynchronously (the server rejects an intent after
   *  dispatch() has already returned). The UI sets this so it can still surface
   *  them — e.g. "Not your turn." or "Resolve discards first." */
  onError?: (msg: string) => void;
}

/** AI move pacing (ms) so the human can watch opponents play. */
const AI_DELAY = 750;
/** Encounters resolve far slower so the human can actually read the card and
 *  what the AI chose before it flashes past (5s minimum per AI encounter act). */
const ENCOUNTER_AI_DELAY = 5000;

/** localStorage key for the single-player autosave (one slot). */
const SAVE_KEY = "sf_save1";

interface SaveBlob {
  v: 1;
  state: GameState;
  humanId: string;
  aiIds: string[];
  savedAt: number;
}

/** What the menu needs to offer "Resume voyage" without deserializing twice. */
export interface SaveSummary {
  savedAt: number;
  rivals: string[];
  /** The human's current VP, for the "you were at N VP" hook. */
  myVp: number;
  target: number;
}

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
  /** F4: dev cheat — when on, the human's hand + supply are kept topped up so
   *  builds/cards are effectively unlimited for fast self-testing. */
  private _devMode = false;
  get devMode(): boolean {
    return this._devMode;
  }

  constructor(seats: Seat[], config: Partial<GameConfig> = {}, restore?: SaveBlob) {
    this.id = ++LocalGame.activeId;
    if (restore) {
      this.state = restore.state;
      this.aiIds = new Set(restore.aiIds);
      this.humanId = restore.humanId;
    } else {
      this.state = createGameState(
        seats.map((s) => s.member),
        config,
      );
      this.aiIds = new Set(seats.filter((s) => s.isAI).map((s) => s.member.id));
      this.humanId = seats.find((s) => !s.isAI)?.member.id ?? seats[0]!.member.id;
    }
    this.persist(); // a fresh game claims the save slot immediately
    this.scheduleAI();
  }

  /** Rebuild the last autosaved single-player game, or null if none/finished. */
  static resume(): LocalGame | null {
    const blob = LocalGame.readSave();
    return blob ? new LocalGame([], {}, blob) : null;
  }

  /** Menu peek at the save slot (without constructing a game). */
  static savedGame(): SaveSummary | null {
    const blob = LocalGame.readSave();
    if (!blob) return null;
    const me = blob.state.players.find((p) => p.id === blob.humanId);
    return {
      savedAt: blob.savedAt,
      rivals: blob.state.players.filter((p) => p.id !== blob.humanId).map((p) => p.name),
      myVp: me?.victoryPoints ?? 0,
      target: blob.state.config.targetVictoryPoints,
    };
  }

  static clearSave(): void {
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch {
      /* storage unavailable — nothing to clear */
    }
  }

  private static readSave(): SaveBlob | null {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const blob = JSON.parse(raw) as SaveBlob;
      if (blob?.v !== 1 || !blob.state || !blob.humanId) return null;
      if (blob.state.phaseState.phase === "gameOver") return null;
      return blob;
    } catch {
      return null;
    }
  }

  /** Autosave after every state change; the slot empties itself on game over.
   *  Best-effort: private browsing / full quota must never break the game. */
  private persist(): void {
    try {
      if (this.state.phaseState.phase === "gameOver") {
        localStorage.removeItem(SAVE_KEY);
        return;
      }
      const blob: SaveBlob = {
        v: 1,
        state: this.state,
        humanId: this.humanId,
        aiIds: [...this.aiIds],
        savedAt: Date.now(),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(blob));
    } catch {
      /* best-effort */
    }
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
    if (this._devMode) this.topUpDev();
    this.persist();
    for (const l of this.listeners) l(this.state);
  }

  /** Toggle the dev cheat. Tops up immediately when enabled so the effect is
   *  visible without waiting for the next state change. */
  setDevMode(on: boolean): void {
    this._devMode = on;
    if (on) this.topUpDev();
    this.emit();
  }

  /** Single-player testing hooks, surfaced to the chat-box dev codes. Routed
   *  through the engine's "dev" intent so SP and online share one code path. */
  get dev(): DevTools {
    return {
      encounter: (cardId: number) => void this.dispatch({ t: "dev", action: "encounter", n: cardId }),
      upgrades: () => void this.dispatch({ t: "dev", action: "upgrades" }),
      friendship: () => void this.dispatch({ t: "dev", action: "friendship" }),
      spaceJump: () => void this.dispatch({ t: "dev", action: "jump" }),
      vp: (n: number) => void this.dispatch({ t: "dev", action: "vp", n }),
      reveal: () => void this.dispatch({ t: "dev", action: "reveal" }),
      resources: () => void this.dispatch({ t: "dev", action: "resources" }),
    };
  }

  /** Keep the human flush with resources + personal supply, and never force the
   *  human to discard on a 7, so experimentation isn't gated on the economy.
   *  A moderate stack (not absurd) keeps the rest of the UI sane. */
  private topUpDev(): void {
    const me = this.state.players.find((p) => p.id === this.humanId);
    if (!me) return;
    for (const r of RESOURCES) if (me.hand[r] < 15) me.hand[r] = 25;
    me.supply.colonies = Math.max(me.supply.colonies, 20);
    me.supply.tradeStations = Math.max(me.supply.tradeStations, 20);
    me.supply.transportShips = Math.max(me.supply.transportShips, 20);
    me.supply.shipyards = Math.max(me.supply.shipyards, 20);
    const pd = this.state.phaseState.pendingDiscards;
    if (pd && pd[this.humanId]) pd[this.humanId] = 0;
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
    setTimeout(() => this.stepAI(seatId), this.aiStepDelay());
  }

  /** How long to wait before the AI's next act — slowed right down during an
   *  encounter so the human can read what's happening. */
  private aiStepDelay(): number {
    return this.state.phaseState.phase === "encounter" ? ENCOUNTER_AI_DELAY : AI_DELAY;
  }

  private stepAI(seatId: string): void {
    if (this.id !== LocalGame.activeId) return; // superseded instance
    const active = this.active();
    if (!active || active.id !== seatId) return; // turn already advanced
    const intent = aiTurnAction(this.state, seatId);
    if (!intent) {
      // Nothing to do right now (e.g. waiting on the human to discard) — retry later.
      setTimeout(() => this.stepAI(seatId), this.aiStepDelay());
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
