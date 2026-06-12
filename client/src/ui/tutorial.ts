import type { GameState } from "@starfarers/shared";
import type { GameDriver } from "../game/store.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

/** Find an action-bar button by (part of) its label — the HUD re-renders
 *  wholesale, so anchors are re-resolved live on every tick. */
const actionBtn = (txt: string): HTMLElement | null =>
  [...document.querySelectorAll<HTMLElement>(".actions button")].find((b) =>
    (b.textContent ?? "").includes(txt),
  ) ?? null;

interface TutStep {
  /** The coaching text shown in the bubble (kept short and concrete). */
  text: string;
  /** Live anchor — a DOM node to spotlight, or null for a centered bubble. */
  anchor?: () => Element | null;
  /** Auto steps advance when this becomes true. */
  done?: (s: GameState, my: boolean) => boolean;
  /** Manual steps advance on the "Next" button instead. */
  manual?: boolean;
  /** Until this is true the bubble shows a "watch your rivals" waiting line
   *  (used for steps that only make sense on the player's own turn). */
  ready?: (s: GameState, my: boolean) => boolean;
}

/**
 * Z6: "First Flight" — a guided first game. A floating coach bubble + a pulsing
 * spotlight ring walk a brand-new player through their first turns: setup
 * placement, production, building, the shake, flying and settling. Steps
 * advance automatically by watching the game state; the player can skip at any
 * time. Interjections handle the two surprise moments (encounter card, discard
 * on a 7) whenever they strike.
 */
export class TutorialDriver {
  private game: GameDriver;
  private bubble: HTMLElement;
  private ring: HTMLElement;
  private idx = 0;
  private unsub: () => void;
  private timer: number;
  private dead = false;
  private readonly steps: TutStep[];

  constructor(game: GameDriver) {
    this.game = game;
    this.steps = [
      {
        manual: true,
        text: `<b>Welcome aboard, commander!</b><br>This guided first flight walks you through your opening turns. The goal: be first to <b>15 victory points</b> by settling colonies, docking at alien outposts and surviving deep space. Skip anytime.`,
      },
      {
        text: `First, everyone rolls for the starting order. Press <b>🎲 Roll for starting position</b>.`,
        anchor: () => actionBtn("Roll for starting position"),
        done: (s) => s.phaseState.phase !== "setup" || s.phaseState.setup?.step !== "rollStart",
      },
      {
        text: `These are the <b>Catanian home colonies</b>. For 4 rounds, click a <b>glowing site</b> to place a colony — a site touching two planets produces <b>both</b> resources. In round 4 you'll also pick a spaceport, your first ship and a bonus attachment (big center-screen choices).`,
        done: (s) => s.phaseState.phase !== "setup",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "production",
        text: `Your turn opens with <b>production</b>. Roll the dice — every planet showing that number pays resources to the colonies built next to it.`,
        anchor: () => actionBtn("Roll dice"),
        done: (s, my) => my && s.phaseState.phase !== "production",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "tradeBuild",
        manual: true,
        text: `These cards are your <b>resources</b>. Ore, fuel, carbon, food and trade goods pay for everything. The <b>⇄</b> button trades with the bank (3:1, food 2:1) or with rivals.`,
        anchor: () => document.querySelector(".hand"),
      },
      {
        text: `The <b>build dock</b>: lit tiles are affordable right now — hover any tile to see its cost and what it does. Colony ships settle new worlds (1 VP); spaceports double production (2 VP). Build if you like, then press <b>End build → Shake</b>.`,
        anchor: () => document.querySelector(".build-dock"),
        done: (s, my) => my && s.phaseState.phase === "flight",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "flight" && !s.phaseState.shake,
        text: `<b>Flight phase!</b> Shake the mothership — the balls that fall out set your fleet's <b>speed</b> (and combat strength). A <b>black ball</b> means an encounter in deep space…`,
        anchor: () => actionBtn("Shake mothership"),
        done: (s) => !!s.phaseState.shake || s.phaseState.phase === "encounter",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "flight" && !!s.phaseState.shake,
        text: `Now fly: <b>click one of your ships</b>, then a <b>green node</b> to move it. Park a colony ship between two planets and press <b>Establish Colony</b> to settle (+1 VP). Trade ships dock at alien outposts for friendship cards.`,
        done: (s, my) =>
          !my || s.ships.some((sh) => sh.owner === this.game.humanId && sh.movedThisTurn),
      },
      {
        manual: true,
        text: `That's the whole loop: <b>produce → build → fly</b>. Your score lives here — first to <b>15 VP</b> wins. The ⌕ button finds your fleet, ⓘ shows costs, and hovering anything explains it. Good luck out there, commander! 🚀`,
        anchor: () => document.querySelector(".score-rows"),
      },
    ];

    this.bubble = el(`
      <div class="tut-bubble">
        <div class="tut-head">
          <span class="tut-badge">FIRST FLIGHT</span>
          <span class="tut-count"></span>
        </div>
        <div class="tut-text"></div>
        <div class="tut-actions">
          <button class="tut-next">Next ➤</button>
          <button class="tut-skip">Skip tutorial</button>
        </div>
      </div>`);
    this.ring = el(`<div class="tut-ring"></div>`);
    document.body.appendChild(this.ring);
    document.body.appendChild(this.bubble);
    this.bubble.querySelector(".tut-next")!.addEventListener("click", () => this.advance());
    this.bubble.querySelector(".tut-skip")!.addEventListener("click", () => this.destroy());

    this.unsub = game.subscribe((s) => this.evaluate(s));
    // The HUD swaps DOM nodes on every render — re-resolve the anchor and
    // recheck conditions on a steady tick so the spotlight never goes stale.
    this.timer = window.setInterval(() => this.evaluate(this.game.getState()), 500);
    this.paint(this.game.getState());
  }

  destroy(): void {
    if (this.dead) return;
    this.dead = true;
    window.clearInterval(this.timer);
    this.unsub();
    this.bubble.remove();
    this.ring.remove();
  }

  private advance(): void {
    this.idx++;
    if (this.idx >= this.steps.length) {
      this.destroy();
      return;
    }
    this.paint(this.game.getState());
  }

  private evaluate(s: GameState): void {
    if (this.dead) return;
    if (s.phaseState.phase === "gameOver") {
      this.destroy();
      return;
    }
    const step = this.steps[this.idx];
    if (!step) {
      this.destroy();
      return;
    }
    const my = this.game.isHumanTurn();
    if (!step.manual && step.done && (!step.ready || step.ready(s, my)) && step.done(s, my)) {
      this.advance();
      return;
    }
    this.paint(s);
  }

  /** Render the current step (or an interjection / waiting line) and place the
   *  bubble + spotlight ring against the freshly-resolved anchor. */
  private paint(s: GameState): void {
    if (this.dead) return;
    const step = this.steps[this.idx];
    if (!step) return;
    const my = this.game.isHumanTurn();
    const textEl = this.bubble.querySelector(".tut-text") as HTMLElement;
    const nextBtn = this.bubble.querySelector(".tut-next") as HTMLElement;
    const count = this.bubble.querySelector(".tut-count") as HTMLElement;
    count.textContent = `${this.idx + 1}/${this.steps.length}`;

    // Interjections: the two surprises that can strike at any step.
    const enc = s.phaseState.encounter;
    if (s.phaseState.phase === "encounter" && enc?.subjectId === this.game.humanId) {
      textEl.innerHTML = `<b>An encounter!</b> Your black ball drew a card from deep space. Read it and choose — generosity, courage and greed all have different outcomes. Encounters can win you fame, resources… or cost you dearly.`;
      nextBtn.style.display = "none";
      this.place(document.querySelector(".encounter-card"));
      return;
    }
    if ((s.phaseState.pendingDiscards?.[this.game.humanId] ?? 0) > 0) {
      textEl.innerHTML = `A <b>7</b> was rolled and your hand is over the limit — click cards in your hand to discard down, then confirm.`;
      nextBtn.style.display = "none";
      this.place(document.querySelector(".hand"));
      return;
    }

    // Waiting line while the step isn't relevant yet (rivals are playing).
    if (step.ready && !step.ready(s, my)) {
      textEl.innerHTML = `⏳ Watch your rivals take their turns — yours is coming up…`;
      nextBtn.style.display = "none";
      this.place(null);
      return;
    }

    textEl.innerHTML = step.text;
    nextBtn.style.display = step.manual ? "" : "none";
    this.place(step.anchor?.() ?? null);
  }

  /** Pin the spotlight ring over the anchor and the bubble near it (above when
   *  there's room, below otherwise; centered when there's no anchor). */
  private place(anchor: Element | null): void {
    const b = this.bubble;
    if (anchor && anchor.isConnected) {
      const r = anchor.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        this.ring.style.display = "block";
        this.ring.style.left = `${r.left - 6}px`;
        this.ring.style.top = `${r.top - 6}px`;
        this.ring.style.width = `${r.width + 12}px`;
        this.ring.style.height = `${r.height + 12}px`;
        const bw = b.offsetWidth || 330;
        const bh = b.offsetHeight || 130;
        let x = r.left + r.width / 2 - bw / 2;
        x = Math.max(10, Math.min(x, window.innerWidth - bw - 10));
        let y = r.top - bh - 16;
        if (y < 10) y = Math.min(window.innerHeight - bh - 10, r.bottom + 16);
        b.style.left = `${x}px`;
        b.style.top = `${y}px`;
        return;
      }
    }
    this.ring.style.display = "none";
    const bw = b.offsetWidth || 330;
    b.style.left = `${Math.max(10, (window.innerWidth - bw) / 2)}px`;
    b.style.top = `${Math.max(70, window.innerHeight * 0.18)}px`;
  }
}
