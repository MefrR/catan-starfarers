import type { ClientIntent, GameState } from "@starfarers/shared";
import type { GameDriver, DevTools } from "./store.js";
import { net } from "../net.js";

type Listener = (state: GameState) => void;

/**
 * LAN multiplayer game driver. Mirrors LocalGame's interface (GameDriver) but the
 * authoritative state lives on the server: dispatch sends an intent over the
 * socket, and fresh state arrives via "state" broadcasts. The UI is identical to
 * single-player — only the transport differs.
 */
export class NetworkGame implements GameDriver {
  readonly humanId: string;
  readonly isMultiplayer = true;
  private state: GameState;
  private listeners = new Set<Listener>();
  private lastError: string | undefined;
  /** Set by the HUD to surface async server rejections (see GameDriver). */
  onError?: (msg: string) => void;

  constructor(initial: GameState, youId: string) {
    this.humanId = youId;
    this.state = initial;
    net.on((msg) => {
      if (msg.t === "state") {
        this.state = msg.state;
        this.emit();
      } else if (msg.t === "error") {
        this.lastError = msg.message;
        // The error arrives after dispatch() returned, so push it to the UI.
        this.onError?.(msg.message);
      }
    });
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

  isHumanTurn(): boolean {
    const active = this.state.players[this.state.phaseState.activePlayerIndex];
    return active?.id === this.humanId;
  }

  /**
   * Send the intent to the server. Errors come back asynchronously as "error"
   * messages; we surface the most recent one if it arrived before this returns.
   */
  dispatch(intent: ClientIntent): string | undefined {
    this.lastError = undefined;
    net.send(intent);
    return this.lastError;
  }

  /** TEMPORARY: dev/testing chat codes enabled online too. The server applies the
   *  "dev" intent to its authoritative state and broadcasts. Remove before release. */
  get dev(): DevTools {
    return {
      encounter: (cardId: number) => net.send({ t: "dev", action: "encounter", n: cardId }),
      upgrades: () => net.send({ t: "dev", action: "upgrades" }),
      friendship: () => net.send({ t: "dev", action: "friendship" }),
      spaceJump: () => net.send({ t: "dev", action: "jump" }),
      vp: (n: number) => net.send({ t: "dev", action: "vp", n }),
      reveal: () => net.send({ t: "dev", action: "reveal" }),
      resources: () => net.send({ t: "dev", action: "resources" }),
    };
  }
}
