import {
  PLAYER_COLORS,
  type AiDifficulty,
  type GameConfig,
  type PlayerColor,
  type SetupMember,
} from "@starfarers/shared";
import type { Seat } from "../game/store.js";

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
};

const AI_NAMES = ["Nova", "Orion", "Vega", "Lyra", "Atlas", "Cygnus"];

export interface LaunchOptions {
  seats: Seat[];
  config: Partial<GameConfig>;
}

/** Single-player setup screen. Calls onLaunch with seats + chosen config. */
export class NewGameMenu {
  private root: HTMLElement;
  private onLaunch: (opts: LaunchOptions) => void;
  private onBack: (() => void) | undefined;
  private color: PlayerColor = "yellow";
  private opponents = 2;
  private fogMap = false;
  private aiDifficulty: AiDifficulty = "normal";

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
        <div class="card">
          <h1 class="title">CATAN: STARFARERS</h1>
          <p class="subtitle">Single player — command your fleet against rival civilizations.</p>
          <label>Your name</label>
          <input type="text" id="name" placeholder="Commander" maxlength="16" value="Commander" />
          <label class="mt">Your color</label>
          <div class="row" id="colors"></div>
          <label class="mt">AI opponents</label>
          <div class="row" id="opponents"></div>
          <label class="mt">Map style</label>
          <div class="row" id="mapstyle"></div>
          <label class="mt">AI difficulty</label>
          <div class="row" id="difficulty"></div>
          <button class="mt" id="launch">Launch game</button>
          ${this.onBack ? `<button class="mt secondary" id="back">← Back</button>` : ""}
        </div>
      </div>
    `);

    const colorsRow = screen.querySelector("#colors")!;
    const paintColors = (): void => {
      colorsRow.replaceChildren();
      for (const c of PLAYER_COLORS) {
        const sel = c === this.color;
        const btn = el(
          `<button class="color-pick ${sel ? "selected" : ""}">
             <span class="dot ${c}"></span><span class="cn">${COLOR_NAME[c]}</span>
           </button>`,
        );
        btn.addEventListener("click", () => {
          this.color = c;
          paintColors();
        });
        colorsRow.appendChild(btn);
      }
    };
    paintColors();

    const oppRow = screen.querySelector("#opponents")!;
    const paintOpps = (): void => {
      oppRow.replaceChildren();
      for (const n of [1, 2, 3]) {
        const sel = n === this.opponents;
        const btn = el(
          `<button class="secondary" style="flex:1;${sel ? "outline:2px solid var(--accent);" : ""}">${n}</button>`,
        );
        btn.addEventListener("click", () => {
          this.opponents = n;
          paintOpps();
        });
        oppRow.appendChild(btn);
      }
    };
    paintOpps();

    const mapRow = screen.querySelector("#mapstyle")!;
    const paintMap = (): void => {
      mapRow.replaceChildren();
      const opts: { fog: boolean; label: string; desc: string }[] = [
        { fog: false, label: "Charted", desc: "Whole galaxy visible" },
        { fog: true, label: "Uncharted", desc: "Fog — explore to reveal" },
      ];
      for (const o of opts) {
        const sel = o.fog === this.fogMap;
        const btn = el(
          `<button class="secondary mapstyle-pick" style="flex:1;${sel ? "outline:2px solid var(--accent);" : ""}">
             <b>${o.label}</b><span class="ms-desc">${o.desc}</span>
           </button>`,
        );
        btn.addEventListener("click", () => {
          this.fogMap = o.fog;
          paintMap();
        });
        mapRow.appendChild(btn);
      }
    };
    paintMap();

    const diffRow = screen.querySelector("#difficulty")!;
    const paintDiff = (): void => {
      diffRow.replaceChildren();
      const opts: { v: AiDifficulty; label: string; desc: string }[] = [
        { v: "easy", label: "Easy", desc: "Passive rivals" },
        { v: "normal", label: "Normal", desc: "Steady expansion" },
        { v: "hard", label: "Hard", desc: "Aggressive racers" },
      ];
      for (const o of opts) {
        const sel = o.v === this.aiDifficulty;
        const btn = el(
          `<button class="secondary mapstyle-pick" style="flex:1;${sel ? "outline:2px solid var(--accent);" : ""}">
             <b>${o.label}</b><span class="ms-desc">${o.desc}</span>
           </button>`,
        );
        btn.addEventListener("click", () => {
          this.aiDifficulty = o.v;
          paintDiff();
        });
        diffRow.appendChild(btn);
      }
    };
    paintDiff();

    screen.querySelector("#launch")!.addEventListener("click", () => {
      const name = (screen.querySelector("#name") as HTMLInputElement).value.trim() || "Commander";
      this.onLaunch({
        seats: this.buildSeats(name),
        config: { fogMap: this.fogMap, aiDifficulty: this.aiDifficulty },
      });
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
