import {
  PLAYER_COLORS,
  type AiDifficulty,
  type GameConfig,
  type PlayerColor,
  type SetupMember,
} from "@starfarers/shared";
import type { Seat } from "../game/store.js";
import { shatter } from "./fx.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

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
  private color: PlayerColor = "yellow";
  private opponents = 2; // 0 = play solo (no AI rivals)
  private fogMap = false;
  private aiDifficulty: AiDifficulty = "normal";
  private turnSeconds = 0; // 0 = no turn timer

  constructor(
    mount: HTMLElement,
    onLaunch: (opts: LaunchOptions) => void,
    onBack?: () => void,
  ) {
    this.root = mount;
    this.onLaunch = onLaunch;
    this.onBack = onBack;
    this.render();
  }

  private render(): void {
    const screen = el(`
      <div class="screen">
        <div class="setup">
          <div class="setup-head">
            <div class="setup-kicker">Mission setup</div>
            <h1 class="setup-title">PREPARE FOR LAUNCH</h1>
          </div>

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
        [0, 1, 2, 3].map((n) => ({
          label: n === 0 ? "Solo" : `${n} AI`,
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

    // Turn timer: Off, or 15–180s in 5s steps (− / value / +). Off ↔ 15s.
    const timerRow = screen.querySelector("#turntimer")!;
    const paintTimer = (): void => {
      timerRow.replaceChildren();
      const off = el(`<button class="seg-opt ${this.turnSeconds === 0 ? "on" : ""}">Off</button>`);
      off.addEventListener("click", () => { this.turnSeconds = 0; paintTimer(); });
      const minus = el(`<button class="seg-opt" ${this.turnSeconds <= 15 ? "disabled" : ""}>−5s</button>`);
      minus.addEventListener("click", () => { this.turnSeconds = Math.max(15, this.turnSeconds - 5); paintTimer(); });
      const val = el(`<button class="seg-opt seg-val" disabled>${this.turnSeconds === 0 ? "No limit" : this.turnSeconds + "s / turn"}</button>`);
      const plus = el(`<button class="seg-opt" ${this.turnSeconds >= 180 ? "disabled" : ""}>+5s</button>`);
      plus.addEventListener("click", () => { this.turnSeconds = this.turnSeconds === 0 ? 15 : Math.min(180, this.turnSeconds + 5); paintTimer(); });
      timerRow.append(off, minus, val, plus);
    };
    paintTimer();

    const launchBtn = screen.querySelector("#launch") as HTMLElement;
    launchBtn.addEventListener("click", () => {
      const name = (screen.querySelector("#name") as HTMLInputElement).value.trim() || "Commander";
      const opts: LaunchOptions = {
        seats: this.buildSeats(name),
        config: { fogMap: this.fogMap, aiDifficulty: this.aiDifficulty, turnSeconds: this.turnSeconds },
      };
      // The button bursts into shards, then the warp takes us into the game.
      shatter(launchBtn, "#39d8c8", () => this.onLaunch(opts));
    });
    screen.querySelector("#back")?.addEventListener("click", () => this.onBack?.());

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
