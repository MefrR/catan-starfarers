import {
  PLAYER_COLORS,
  DEFAULT_TARGET_VP,
  VP_MIN,
  VP_MAX,
  type AiDifficulty,
  type GameConfig,
  type PlayerColor,
  type SetupMember,
} from "@starfarers/shared";
import type { Seat } from "../game/store.js";
import { LocalGame } from "../game/store.js";
import { shatter } from "./fx.js";
import { auth } from "../auth.js";
import { el, escapeHtml } from "./dom.js";

const COLOR_NAME: Record<PlayerColor, string> = {
  yellow: "Yellow",
  red: "Red",
  blue: "Blue",
  black: "Black",
  green: "Green",
  white: "White",
};

const COLOR_HEX: Record<PlayerColor, string> = {
  yellow: "#ffd23f",
  red: "#ff5d5d",
  blue: "#4fa8ff",
  black: "#8a8fa6",
  green: "#52d273",
  white: "#e9eef7",
};

const AI_NAMES = ["Nova", "Orion", "Vega", "Lyra", "Atlas", "Cygnus"];

export interface LaunchOptions {
  seats: Seat[];
  config: Partial<GameConfig>;
}

/**
 * Single-player setup screen — an OPEN mission-briefing layout floating
 * directly on the comet field (no boxed card): labelled rows with segmented
 * controls, round color swatches, and a big rotating-glow LAUNCH GAME that
 * shatters on click.
 */
export class NewGameMenu {
  private root: HTMLElement;
  private onLaunch: (opts: LaunchOptions) => void;
  private onBack: (() => void) | undefined;
  /** Resume the autosaved single-player game (offered only when one exists). */
  private onResume: (() => void) | undefined;
  private color: PlayerColor = "yellow";
  private opponents = 2; // AI rivals; minimum 1 (solo play disabled — needs 2 players)
  private fogMap = false;
  private aiDifficulty: AiDifficulty = "normal";
  private turnSeconds = 0; // 0 = no turn timer
  private botSpeed: "relaxed" | "normal" | "fast" = "normal";
  private targetVP = DEFAULT_TARGET_VP;
  private hideBank = false;
  /** #15/#16 map layout: official (fixed recommended board) / balanced (random,
   *  fair) / unbalanced (random, raw). Default official. */
  private layout: "official" | "balanced" | "unbalanced" = "official";
  private deck36Dice = false;
  /** Reserve-pile limitation: on (default) = finite pools; off = unlimited resources. */
  private reservePileLimit = true;

  /** When signed in, default the commander name to the profile's display name. */
  private defaultName = "Commander";

  constructor(
    mount: HTMLElement,
    onLaunch: (opts: LaunchOptions) => void,
    onBack?: () => void,
    onResume?: () => void,
  ) {
    this.root = mount;
    this.onLaunch = onLaunch;
    this.onBack = onBack;
    this.onResume = onResume;
    // AB4: seed the commander identity from the signed-in profile so your name
    // and favorite color are pre-filled (you can still change them per game).
    const profile = auth.currentProfile();
    if (profile) {
      this.defaultName = profile.displayName;
      this.color = profile.favoriteColor;
    }
    this.render();
  }

  private render(): void {
    // Offer to resume the last autosaved single-player game, if there is one.
    const saved = this.onResume ? LocalGame.savedGame() : null;
    const resumeHtml = saved
      ? `<div class="setup-row">
          <div class="setup-label">Continue</div>
          <div class="setup-ctrl">
            <button class="resume-card" id="resume">
              <span class="resume-card-title">Resume last voyage</span>
              <span class="resume-card-sub">${saved.myVp}/${saved.target} VP vs ${escapeHtml(saved.rivals.join(", ") || "—")}</span>
            </button>
          </div>
        </div>`
      : "";
    const screen = el(`
      <div class="screen">
        <div class="setup">
          <div class="setup-head">
            <div class="setup-kicker">Mission setup</div>
            <h1 class="setup-title">PREPARE FOR LAUNCH</h1>
          </div>
          ${resumeHtml}

          <div class="setup-row">
            <div class="setup-label">Commander</div>
            <div class="setup-ctrl setup-identity">
              <input type="text" id="name" class="setup-name" placeholder="Commander" maxlength="16" value="Commander" />
              <div class="swatches" id="colors"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Rivals</div>
            <div class="setup-ctrl">
              <div class="seg" id="opponents"></div>
              <div class="seg" id="difficulty"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Galaxy</div>
            <div class="setup-ctrl">
              <div class="seg seg-wide" id="mapstyle"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Bot speed</div>
            <div class="setup-ctrl">
              <div class="seg" id="botspeed"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Victory target</div>
            <div class="setup-ctrl">
              <div class="seg" id="vptarget"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Map layout</div>
            <div class="setup-ctrl">
              <div class="variant-chips layout-chips" id="maplayout"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Variants</div>
            <div class="setup-ctrl">
              <div class="variant-chips" id="variants"></div>
            </div>
          </div>

          <div class="setup-row">
            <div class="setup-label">Turn timer</div>
            <div class="setup-ctrl">
              <div class="seg" id="turntimer"></div>
            </div>
          </div>

          <div class="setup-launch">
            <div class="glow-wrap">
              <div class="glow-layer glow-far"><i></i></div>
              <div class="glow-layer glow-near"><i></i></div>
              <button class="glow-btn" id="launch">LAUNCH GAME</button>
            </div>
            ${this.onBack ? `<button class="setup-back" id="back">← Back</button>` : ""}
          </div>
        </div>
      </div>
    `);

    // --- Color swatches: round player-colored orbs, the picked one ringed. ---
    const colorsRow = screen.querySelector("#colors")!;
    const paintColors = (): void => {
      colorsRow.replaceChildren();
      for (const c of PLAYER_COLORS) {
        const sel = c === this.color;
        const btn = el(
          `<button class="swatch ${sel ? "selected" : ""}" title="${COLOR_NAME[c]}" style="--sw:${COLOR_HEX[c]}"></button>`,
        );
        btn.addEventListener("click", () => {
          this.color = c;
          paintColors();
        });
        colorsRow.appendChild(btn);
      }
    };
    paintColors();

    // --- Segmented controls (joined pill options, one lit). ---
    const seg = (
      host: Element,
      options: { label: string; hint?: string; selected: boolean; pick: () => void }[],
    ): void => {
      host.replaceChildren();
      for (const o of options) {
        const btn = el(
          `<button class="seg-opt ${o.selected ? "on" : ""}">${o.label}${o.hint ? `<span class="seg-hint">${o.hint}</span>` : ""}</button>`,
        );
        btn.addEventListener("click", o.pick);
        host.appendChild(btn);
      }
    };

    const oppRow = screen.querySelector("#opponents")!;
    const paintOpps = (): void =>
      seg(
        oppRow,
        [1, 2, 3].map((n) => ({
          label: `${n} AI`,
          selected: n === this.opponents,
          pick: () => {
            this.opponents = n;
            paintOpps();
          },
        })),
      );
    paintOpps();

    const diffRow = screen.querySelector("#difficulty")!;
    const paintDiff = (): void =>
      seg(
        diffRow,
        (
          [
            { v: "easy", label: "Easy" },
            { v: "normal", label: "Normal" },
            { v: "hard", label: "Hard" },
          ] as { v: AiDifficulty; label: string }[]
        ).map((o) => ({
          label: o.label,
          selected: o.v === this.aiDifficulty,
          pick: () => {
            this.aiDifficulty = o.v;
            paintDiff();
          },
        })),
      );
    paintDiff();

    const mapRow = screen.querySelector("#mapstyle")!;
    const paintMap = (): void =>
      seg(mapRow, [
        {
          label: "Charted",
          hint: "Whole galaxy visible",
          selected: !this.fogMap,
          pick: () => {
            this.fogMap = false;
            paintMap();
          },
        },
        {
          label: "Uncharted",
          hint: "Fog — explore to reveal",
          selected: this.fogMap,
          pick: () => {
            this.fogMap = true;
            paintMap();
          },
        },
      ]);
    paintMap();

    // Turn timer: Off, or 60–300s in 15s steps (− / value / +). Off ↔ 60s.
    // (A Starfarers turn is long — 15s was far too short, so the minimum is 1 min.)
    const timerRow = screen.querySelector("#turntimer")!;
    const paintTimer = (): void => {
      timerRow.replaceChildren();
      const off = el(`<button class="seg-opt ${this.turnSeconds === 0 ? "on" : ""}">Off</button>`);
      off.addEventListener("click", () => { this.turnSeconds = 0; paintTimer(); });
      const minus = el(`<button class="seg-opt" ${this.turnSeconds <= 60 ? "disabled" : ""}>−15s</button>`);
      minus.addEventListener("click", () => { this.turnSeconds = Math.max(60, this.turnSeconds - 15); paintTimer(); });
      const val = el(`<button class="seg-opt seg-val" disabled>${this.turnSeconds === 0 ? "No limit" : this.turnSeconds + "s / turn"}</button>`);
      const plus = el(`<button class="seg-opt" ${this.turnSeconds >= 300 ? "disabled" : ""}>+15s</button>`);
      plus.addEventListener("click", () => { this.turnSeconds = this.turnSeconds === 0 ? 60 : Math.min(300, this.turnSeconds + 15); paintTimer(); });
      timerRow.append(off, minus, val, plus);
    };
    paintTimer();

    // Bot speed — how fast AI seats take their turns.
    const botRow = screen.querySelector("#botspeed")!;
    const paintBot = (): void =>
      seg(
        botRow,
        (
          [
            { v: "relaxed", label: "Relaxed", hint: "Natural pace" },
            { v: "normal", label: "Normal", hint: "Moderate" },
            { v: "fast", label: "Fast", hint: "Zero delay" },
          ] as { v: "relaxed" | "normal" | "fast"; label: string; hint: string }[]
        ).map((o) => ({
          label: o.label,
          hint: o.hint,
          selected: o.v === this.botSpeed,
          pick: () => { this.botSpeed = o.v; paintBot(); },
        })),
      );
    paintBot();

    // Victory target — 12 to 25 VP (− / value / +).
    const vpRow = screen.querySelector("#vptarget")!;
    const paintVP = (): void => {
      vpRow.replaceChildren();
      const minus = el(`<button class="seg-opt" ${this.targetVP <= VP_MIN ? "disabled" : ""}>−</button>`);
      minus.addEventListener("click", () => { this.targetVP = Math.max(VP_MIN, this.targetVP - 1); paintVP(); });
      const val = el(`<button class="seg-opt seg-val" disabled>${this.targetVP} VP</button>`);
      const plus = el(`<button class="seg-opt" ${this.targetVP >= VP_MAX ? "disabled" : ""}>+</button>`);
      plus.addEventListener("click", () => { this.targetVP = Math.min(VP_MAX, this.targetVP + 1); paintVP(); });
      vpRow.append(minus, val, plus);
    };
    paintVP();

    // Gameplay variants — toggle chips.
    const varRow = screen.querySelector("#variants")!;
    const paintVariants = (): void => {
      varRow.replaceChildren();
      const chip = (label: string, hint: string, on: boolean, toggle: () => void): void => {
        const b = el(`<button class="variant-chip ${on ? "on" : ""}" title="${hint}">${label}</button>`);
        b.addEventListener("click", () => { toggle(); paintVariants(); });
        varRow.appendChild(b);
      };
      chip("Hide Bank", "Hide the resource-bank counts", this.hideBank, () => (this.hideBank = !this.hideBank));
      chip("Deck36 Dice", "Even dice distribution (deck of 36)", this.deck36Dice, () => (this.deck36Dice = !this.deck36Dice));
      chip("Reserve Limit", "Reserve pile & bank are finite and can run dry (off = UNLIMITED resources)", this.reservePileLimit, () => (this.reservePileLimit = !this.reservePileLimit));
    };
    paintVariants();

    // #15/#16 — pick one map layout (radio group), each with a small
    // description underneath so players understand the difference at a glance.
    const layoutRow = screen.querySelector("#maplayout")!;
    const paintLayout = (): void => {
      layoutRow.replaceChildren();
      const layoutChip = (title: string, sub: string, mode: "official" | "balanced" | "unbalanced"): void => {
        const on = this.layout === mode;
        const b = el(
          `<button class="variant-chip layout-chip ${on ? "on" : ""}">` +
            `<span class="vc-title">${title}</span><span class="vc-sub">${sub}</span></button>`,
        );
        b.addEventListener("click", () => { this.layout = mode; paintLayout(); });
        layoutRow.appendChild(b);
      };
      layoutChip("Official", "The recommended board — same setup every game", "official");
      layoutChip("Balanced", "Random each game, fair (no 6 next to 8)", "balanced");
      layoutChip("Unbalanced", "Random each game, raw (6 can touch 8)", "unbalanced");
    };
    paintLayout();

    const launchBtn = screen.querySelector("#launch") as HTMLElement;
    launchBtn.addEventListener("click", () => {
      const name = (screen.querySelector("#name") as HTMLInputElement).value.trim() || "Commander";
      const opts: LaunchOptions = {
        seats: this.buildSeats(name),
        config: {
          fogMap: this.fogMap,
          aiDifficulty: this.aiDifficulty,
          turnSeconds: this.turnSeconds,
          targetVictoryPoints: this.targetVP,
          botSpeed: this.botSpeed,
          hideBank: this.hideBank,
          layout: this.layout,
          balancedLayout: this.layout !== "unbalanced",
          deck36Dice: this.deck36Dice,
          reservePileLimit: this.reservePileLimit,
        },
      };
      // The button bursts into shards, then the warp takes us into the game.
      shatter(launchBtn, "#39d8c8", () => this.onLaunch(opts));
    });
    screen.querySelector("#back")?.addEventListener("click", () => this.onBack?.());
    const resumeBtn = screen.querySelector("#resume") as HTMLElement | null;
    resumeBtn?.addEventListener("click", () => {
      shatter(resumeBtn, "#ffd23f", () => this.onResume?.());
    });

    // AB4: prefill the commander name from the signed-in profile.
    (screen.querySelector("#name") as HTMLInputElement).value = this.defaultName;

    this.root.replaceChildren(screen);
  }

  private buildSeats(name: string): Seat[] {
    const others = PLAYER_COLORS.filter((c) => c !== this.color);
    const human: Seat = {
      member: { id: crypto.randomUUID(), name, color: this.color, connected: true },
      isAI: false,
    };
    const ai: Seat[] = [];
    for (let i = 0; i < this.opponents; i++) {
      ai.push({
        member: {
          id: crypto.randomUUID(),
          name: `${AI_NAMES[i % AI_NAMES.length]} (${COLOR_NAME[others[i]!]})`,
          color: others[i]!,
          connected: true,
        },
        isAI: true,
      });
    }
    return [human, ...ai] satisfies Seat[];
  }
}

export type { SetupMember };
