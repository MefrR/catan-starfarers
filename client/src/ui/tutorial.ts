import type { GameState } from "@starfarers/shared";
import type { GameDriver } from "../game/store.js";
import type { BoardRenderer } from "../render/board.js";

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

/** Find a Fleet-sidebar section by its title ("Mothership", "Shaker", …). */
const sideSec = (title: string): Element | null => {
  for (const sec of document.querySelectorAll(".side-sec")) {
    if (sec.querySelector(".side-title")?.textContent?.includes(title)) return sec;
  }
  return null;
};

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
  /** One-shot side effect on step entry (e.g. fly the camera somewhere). */
  enter?: (s: GameState) => void;
}

/**
 * Z6/AA2: "First Flight" — a fully guided first game. A floating coach bubble
 * + a pulsing spotlight ring walk a brand-new player through EVERYTHING:
 * setup placement, production, the hand, trading, the build dock, the shaker,
 * flying & settling, outposts, pirate bases / ice planets and the race to 15.
 * Steps advance automatically by watching the game state; encounter cards and
 * forced discards interject whenever they strike; skippable at any time.
 */
export class TutorialDriver {
  private game: GameDriver;
  private board: BoardRenderer | null;
  private bubble: HTMLElement;
  private ring: HTMLElement;
  private idx = 0;
  private enteredIdx = -1;
  /** Once a step's ready() has been true it stays "armed" — the phase moving
   *  on must complete the step, not bounce it back to the waiting line. */
  private readyLatched = false;
  private unsub: () => void;
  private timer: number;
  private dead = false;
  private readonly steps: TutStep[];

  constructor(game: GameDriver, board?: BoardRenderer) {
    this.game = game;
    this.board = board ?? null;

    /** Frame a set of board-space points (camera glide), if the board is wired. */
    const frame = (pts: { x: number; y: number }[]): void => {
      if (!this.board || pts.length === 0) return;
      this.board.focusRegion(pts, {
        left: 90,
        top: 90,
        right: window.innerWidth - 90,
        bottom: window.innerHeight - 300,
      });
    };
    const outpostPoints = (s: GameState): { x: number; y: number }[] => {
      const o = s.sectors.find((x) => x.kind === "outpost");
      if (!o) return [];
      return [{ x: 1.5 * o.q + 0.5, y: Math.sqrt(3) * (o.r + o.q / 2 + 0.5) }];
    };
    const threatPoints = (s: GameState): { x: number; y: number }[] => {
      const pts: { x: number; y: number }[] = [];
      for (const sec of s.sectors) {
        for (const p of sec.planets) {
          if (p.special !== "none") pts.push({ x: p.x, y: p.y });
        }
      }
      return pts.slice(0, 2);
    };

    this.steps = [
      {
        manual: true,
        text: `<b>Welcome aboard, commander!</b><br>This guided first flight walks you through the whole game. The goal: be first to <b>15 victory points</b> by settling colonies, befriending alien outposts and braving deep space. Skip anytime.`,
      },
      {
        text: `First, everyone rolls for the starting order. Press <b>🎲 Roll for starting position</b>.`,
        anchor: () => actionBtn("Roll for starting position"),
        done: (s) => s.phaseState.phase !== "setup" || s.phaseState.setup?.step !== "rollStart",
      },
      {
        text: `These are the <b>Catanian home colonies</b>. For 4 rounds, click a <b>glowing site</b> to place a colony — a site touching two planets produces <b>both</b> resources, and the number chip is how often a planet pays (6 &amp; 8 pay most). In round 4 you'll also pick a spaceport, your first ship and a bonus attachment.`,
        done: (s) => s.phaseState.phase !== "setup",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "production",
        text: `Your turn opens with <b>production</b>. Roll the dice — every planet showing that number flashes gold and pays resources to the colonies built next to it. (A <b>7</b> pays nothing and forces big hands to discard!)`,
        anchor: () => actionBtn("Roll dice"),
        done: (s, my) => my && s.phaseState.phase !== "production",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "tradeBuild",
        manual: true,
        text: `These cards are your <b>resources</b>: ore, fuel, carbon, food and trade goods pay for everything you build. The <b>⇄</b> button trades with the bank (3:1, food 2:1) or face-to-face with your rivals — trading is often the fastest way to finish a build.`,
        anchor: () => document.querySelector(".hand"),
      },
      {
        manual: true,
        text: `The <b>build dock</b>: lit tiles are affordable right now; hover any tile to see its cost and what it does. <b>Colony ships</b> settle new worlds (1 VP). <b>Trade ships</b> dock at outposts. <b>Starports</b> upgrade a colony so you can build more ships (2 VP) — they do <i>not</i> double its production. <b>Boosters</b> add speed, <b>cannons</b> add combat, <b>pods</b> add cargo.`,
        anchor: () => document.querySelector(".build-dock"),
      },
      {
        text: `Build something if you like, then press <b>End build → Shake</b> to launch into the flight phase.`,
        anchor: () => actionBtn("End build"),
        done: (s, my) => my && (s.phaseState.phase === "flight" || s.phaseState.phase === "encounter"),
      },
      {
        // Armed in flight OR mid-encounter (End build → Shake auto-shakes, and
        // a black ball can throw the player straight into an encounter).
        ready: (s, my) => my && (s.phaseState.phase === "flight" || s.phaseState.phase === "encounter"),
        manual: true,
        text: `Meet the <b>shaker</b> — your mothership. Shaking it spills two balls: their total is your fleet's <b>speed</b> this turn, and in fights it's your <b>combat strength</b>. Boosters and cannons you've built add to those. And if a <b>black ball</b> falls out… something waits for you in deep space.`,
        anchor: () => sideSec("Shaker") ?? sideSec("Mothership"),
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "flight",
        text: `Now press <b>Shake mothership</b> and see what the galaxy deals you. (Already shaken? Then you're cleared for flight.)`,
        anchor: () => actionBtn("Shake mothership"),
        done: (s) => !!s.phaseState.shake || s.phaseState.phase === "encounter",
      },
      {
        ready: (s, my) => my && s.phaseState.phase === "flight" && !!s.phaseState.shake,
        text: `Now fly: <b>click one of your ships</b>, then a <b>green node</b> to move it. Park a colony ship between two planets and press <b>Establish Colony</b> (+1 VP). You can split your speed across several moves.`,
        done: (s, my) =>
          !my || s.ships.some((sh) => sh.owner === this.game.humanId && sh.movedThisTurn),
      },
      {
        manual: true,
        enter: (s) => frame(outpostPoints(s)),
        text: `See this station? It's an <b>alien outpost</b>. Fly a <b>trade ship</b> to its docking point to earn a <b>friendship card</b> (a permanent power — extra production, better trade rates, free upgrades…) and compete for the civ's <b>friendship marker</b>, worth <b>+2 VP</b> to whoever has the most trade stations there.`,
      },
      {
        manual: true,
        enter: (s) => frame(threatPoints(s)),
        text: `Deep space also bites back. <b>☠ Pirate bases</b> and <b>❄ ice planets</b> block a planet from producing or being settled. Beat a pirate base with enough <b>cannons</b>, or terraform an ice planet with enough <b>freight pods</b> — each one you clear becomes a <b>+1 VP</b> conquest medal, permanently yours.`,
      },
      {
        manual: true,
        enter: () => this.board?.recenter(),
        text: `One more thing: when your shake spills a <b>black ball</b>, you draw an <b>encounter card</b> — merchants, pirates, travelers, ships in distress. Read it and choose: generosity, courage and greed all lead to different fortunes. Encounters can win you fame, resources, even free ships… or cost you dearly.`,
      },
      {
        manual: true,
        text: `That's the whole loop: <b>produce → trade &amp; build → shake &amp; fly</b>. Your score lives here — first to <b>15 VP</b> wins. The ⌕ button finds your fleet, ⓘ shows costs, and hovering anything explains it. The galaxy is yours, commander — good luck! 🚀`,
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
    this.evaluate(this.game.getState());
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
    this.readyLatched = false;
    if (this.idx >= this.steps.length) {
      this.destroy();
      return;
    }
    this.evaluate(this.game.getState());
  }

  private evaluate(s: GameState): void {
    if (this.dead) return;
    // A rendering hiccup must never kill the tour — the interval would die
    // silently and the tutorial would appear to "stop".
    try {
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
      if (step.ready?.(s, my)) this.readyLatched = true;
      const armed = !step.ready || this.readyLatched;
      if (!step.manual && step.done && armed && step.done(s, my)) {
        this.advance();
        return;
      }
      this.paint(s, step, my);
    } catch {
      /* keep ticking */
    }
  }

  /** Render the current step (or an interjection / waiting line) and place the
   *  bubble + spotlight ring against the freshly-resolved anchor. */
  private paint(s: GameState, step: TutStep, my: boolean): void {
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
    if (step.ready && !this.readyLatched && !step.ready(s, my)) {
      textEl.innerHTML = `⏳ Watch your rivals take their turns — yours is coming up…`;
      nextBtn.style.display = "none";
      this.place(null);
      return;
    }

    // One-shot entry effect (camera framing), now that the step is live.
    if (this.enteredIdx !== this.idx) {
      this.enteredIdx = this.idx;
      step.enter?.(s);
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
