import {
  BALL_VALUE,
  BUILD_COSTS,
  MAX_UPGRADES,
  ENCOUNTER_CARDS,
  MOTHERSHIP_BALLS,
  RESOURCES,
  RESOURCE_LABEL,
  TURN_TRADE_BONUS,
  VP,
  catanianColonySites,
  colonyEstablishBlock,
  reserveDrawForVP,
  shipLaunchSites,
  tradeRatioFor,
  diplomatDiscardLimit,
  friendshipCardById,
  type AlienCiv,
  type GameState,
  type PlayerColor,
  type PlayerState,
  type Resource,
  type ResourceBag,
  type ShipKind,
  type TurnPhase,
  type UpgradeKind,
} from "@starfarers/shared";
import type { GameDriver } from "../game/store.js";
import type { BoardRenderer } from "../render/board.js";
import { ChatBox } from "./chat.js";
import { sfx, music } from "../audio.js";
import { ShakerStreaks } from "../render/streaks.js";

const el = (html: string): HTMLElement => {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const RES_COLOR: Record<Resource, string> = {
  ore: "#d8453a",
  fuel: "#e08a2e",
  carbon: "#3d7fd6",
  food: "#3fae6b",
  goods: "#9a6fd0",
};

const COLOR_HEX: Record<PlayerColor, string> = {
  yellow: "#ffd23f",
  red: "#ff5d5d",
  blue: "#4fa8ff",
  black: "#8a8fa6",
  green: "#52d273",
  white: "#e9eef7",
};

const CIV_LABEL: Record<AlienCiv, string> = {
  greenFolk: "Green Folk",
  scientists: "Scientists",
  diplomats: "Diplomats",
  merchants: "Merchants",
  travelers: "Travelers",
};

const CIV_COLOR: Record<AlienCiv, string> = {
  greenFolk: "#57e389",
  scientists: "#6fb3ff",
  diplomats: "#ffd23f",
  merchants: "#c98bff",
  travelers: "#ff8a5d",
};

const PHASE_LABEL: Record<TurnPhase, string> = {
  setup: "Set-up",
  production: "Production",
  tradeBuild: "Trade & Build",
  flight: "Flight",
  encounter: "Encounter",
  gameOver: "Game Over",
};

const DIE_PIPS = ["", "⚀", "⚁", "⚂", "⚃", "⚄", "⚅"];

type Mode =
  | "idle"
  | "pickColony"
  | "selectShip"
  | "moveShip"
  | "spaceJump"
  | "setupColony"
  | "setupUpgrade"
  | "launchShip"
  | "setupShip";

/** What each mothership upgrade is FOR — shown as rich hover info on the Fleet
 *  panel and on the build buttons (every use spelled out, per request). */
const UPGRADE_USES: Record<"booster" | "cannon" | "freightPod", string> = {
  booster:
    "<b>Boosters — speed</b><br>• +1 flight speed each, so your ships travel farther every flight.<br>• Add to your roll in speed-based encounters (races, fleeing pirates).",
  cannon:
    "<b>Cannons — combat</b><br>• +1 combat strength each.<br>• Win pirate-combat encounters.<br>• Defeat a <b>pirate base</b> next to your ship (cannons ≥ its number) and claim it as a <b>+1 VP</b> fame medal.",
  freightPod:
    "<b>Freight pods — cargo &amp; expansion</b><br>• Build a <b>trade station</b> at an outpost (you need at least as many pods as stations already docked there).<br>• <b>Terraform an ice planet</b> next to your ship (pods ≥ its number) into a <b>+1 VP</b> fame medal.",
};

/** What each ship / spaceport is FOR — rich hover info on the build buttons. */
const BUILD_USES: Record<"colonyShip" | "tradeShip" | "spaceport", string> = {
  colonyShip:
    "<b>Colony ship</b><br>Fly it out and establish a <b>colony</b> on an open point touching two planets (<b>+1 VP</b>, and you collect from those planets on production).",
  tradeShip:
    "<b>Trade ship</b><br>Fly it to an outpost and dock to open a <b>trade station</b> (<b>+1 VP</b>, a friendship card, and the <b>+2 VP</b> marker if you hold the most stations there).",
  spaceport:
    "<b>Spaceport</b><br>Upgrades one of your colonies for <b>+1 extra VP</b> and lets you launch new ships from the open points beside it.",
};

export class HUD {
  private root: HTMLElement;
  private game: GameDriver;
  private board: BoardRenderer;

  // Interaction state persisted across the wholesale re-renders.
  private mode: Mode = "idle";
  private selectedShipId: string | null = null;
  private moveTargets = new Map<string, string[]>(); // destination id -> path
  /** Ship kind awaiting a launch-site board click (launchShip / setupShip modes). */
  private launchKind: ShipKind | null = null;
  /** A green launch point clicked on the map: shows the colony/trade ship choice. */
  private launchPickSite: string | null = null;
  /** Player-to-player offer being built (from the proposer's perspective). */
  private pGive: Partial<Record<Resource, number>> = {};
  private pWant: Partial<Record<Resource, number>> = {};
  /** R7: when responding to someone else's offer, the counter the human is building
   *  (expressed from the HUMAN's own perspective: what I give / what I want). */
  private counterOpen = false;
  private cGive: Partial<Record<Resource, number>> = {};
  private cWant: Partial<Record<Resource, number>> = {};
  /** Whether the bottom-bar trade tray is expanded (opened by clicking a card). */
  private tradeOpen = false;
  /** Whether the Costs & VP reference popover (the "i" tool) is open. */
  private showRef = false;
  /** Last `${activePlayer}:${phase}` rendered — drives the action-bar swap-in
   *  animation only when the turn/phase actually changes (not every state tick). */
  private lastBannerKey = "";
  /** Turn-handoff tracking: was it the human's turn on the previous render?
   *  null = first render (suppress the splash for the opening state). */
  private wasMyTurn: boolean | null = null;
  /** Tab-title blinker while the tab is hidden and it's the human's turn. */
  private titleBlink = 0;
  /** V3 event ticker: previous log length + tail line, to detect new entries
   *  even after the log hits its 200-line cap (where length stops growing). */
  private tickerEl: HTMLDivElement | null = null;
  private prevLogLen = -1;
  private prevLogLast: string | null = null;
  /** Y9: per-type piece counts last render, so each NEW piece (any player's)
   *  plays its own sound identity (ship/colony/spaceport/station). */
  private prevPieceCounts: { ships: number; colonies: number; ports: number; stations: number } | null = null;
  /** HUD-tools toggle: show rich hover info (descriptions/tooltips). Persisted. */
  private hoverInfoOn = true;
  /** HUD-tools toggle: idle 60s auto-recenter of the map. Persisted. */
  private autoRecenterOn = true;
  private discardSel: Partial<Record<Resource, number>> = {};
  /** Last roll counter we played a dice animation for. */
  private lastAnimatedRoll = 0;
  /** Last roll counter we played resource-gain animations for. */
  private lastAnimatedGains = 0;
  /** Last reserve-draw seq we animated (specific cards flying to hand). */
  private lastAnimatedReserve = 0;
  /** Last shake counter we animated (cycling balls then settle). */
  private lastAnimatedShake = 0;
  /** Last cleared-special seq we animated (token + medal flying to the player). */
  private lastAnimatedClear = 0;
  /** Last shakeCount we auto-ended the turn on (#6: nothing to do after shake). */
  private lastAutoEndShake = 0;
  /** Last steal seq we animated (Q4: card flies victim → thief). */
  private lastAnimatedSteal = 0;
  /** Last completed-trade seq we animated (R8: cards swap between two players). */
  private lastAnimatedTrade = 0;
  /** Last upgrade-purchase seq we animated (R10: upgrade pip blooms for all). */
  private lastAnimatedUpgrade = 0;
  /** Per-player friendship-marker count seen last render (#8: detect new +2 VP gains). */
  private prevMarkerCount: Record<string, number> = {};
  /** True until the first render, so initial markers don't trigger the +2 VP fly. */
  private markersInitialized = false;
  private diceTimers: number[] = [];
  /** Turn-timer state (host-configured limit, applied PER step). `turnDeadline` is
   *  an epoch ms; `turnTimerStep` identifies the step the deadline belongs to so a
   *  new step (roll → build → shake → move) re-arms with a fresh allotment. */
  private turnDeadline = 0;
  private turnTimerStep = "";
  private turnTimerInterval = 0;
  /** Whether the +10s trade bonus has already been granted in the current step,
   *  so a turn's trading earns it only once (not once per click). Reset whenever
   *  the timed step changes. */
  private tradeBonusUsed = false;
  /** Encounter currently shown in the center overlay (cardId + subject + step). */
  private shownEncounter: { cardId: number; subjectId: string; awaiting: string } | null = null;
  /** How many players had confirmed an all-player card when the overlay last rebuilt. */
  private shownConfirmCount = -1;
  /** Signature of the center discard prompt currently shown, so it only rebuilds
   *  when the owed count or the current selection changes. */
  private shownDiscardSig = "";
  /** Signature of the current duel's rolls, so the overlay refreshes as shakes land. */
  private shownDuelSig = "";
  /** Log length when the current encounter opened, so on resolution we can show
   *  the exact narration lines the card produced (its descriptive outcome). */
  private encLogMark = 0;
  /** Snapshot of each player's fame/medals/hand taken when an encounter opens. */
  private encSnapshot: Record<string, { fame: number; medals: number; hand: ResourceBag }> = {};
  /** Whether the center-screen game-over results overlay is already shown. */
  private gameOverShown = false;
  /** R1/R2: collapse toggles for the side panels on small screens. */
  // AA3: panels start OPEN on large screens (plenty of room) and collapsed on
  // small ones, where they'd otherwise cover most of the board.
  private sidebarCollapsed = window.innerWidth < 1000;
  private scoreCompact = window.innerWidth < 1000;
  /** Center action bar collapsed to just the resource hand. Only applies when
   *  it ISN'T your turn — on your turn the bar always shows the full actions. */
  private barCollapsed = false;
  /** AA4: small screens fold the side tools behind a "⋯" expander. */
  private toolsExpanded = false;
  /** Previous toggle states, to play a slide animation ONLY on an actual
   *  collapse/expand (the HUD re-renders wholesale on every state tick). */
  private lastSidebarCollapsed: boolean | null = null;
  private lastScoreCompact: boolean | null = null;
  /** Last set-up round/step the camera framed, so each placement round zooms
   *  the view onto the starting area exactly once (players can still pan). */
  private lastSetupFocusKey = "";

  constructor(mount: HTMLElement, game: GameDriver, board: BoardRenderer) {
    this.root = mount;
    this.game = game;
    this.board = board;
    this.unsubscribe = game.subscribe((s) => this.render(s));
    // Q6: Space triggers the contextual primary action (roll / end / shake).
    this.keyHandler = (e) => this.onKeyDown(e);
    window.addEventListener("keydown", this.keyHandler);
    // V2: hiding/showing the tab mid-turn starts/stops the title alert without
    // waiting for the next state tick.
    this.visHandler = () => {
      const live = this.game.getState().phaseState.phase !== "gameOver";
      this.syncTitleAlert(this.game.isHumanTurn() && live);
    };
    document.addEventListener("visibilitychange", this.visHandler);
    // Q5: floating build-cost popover (resource icons + what's missing).
    this.costPop = document.createElement("div");
    this.costPop.className = "build-cost-pop";
    document.body.appendChild(this.costPop);
    // Surface multiplayer errors that the server rejects asynchronously (after
    // dispatch already returned) — otherwise a blocked action looks like it just
    // silently did nothing ("end turn is stuck", "I can't trade").
    game.onError = (msg) => {
      // These three mean the server no longer has our room — almost always the
      // free-tier host went to sleep / restarted mid-game and wiped its
      // in-memory rooms. The reconnect succeeds but the rejoin is refused, so
      // the board would otherwise just freeze (e.g. "the roll button does
      // nothing"). Show a clear, recoverable overlay instead of a silent stall.
      if (msg === "Could not rejoin." || msg === "Room not found." || msg === "Not in a room.") {
        this.fatalDisconnect();
      } else {
        this.centerNote(msg);
      }
    };
    // F2/F4/F5: toggle-able chat box (dev-mode + heart codes live here).
    this.chat = new ChatBox(game);
    // On-map colony/trade-ship picker, anchored over the clicked launch point.
    this.launchPicker = document.createElement("div");
    this.launchPicker.className = "map-picker";
    document.body.appendChild(this.launchPicker);

    // Restore the player's HUD-tools preferences (hover info + auto-recenter).
    try {
      this.hoverInfoOn = localStorage.getItem("sf_hoverInfo") !== "0";
      this.autoRecenterOn = localStorage.getItem("sf_autoRecenter") !== "0";
    } catch { /* localStorage unavailable — keep defaults */ }
    this.board.setAutoRecenter(this.autoRecenterOn);

    // Y10: minimap (large screens only — hidden by CSS under 1000px). Click
    // anywhere on it to jump the camera there.
    this.mini = document.createElement("canvas");
    this.mini.className = "minimap";
    this.mini.width = 180;
    this.mini.height = 230;
    document.body.appendChild(this.mini);
    this.mini.addEventListener("click", (e) => {
      const m = this.miniMapping;
      if (!m) return;
      const r = this.mini!.getBoundingClientRect();
      const px = ((e.clientX - r.left) / r.width) * this.mini!.width;
      const py = ((e.clientY - r.top) / r.height) * this.mini!.height;
      this.board.centerOnBoardPoint((px - m.ox) / m.s, (py - m.oy) / m.s);
    });
  }

  /** Y10: the corner minimap canvas + its board→canvas mapping. */
  private mini: HTMLCanvasElement | null = null;
  private miniMapping: { s: number; ox: number; oy: number } | null = null;

  /** Floating colony/trade-ship chooser shown over the clicked green launch
   *  point (instead of in the center action bar). */
  private launchPicker!: HTMLDivElement;

  /** F2: the toggle-able chat box, mounted at body level. */
  private chat: ChatBox | null = null;

  /** Cleanly tear the HUD down (R18: returning to the lobby for a rematch). Drops
   *  all subscriptions, window listeners, pending timers, and body-level overlays
   *  so a freshly-mounted HUD starts from a clean slate. */
  destroy(): void {
    this.unsubscribe?.();
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    this.diceTimers.forEach((t) => window.clearTimeout(t));
    this.diceTimers = [];
    if (this.turnTimerInterval) { window.clearInterval(this.turnTimerInterval); this.turnTimerInterval = 0; }
    this.costPop?.remove();
    if (this.pickerOutside) {
      document.removeEventListener("pointerdown", this.pickerOutside, true);
      this.pickerOutside = null;
    }
    this.launchPicker?.remove();
    this.clearEstablishPopover();
    this.clearBoardConfirm();
    this.dismissMapConfirm();
    this.board.onViewChange = null;
    this.chat?.destroy();
    this.chat = null;
    if (this.visHandler) {
      document.removeEventListener("visibilitychange", this.visHandler);
      this.visHandler = null;
    }
    if (this.titleBlink) {
      window.clearInterval(this.titleBlink);
      this.titleBlink = 0;
      document.title = "Catan: Starfarers";
    }
    this.tickerEl?.remove();
    this.tickerEl = null;
    this.mini?.remove();
    this.mini = null;
    this.root.replaceChildren();
    document
      .querySelectorAll(
        ".gameover-overlay, .encounter-overlay, .discard-overlay, .shake-overlay, .dice-overlay, .result-toast, .fly-token, .marker-fly, .exit-confirm, .turn-splash",
      )
      .forEach((n) => n.remove());
  }

  private unsubscribe: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private visHandler: (() => void) | null = null;

  /** Q5: rich hover/click popover showing a build's cost as resource icons,
   *  marking what's missing (red) vs satisfied (green) and "Ready to build". */
  private costPop!: HTMLDivElement;

  private attachCostTip(
    btnEl: HTMLElement,
    me: PlayerState,
    cost: Partial<Record<Resource, number>>,
    extra?: string,
  ): void {
    const build = (): string => {
      // One mini-card PER resource required (e.g. 3 ore cards + 2 carbon
      // cards). Cards you hold are lit in the resource's color; cards you're
      // still missing are grayed out — readable at a glance, no numbers.
      const groups = RESOURCES.filter((r) => (cost[r] ?? 0) > 0)
        .map((r) => {
          const need = cost[r] ?? 0;
          const have = Math.min(me.hand[r], need);
          let cards = "";
          for (let i = 0; i < need; i++) {
            cards += `<span class="bc-mini ${i < have ? "lit" : "dim"}" style="--res:${RES_COLOR[r]}">${resourceGlyphSvg(r)}</span>`;
          }
          return `<span class="bc-group" title="${RESOURCE_LABEL[r]} ${have}/${need}">${cards}</span>`;
        })
        .join("");
      const ready = RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));
      const head = ready
        ? `<div class="bc-head ready">✓ All resources ready</div>`
        : `<div class="bc-head short">Gray cards are still missing</div>`;
      // `extra` is our own trusted HTML (build "uses" descriptions / blocker text).
      return `${head}<div class="bc-cells">${groups}</div>${extra ? `<div class="bc-extra">${extra}</div>` : ""}`;
    };
    const show = (e: PointerEvent): void => {
      if (!this.hoverInfoOn) return; // hover info toggled off in the HUD tools
      this.costPop.innerHTML = build();
      this.costPop.classList.add("show");
      this.positionCostPop(e.clientX, e.clientY);
    };
    btnEl.addEventListener("pointerover", show);
    btnEl.addEventListener("pointermove", (e) => {
      if (this.costPop.classList.contains("show")) this.positionCostPop(e.clientX, e.clientY);
    });
    btnEl.addEventListener("pointerout", () => this.costPop.classList.remove("show"));
    // Click/tap also toggles it (touch devices: "hover or click").
    btnEl.addEventListener("pointerdown", show);
  }

  private positionCostPop(mx: number, my: number): void {
    const r = this.costPop.getBoundingClientRect();
    let x = mx - r.width / 2;
    let y = my - r.height - 16;
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    if (y < 8) y = my + 18;
    this.costPop.style.left = `${x}px`;
    this.costPop.style.top = `${y}px`;
  }

  /** Attach a rich hover/tap info popover (arbitrary HTML) to an element. Reuses
   *  the floating popover element and is gated on the hover-info toggle, so the
   *  player can switch all of this off from the HUD tools. */
  private attachInfo(elm: HTMLElement, html: string): void {
    const show = (e: PointerEvent): void => {
      if (!this.hoverInfoOn) return;
      this.costPop.innerHTML = `<div class="info-tip">${html}</div>`;
      this.costPop.classList.add("show");
      this.positionCostPop(e.clientX, e.clientY);
    };
    elm.addEventListener("pointerover", show);
    elm.addEventListener("pointermove", (e) => {
      if (this.costPop.classList.contains("show")) this.positionCostPop(e.clientX, e.clientY);
    });
    elm.addEventListener("pointerout", () => this.costPop.classList.remove("show"));
    elm.addEventListener("pointerdown", show);
  }

  /** V2: center-screen "Your turn!" sweep in the player's color (~1.6s). */
  private showTurnSplash(state: GameState): void {
    document.querySelectorAll(".turn-splash").forEach((n) => n.remove());
    const me = state.players.find((p) => p.id === this.game.humanId);
    const color = COLOR_HEX[me?.color ?? "yellow"];
    const splash = el(
      `<div class="turn-splash" style="--pc:${color}">
         <div class="ts-line"></div>
         <div class="ts-text">Your turn${me ? `, ${escapeHtml(me.name)}` : ""}!</div>
         <div class="ts-line"></div>
       </div>`,
    );
    document.body.appendChild(splash);
    window.setTimeout(() => splash.remove(), 1700);
  }

  /** V2: while the tab is hidden and it's the human's turn, blink the tab title
   *  so a backgrounded player notices the table is waiting on them. */
  private syncTitleAlert(myTurn: boolean): void {
    const BASE = "Catan: Starfarers";
    const wants = myTurn && document.visibilityState === "hidden";
    if (wants && !this.titleBlink) {
      let flip = false;
      this.titleBlink = window.setInterval(() => {
        flip = !flip;
        document.title = flip ? "● Your turn!" : BASE;
      }, 1000);
    } else if (!wants && this.titleBlink) {
      window.clearInterval(this.titleBlink);
      this.titleBlink = 0;
      document.title = BASE;
    }
  }

  /** V3: surface new log lines as auto-fading toasts (top center, max 3). The
   *  log is capped at 200 lines (old lines splice off the front), so growth is
   *  detected by length while under the cap and by the previous tail line once
   *  at it. The opening backlog is skipped — only live events tick. */
  private syncTicker(state: GameState): void {
    const log = state.log;
    if (this.prevLogLen === -1 || log.length < this.prevLogLen) {
      // First render, or the log was reset (play again): adopt without showing.
      this.prevLogLen = log.length;
      this.prevLogLast = log[log.length - 1] ?? null;
      return;
    }
    let fresh: string[] = [];
    if (log.length > this.prevLogLen) {
      fresh = log.slice(this.prevLogLen);
    } else if (log.length === 200 && this.prevLogLast != null) {
      const idx = log.lastIndexOf(this.prevLogLast);
      if (idx >= 0 && idx < log.length - 1) fresh = log.slice(idx + 1);
    }
    this.prevLogLen = log.length;
    this.prevLogLast = log[log.length - 1] ?? null;
    if (fresh.length === 0) return;
    if (!this.tickerEl) {
      this.tickerEl = document.createElement("div");
      this.tickerEl.className = "event-ticker";
      document.body.appendChild(this.tickerEl);
    }
    // AA4: at most TWO lines on screen; an older line that gets pushed out
    // fades early instead of lingering (already-fading lines don't count).
    for (const line of fresh.slice(-2)) {
      const entry = el(`<div class="et-entry">${escapeHtml(line)}</div>`);
      this.tickerEl.appendChild(entry);
      const live = [...this.tickerEl.children].filter((c) => !c.classList.contains("out"));
      while (live.length > 2) {
        const old = live.shift() as HTMLElement;
        old.classList.add("out");
        window.setTimeout(() => old.remove(), 350);
      }
      window.setTimeout(() => {
        entry.classList.add("out");
        window.setTimeout(() => entry.remove(), 350);
      }, 3000);
    }
  }

  /**
   * Q6: Space performs the *primary* action for the current phase — "the last
   * button that should be pressed" to advance your turn:
   *   production → roll dice
   *   trade & build → end build + shake mothership (one step)
   *   flight → shake mothership (then, once shaken, end turn)
   * Skipped whenever a specific choice is owed (discard, steal, encounter,
   * friendship pick, pending trade) so Space never bypasses a required decision.
   */
  private onKeyDown(e: KeyboardEvent): void {
    if (e.code !== "Space" && e.key !== " ") return;
    // Don't hijack space while typing in an input/textarea.
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (!this.game.isHumanTurn()) return;
    const state = this.game.getState();
    const ps = state.phaseState;
    const me = state.players.find((p) => p.id === this.game.humanId);
    // Never auto-act while a specific decision is owed.
    if (ps.encounter) return;
    if (ps.pendingTrade) return;
    if (ps.pendingFriendship) return;
    if (ps.awaitingSteal) return;
    if (me && (ps.pendingDiscards?.[me.id] ?? 0) > 0) return;

    let intent: Parameters<GameDriver["dispatch"]>[0] | null = null;
    switch (ps.phase) {
      case "production":
        if (!ps.lastRoll) intent = { t: "rollDice" };
        break;
      case "tradeBuild":
        // Space ends the build phase and shakes the mothership in one go.
        e.preventDefault();
        this.endBuildAndShake();
        return;
      case "flight":
        if (!ps.shake) intent = { t: "shakeMothership" };
        else { this.resetSelection(); intent = { t: "endTurn" }; }
        break;
      default:
        break;
    }
    if (!intent) return;
    e.preventDefault();
    this.act(intent);
  }

  /**
   * Leave Trade & Build and immediately shake the mothership, so the player goes
   * straight from building into the flight roll in one click (no separate "Shake
   * mothership" press). Abandons any half-composed/live trade first so the engine
   * doesn't refuse the phase change.
   */
  private endBuildAndShake(): void {
    const state = this.game.getState();
    const ps = state.phaseState;
    const meId = this.game.humanId;
    if (ps.pendingTrade && ps.pendingTrade.fromId === meId) this.act({ t: "cancelTrade" });
    this.resetSelection();
    this.act({ t: "endTradeBuild" });
    // In single-player the dispatch is synchronous so we're already in flight and
    // can shake now. In multiplayer it's a server round-trip, so the state is
    // still tradeBuild here — arm an auto-shake that fires once flight arrives
    // (handled in render) so it stays a single tap.
    const after = this.game.getState().phaseState;
    if (after.phase === "flight" && !after.shake && !after.encounter) {
      this.act({ t: "shakeMothership" });
    } else {
      this.autoShakePending = true;
    }
  }

  /** Set by endBuildAndShake in multiplayer: shake as soon as flight begins. */
  private autoShakePending = false;

  private act(
    intent: Parameters<GameDriver["dispatch"]>[0],
    opts?: { center?: boolean },
  ): void {
    const err = this.game.dispatch(intent);
    if (err) {
      // Build/settle attempts blocked by a pirate base / ice planet get a big
      // center-screen explanation of exactly what's missing (N12); everything
      // else uses the quiet inline error line.
      if (opts?.center) this.centerNote(err);
      else this.flashError(err);
      return;
    }
    // A successful bank/player trade buys the active player TURN_TRADE_BONUS extra
    // seconds — but only ONCE per build step, so repeated trades (or clicks) can't
    // stack unlimited time. (The server validates async, so NetworkGame reports no
    // sync error; we extend optimistically — a rejected trade just shows an error.)
    if (
      this.turnDeadline > 0 &&
      this.turnTimerStep.startsWith("build") &&
      !this.tradeBonusUsed &&
      (intent.t === "tradeWithSupply" || intent.t === "finalizeTrade") &&
      this.game.isHumanTurn()
    ) {
      this.tradeBonusUsed = true;
      this.turnDeadline += TURN_TRADE_BONUS * 1000;
      this.centerNote(`+${TURN_TRADE_BONUS}s — trade bonus`);
    }
  }

  private flashError(msg: string): void {
    const e = this.root.querySelector(".hud-error");
    if (e) {
      e.textContent = msg;
      window.setTimeout(() => {
        if (e.textContent === msg) e.textContent = "";
      }, 2500);
    }
  }

  /** A prominent self-dismissing notification in the middle of the screen. */
  private centerNote(msg: string): void {
    document.querySelectorAll(".center-note").forEach((n) => n.remove());
    const note = el(`<div class="center-note">${escapeHtml(msg)}</div>`);
    document.body.appendChild(note);
    requestAnimationFrame(() => note.classList.add("show"));
    window.setTimeout(() => note.classList.remove("show"), 3200);
    window.setTimeout(() => note.remove(), 3600);
  }

  /**
   * R6: confirm before bailing out to the main menu. In multiplayer the player can
   * either CONTINUE later (we keep the saved session so reopening the site rejoins
   * the same game) or fully QUIT (drop the seat + forget the session so the menu
   * starts fresh). Single-player only quits.
   */
  private confirmExit(): void {
    document.querySelectorAll(".exit-confirm").forEach((n) => n.remove());
    const mp = !!this.game.isMultiplayer;
    const modal = el(`
      <div class="exit-confirm">
        <div class="exit-box">
          <div class="exit-title">Leave the game?</div>
          <div class="exit-msg">${mp ? "Quit drops your seat and starts fresh. Leave &amp; continue keeps this game so you can rejoin it later." : "You'll return to the main menu and this game will be lost."}</div>
          <div class="exit-actions">
            ${mp ? `<button class="exit-cont secondary">Leave &amp; continue later</button>` : ""}
            <button class="exit-yes">${mp ? "Quit game" : "Exit to menu"}</button>
            <button class="secondary exit-no">Keep playing</button>
          </div>
        </div>
      </div>`);
    // Quit: forget the session (and leave the room) so we don't auto-rejoin.
    modal.querySelector(".exit-yes")!.addEventListener("click", () => {
      if (mp) { try { this.game.dispatch({ t: "leaveRoom" }); } catch { /* ignore */ } }
      try { sessionStorage.removeItem("sf_session"); } catch { /* ignore */ }
      location.reload();
    });
    // Leave & continue (multiplayer): keep the session so reopening rejoins.
    modal.querySelector(".exit-cont")?.addEventListener("click", () => location.reload());
    const close = (): void => modal.remove();
    modal.querySelector(".exit-no")!.addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("show"));
  }

  /**
   * The game server lost our room (free-tier sleep/restart wipes in-memory
   * rooms). Reconnecting can't recover it, so rather than leave the table
   * silently frozen — the symptom users see as "the roll button stopped
   * working and the game got stuck" — show a single clear overlay back to the
   * menu. Guarded so repeated rejoin failures only ever show one overlay.
   */
  private fatalDisconnect(): void {
    if (document.querySelector(".exit-confirm.fatal")) return;
    const modal = el(`
      <div class="exit-confirm fatal show">
        <div class="exit-box">
          <div class="exit-title">Lost the game server</div>
          <div class="exit-msg">The online server dropped this room (the free host sleeps after a while of quiet). This game can't be resumed — head back to the menu to start or join another.</div>
          <div class="exit-actions">
            <button class="exit-yes">Back to menu</button>
          </div>
        </div>
      </div>`);
    modal.querySelector(".exit-yes")!.addEventListener("click", () => {
      try { sessionStorage.removeItem("sf_session"); } catch { /* ignore */ }
      location.reload();
    });
    document.body.appendChild(modal);
  }

  private resetSelection(): void {
    this.mode = "idle";
    this.selectedShipId = null;
    this.moveTargets.clear();
    this.launchKind = null;
    this.launchPickSite = null;
    this.pGive = {};
    this.pWant = {};
    this.counterOpen = false;
    this.cGive = {};
    this.cWant = {};
    this.tradeOpen = false;
    this.hideLaunchPicker();
    this.board.clearHighlights();
    this.board.onIntersectionClick = null;
    this.board.onShipClick = null;
  }

  /** Hide the on-map colony/trade-ship picker and stop tracking the view. */
  private hideLaunchPicker(): void {
    this.launchPicker.classList.remove("show");
    this.board.onViewChange = null;
    if (this.pickerOutside) {
      document.removeEventListener("pointerdown", this.pickerOutside, true);
      this.pickerOutside = null;
    }
    this.dismissMapConfirm();
  }

  /** Transient on-map Yes/No confirm anchored over a tapped point (used to
   *  confirm a ship move before committing). */
  private moveConfirmEl: HTMLElement | null = null;
  private dismissMapConfirm(): void {
    this.moveConfirmEl?.remove();
    this.moveConfirmEl = null;
  }
  private mapConfirm(intersectionId: string, onYes: () => void): void {
    this.dismissMapConfirm();
    const pop = el(
      `<div class="map-picker map-confirm show"><div class="mp-row">
         <button class="mp-yes" title="Move here">✓</button>
         <button class="mp-no" title="Cancel">✕</button>
       </div></div>`,
    );
    const place = (): void => {
      const p = this.board.pagePosOf(intersectionId);
      if (!p) return;
      pop.style.left = `${p.x}px`;
      pop.style.top = `${p.y}px`;
    };
    pop.querySelector(".mp-yes")!.addEventListener("click", () => { this.dismissMapConfirm(); onYes(); });
    pop.querySelector(".mp-no")!.addEventListener("click", () => this.dismissMapConfirm());
    document.body.appendChild(pop);
    this.moveConfirmEl = pop;
    place();
    this.board.onViewChange = place;
  }

  /** Active outside-click handler that cancels the open launch picker. */
  private pickerOutside: ((e: PointerEvent) => void) | null = null;

  /** Pop the colony/trade-ship chooser right over the clicked launch point. The
   *  two ship icons appear on the map (not the center bar); it re-anchors itself
   *  whenever the board is panned or zoomed, and closes on pick / cancel. */
  private showLaunchPicker(me: PlayerState, site: string): void {
    const afford = (cost: Partial<ResourceBag>): boolean =>
      RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));
    const noTransport = me.supply.transportShips <= 0;
    const freeTrade = (this.game.getState().phaseState.freeTradeShips?.[me.id] ?? 0) > 0;
    const pick = this.launchPicker;
    pick.replaceChildren();

    const mkBtn = (kind: ShipKind, label: string, cost: Partial<ResourceBag>): HTMLElement => {
      // A free trade-ship credit (from an encounter) makes the trade ship free.
      const free = kind === "tradeShip" && freeTrade;
      const lbl = free ? `${label} (free)` : label;
      const b = el(
        `<button class="mp-ship" title="${lbl}">${shipIco(kind)}<span class="mp-lbl">${lbl}</span></button>`,
      );
      if ((!afford(cost) && !free) || noTransport) (b as HTMLButtonElement).disabled = true;
      else
        b.addEventListener("click", () => {
          this.act({ t: "build", what: kind, targetId: site });
          this.resetSelection();
        });
      return b;
    };
    const row = el(`<div class="mp-row"></div>`);
    row.appendChild(mkBtn("colonyShip", "Colony Ship", BUILD_COSTS.colonyShip));
    row.appendChild(mkBtn("tradeShip", "Trade Ship", BUILD_COSTS.tradeShip));
    pick.appendChild(row);

    const reposition = (): void => {
      const p = this.board.pagePosOf(site);
      if (!p) return;
      pick.style.left = `${p.x}px`;
      pick.style.top = `${p.y}px`;
    };
    reposition();
    this.board.onViewChange = reposition;
    pick.classList.add("show");

    // Click anywhere outside the picker cancels it (no ✕ button needed). A click
    // on another launch dot re-fires the board handler, which re-opens here, so
    // cancel-then-reopen lands the picker on the new point. Registered on the
    // next tick so the click that *opened* it doesn't immediately close it.
    if (this.pickerOutside)
      document.removeEventListener("pointerdown", this.pickerOutside, true);
    const handler = (e: PointerEvent): void => {
      if (this.launchPicker.contains(e.target as Node)) return;
      this.launchPickSite = null;
      this.hideLaunchPicker();
    };
    this.pickerOutside = handler;
    setTimeout(() => {
      if (this.pickerOutside === handler)
        document.addEventListener("pointerdown", handler, true);
    }, 0);
  }

  private render(state: GameState): void {
    const ps = state.phaseState;
    const active = state.players[ps.activePlayerIndex]!;
    // While picking a ship to fly / jump, suppress map tooltips — info popups
    // distract from choosing where to travel. The hover-info toggle (HUD tools)
    // also suppresses them globally when the player turns hover info off.
    this.board.tooltipsSuppressed =
      !this.hoverInfoOn ||
      this.mode === "moveShip" || this.mode === "selectShip" || this.mode === "spaceJump";

    // Multiplayer "End build → Shake": the endTradeBuild round-tripped to the
    // server; now that flight has arrived, fire the shake (one tap overall).
    if (this.autoShakePending) {
      if (this.game.isHumanTurn() && ps.phase === "flight" && !ps.shake && !ps.encounter) {
        this.autoShakePending = false;
        this.act({ t: "shakeMothership" });
      } else if (ps.phase !== "tradeBuild" && ps.phase !== "flight") {
        this.autoShakePending = false; // turn moved on — drop it
      }
    }

    // Trigger the center-screen dice animation once per new roll.
    const rc = ps.rollCount ?? 0;
    if (rc > this.lastAnimatedRoll && ps.lastRoll) {
      this.lastAnimatedRoll = rc;
      sfx.play("dice");
      this.playDiceRoll(ps.lastRoll[0], ps.lastRoll[1]);
      // AA1: once the dice have landed, pulse every planet number that pays
      // on this roll so players can see at a glance where production came from.
      const rolled = ps.lastRoll[0] + ps.lastRoll[1];
      this.diceTimers.push(window.setTimeout(() => this.board.pulseRolledNumber(rolled), 850));
    }
    const me0 = state.players.find((p) => p.id === this.game.humanId)!;
    if (rc > this.lastAnimatedGains) {
      this.lastAnimatedGains = rc;
      this.diceTimers.push(
        window.setTimeout(() => this.playResourceGains(state, me0), 950),
      );
      // Bank ran out of a resource this roll — tell everyone (once per roll).
      const short = ps.productionShortfall ?? [];
      if (short.length) {
        const list = short.map((r) => RESOURCE_LABEL[r]).join(", ");
        this.diceTimers.push(window.setTimeout(() => this.centerNote(`Bank empty: no ${list} produced — not enough in the bank.`), 1100));
      }
    }
    // Reserve-pile draws (the bonus 1–2 cards) animate the SPECIFIC resources
    // gained so the player can see exactly what they received. Gated by seq so
    // it fires once whether the draw was immediate or deferred (after a 7).
    const rd = ps.reserveDraw;
    if (rd && rd.seq > this.lastAnimatedReserve) {
      this.lastAnimatedReserve = rd.seq;
      this.diceTimers.push(
        window.setTimeout(() => this.playReserveDraw(state, me0, rd), 1250),
      );
    }
    // Mothership shake: cycle the 5 balls randomly, then settle on the drawn 2.
    const sc = ps.shakeCount ?? 0;
    if (sc > this.lastAnimatedShake) {
      this.lastAnimatedShake = sc;
      sfx.play("shake");
      this.diceTimers.push(window.setTimeout(() => this.playShakeAnimation(), 30));
      // Big center-screen shake, visible to everyone (mirrors the dice roll).
      this.playShakeCenter(state);
    }
    // A pirate base / ice planet just broke: fly the token + VP medal to the
    // conquering player's mothership (mine) or scoreboard row (opponent).
    const lc = ps.lastClearedSpecial;
    if (lc && lc.seq > this.lastAnimatedClear) {
      this.lastAnimatedClear = lc.seq;
      sfx.play("medal");
      this.diceTimers.push(window.setTimeout(() => this.playClearedSpecial(me0, lc), 200));
    }
    // Q4: a 7-steal just happened — fly a card from the victim's row to the thief's.
    const stl = ps.lastSteal;
    if (stl && stl.seq > this.lastAnimatedSteal) {
      this.lastAnimatedSteal = stl.seq;
      sfx.play("steal");
      this.diceTimers.push(window.setTimeout(() => this.playSteal(stl.fromId, stl.toId), 200));
    }
    // R8: a player-to-player trade just completed — fly a card each way between the
    // two players' rows (and the local player's hand, if they're involved).
    const tr = ps.lastTrade;
    if (tr && tr.seq > this.lastAnimatedTrade) {
      this.lastAnimatedTrade = tr.seq;
      sfx.play("trade");
      this.diceTimers.push(window.setTimeout(() => this.playTrade(tr.fromId, tr.toId), 150));
    }
    // R10: any player bought a mothership upgrade — bloom the upgrade on their
    // scoreboard row (visible to all) and on the local mothership art if it's theirs.
    const up = ps.lastUpgrade;
    if (up && up.seq > this.lastAnimatedUpgrade) {
      this.lastAnimatedUpgrade = up.seq;
      // Each upgrade has its own sonic identity — you can HEAR what was built.
      sfx.play(up.kind === "booster" ? "buildBooster" : up.kind === "cannon" ? "buildCannon" : "buildPod");
      this.diceTimers.push(window.setTimeout(() => this.playUpgrade(up.playerId, up.kind), 120));
    }
    // V1/Y9: a new piece appeared on the map (anyone's) — play that piece
    // TYPE's own sound: launch swoosh for ships, settling chord for colonies,
    // crowned chime for spaceports, docking coins for trade stations.
    const counts = {
      ships: state.ships.length,
      colonies: state.buildings.filter((b) => b.kind === "colony").length,
      ports: state.buildings.filter((b) => b.kind === "spaceport").length,
      stations: state.tradeStations.length,
    };
    if (this.prevPieceCounts) {
      const prev = this.prevPieceCounts;
      if (counts.ships > prev.ships) sfx.play("buildShip");
      if (counts.colonies > prev.colonies) sfx.play("buildColony");
      if (counts.ports > prev.ports) sfx.play("buildPort");
      if (counts.stations > prev.stations) sfx.play("buildStation");
    }
    this.prevPieceCounts = counts;

    // V2: turn handoff — when the turn passes TO the human, sweep a center
    // "Your turn!" splash + chime, and blink the tab title if backgrounded.
    // Suppressed on the very first render (joining mid-state isn't a handoff).
    const myTurnNow = this.game.isHumanTurn() && ps.phase !== "gameOver";
    if (this.wasMyTurn !== null && myTurnNow && !this.wasMyTurn) {
      this.showTurnSplash(state);
      sfx.play("turn");
    }
    this.wasMyTurn = myTurnNow;
    this.syncTitleAlert(myTurnNow);

    // V3: event ticker — surface NEW log lines as auto-fading toasts so other
    // players' actions are readable without opening the log panel.
    this.syncTicker(state);
    // #8: when a player newly gains an outpost friendship marker (+2 VP), fly a
    // celebratory "+2 VP" token to their scoreboard row. Skip the very first
    // render so pre-existing markers don't all fire at once.
    for (const p of state.players) {
      const now = p.friendshipMarkers.length;
      const before = this.prevMarkerCount[p.id] ?? 0;
      if (this.markersInitialized && now > before) {
        const civ = p.friendshipMarkers[p.friendshipMarkers.length - 1] as AlienCiv;
        this.diceTimers.push(window.setTimeout(() => this.playMarkerGain(p.id, civ), 300));
      }
      this.prevMarkerCount[p.id] = now;
    }
    this.markersInitialized = true;

    const me = state.players.find((p) => p.id === this.game.humanId)!;
    const myTurn = this.game.isHumanTurn();
    const owesDiscard = ps.pendingDiscards?.[me.id] ?? 0;

    // Wire board callbacks for the current interaction mode (cleared first).
    this.board.onIntersectionClick = null;
    this.board.onShipClick = null;
    this.wireBoard(state, me, myTurn);

    const screen = el(`<div class="hud"></div>`);

    const target = state.config.targetVictoryPoints;
    // Slide animation only when the player actually compressed/expanded it.
    const scoreToggled = this.lastScoreCompact !== null && this.lastScoreCompact !== this.scoreCompact;
    this.lastScoreCompact = this.scoreCompact;
    const scoreboard = el(
      `<div class="hud-panel scoreboard ${this.scoreCompact ? "compact" : ""} ${scoreToggled ? "panel-toggling-r" : ""}"></div>`,
    );
    // Tapping the tracker's own border/padding (the container itself) toggles it.
    scoreboard.addEventListener("click", (e) => {
      if (e.target === scoreboard) { this.scoreCompact = !this.scoreCompact; this.rerender(); }
    });
    // R2: tap the title to compress the victory tracker — names hide, leaving just
    // each player's colour, VP and the medal/card/marker chips.
    // Compact uses a short title so the collapsed widget stays narrow and the
    // map gets more room; expanded shows the full label.
    const titleText = this.scoreCompact ? `Race to ${target}` : `Victory · first to ${target}`;
    const vpTitle = el(`<div class="vp-title toggle" title="Tap to ${this.scoreCompact ? "expand" : "compress"}">${titleText}<span class="tg-caret">${this.scoreCompact ? "▸" : "▾"}</span></div>`);
    vpTitle.addEventListener("click", () => { this.scoreCompact = !this.scoreCompact; this.rerender(); });
    scoreboard.appendChild(vpTitle);
    // Rows live in their own flex container so compact mode can lay the players
    // out as side-by-side columns (narrow) instead of stacked full-width rows.
    const scoreRows = el(`<div class="score-rows"></div>`);
    for (const p of state.players) {
      const isActive = p.id === active.id;
      const bonus = reserveDrawForVP(p.victoryPoints);
      const bonusBadge =
        bonus > 0
          ? `<span class="vp-bonus" title="+${bonus} reserve card(s) when you roll at this rank">${cardGlyphSvg()}+${bonus}</span>`
          : `<span class="vp-bonus empty"></span>`;
      const cards = RESOURCES.reduce((s, r) => s + p.hand[r], 0);
      const owes = ps.pendingDiscards?.[p.id] ?? 0;
      const limit = diplomatDiscardLimit(p);
      // Red & blooming whenever the hand is over the discard limit — a standing
      // warning that a rolled 7 will force a discard — not only after a 7 (P6e).
      const overLimit = owes > 0 || cards > limit;
      const overBy = owes > 0 ? owes : cards - limit;
      const cardTitle =
        owes > 0
          ? `Over the limit! Must discard ${owes} of ${cards} cards`
          : cards > limit
            ? `Over the ${limit}-card limit (${cards}) — a rolled 7 will force you to discard ${cards - Math.floor(limit / 2)}`
            : `${cards} resource card${cards === 1 ? "" : "s"} in hand`;
      const fame = p.fameMedalPieces;
      const markers = p.friendshipMarkers.length;
      // R15: pirate-base / ice-planet conquest medals (+1 VP each). Only shown once
      // a player has cleared a special, so it doesn't clutter the row otherwise.
      const conquest = p.victoryMedals;
      const conquestBadge =
        conquest > 0
          ? `<span class="sm conquest" title="${conquest} pirate/ice conquest medal${conquest === 1 ? "" : "s"} (+1 VP each)">${medalGlyphSvg()}${conquest}</span>`
          : "";
      const meta = `
        <div class="score-meta">
          <span class="sm ${overLimit ? "over-limit" : ""}" title="${cardTitle}">${cardGlyphSvg()}${cards}${overLimit ? `<span class="discard-need">!${overBy}</span>` : ""}</span>
          <span class="sm" title="${fame} fame medal piece${fame === 1 ? "" : "s"} (${fame * 0.5} VP)">${fameGlyphSvg()}${fame}</span>
          <span class="sm ${markers > 0 ? "on" : "off"}" title="${markers} friendship marker${markers === 1 ? "" : "s"} (+2 VP each)">${markerGlyphSvg()}${markers}</span>
          ${conquestBadge}
        </div>`;
      // Mothership upgrades, visible to everyone (expanded view only). Lets all
      // players gauge each fleet's speed/combat/cargo strength.
      const upg = p.upgrades;
      const upgRow = `
        <div class="score-upg">
          <span class="su" title="${upg.booster} booster${upg.booster === 1 ? "" : "s"} (+flight speed)">${upgradeIco("booster")}${upg.booster}</span>
          <span class="su" title="${upg.cannon} cannon${upg.cannon === 1 ? "" : "s"} (+combat strength)">${upgradeIco("cannon")}${upg.cannon}</span>
          <span class="su" title="${upg.freightPod} freight pod${upg.freightPod === 1 ? "" : "s"} (cargo / trade stations)">${upgradeIco("freightPod")}${upg.freightPod}</span>
        </div>`;
      // Y7: a thin progress bar racing toward the target under every row.
      const pct = Math.min(100, (p.victoryPoints / target) * 100);
      const row = el(`
        <div class="score-row ${isActive ? "active" : ""}" data-pid="${p.id}">
          <div class="score-main">
            <span class="avatar" title="${escapeHtml(p.name)}">${avatarSvg(p.color)}</span>
            <span class="pname">${escapeHtml(p.name)}</span>
            ${bonusBadge}
            <span class="vp" style="color:${COLOR_HEX[p.color]}">${p.victoryPoints}<span class="vp-target">/${target}</span></span>
          </div>
          <div class="vp-bar"><i style="width:${pct.toFixed(1)}%;--pc:${COLOR_HEX[p.color]}"></i></div>
          ${meta}
          ${upgRow}
        </div>`);
      scoreRows.appendChild(row);
    }
    scoreboard.appendChild(scoreRows);

    // M2: the activity log is now a section inside the Fleet sidebar (see
    // buildSidebar) rather than a separate floating panel.
    const bar = el(`<div class="hud-panel actionbar"></div>`);
    // Collapsible center bar: when it's NOT your turn you can fold the bar down
    // to just your resource hand (tap the edge handle, or the bar's own
    // padding) so the board is clearer while you watch an opponent. On your own
    // turn it always springs back open to show every action.
    if (myTurn) this.barCollapsed = false;
    const canCollapse = !myTurn && ps.phase !== "setup" && ps.phase !== "gameOver";
    const barCollapsed = this.barCollapsed && canCollapse;
    if (barCollapsed) bar.classList.add("collapsed");
    if (canCollapse) {
      const toggle = el(
        `<button class="bar-toggle" title="${barCollapsed ? "Show actions" : "Collapse to resources"}">${barCollapsed ? "▴" : "▾"}</button>`,
      );
      toggle.addEventListener("click", () => { this.barCollapsed = !this.barCollapsed; this.rerender(); });
      bar.appendChild(toggle);
      // Tapping the bar's own padding (not a child control) toggles too.
      bar.addEventListener("click", (e) => {
        if (e.target === bar) { this.barCollapsed = !this.barCollapsed; this.rerender(); }
      });
    }

    const discardMode = owesDiscard > 0;
    const pickedTotal = RESOURCES.reduce((s, r) => s + (this.discardSel[r] ?? 0), 0);
    // P6c: in trade&build (my turn, no live offer, not discarding), tapping a
    // resource card starts a trade — it adds that card to the "Give" side and
    // expands the bottom-bar trade tray (Want + Bank / Offer controls).
    const tradeMode =
      !discardMode && myTurn && ps.phase === "tradeBuild" && !ps.pendingTrade;
    const hand = el(`<div class="hand ${discardMode ? "discarding" : ""} ${tradeMode ? "tradable" : ""}"></div>`);
    for (const r of RESOURCES) {
      const sel = this.discardSel[r] ?? 0;
      const give = this.pGive[r] ?? 0;
      const n = me.hand[r];
      // Show the hand like a fanned deck of physical cards: each resource is a
      // stack whose visible left edges count out how many you hold. The front
      // card carries the glyph/label; the badge still shows the exact number
      // (so a single card is readable too). Zero cards = fully greyed-out card.
      const MAX_EDGES = 4;
      const edges = Math.min(Math.max(n - 1, 0), MAX_EDGES);
      const gutter = edges * 4;
      const edgeHtml = Array.from(
        { length: edges },
        (_v, i) => `<span class="res-edge" style="left:-${(edges - i) * 4}px"></span>`,
      ).join("");
      const card = el(`
        <div class="res-card ${n === 0 ? "empty" : ""} ${discardMode ? "selectable" : ""} ${tradeMode ? "selectable trade" : ""} ${sel > 0 ? "discard-sel" : ""} ${tradeMode && give > 0 ? "trade-sel" : ""}" data-res="${r}" title="${RESOURCE_LABEL[r]} ×${n}" style="--res:${RES_COLOR[r]};margin-left:${gutter}px">
          ${edgeHtml}
          <span class="res-glyph">${resourceGlyphSvg(r)}</span>
          <span class="res-name">${RESOURCE_LABEL[r]}</span>
          <span class="res-count">${n}</span>
          ${sel > 0 ? `<span class="discard-badge">−${sel}</span>` : ""}
          ${tradeMode && give > 0 ? `<span class="give-badge">give ${give}</span>` : ""}
        </div>`);
      if (discardMode) {
        card.addEventListener("click", () => {
          const cur = this.discardSel[r] ?? 0;
          const total = RESOURCES.reduce((s, x) => s + (this.discardSel[x] ?? 0), 0);
          if (cur < me.hand[r] && total < owesDiscard) this.discardSel[r] = cur + 1;
          else if (cur > 0) this.discardSel[r] = cur - 1; // click again to deselect/cycle
          this.rerender();
        });
      } else if (tradeMode) {
        card.addEventListener("click", () => {
          const cur = this.pGive[r] ?? 0;
          if (cur < me.hand[r]) this.pGive[r] = cur + 1;
          else this.pGive[r] = 0; // click past your max to clear this resource
          // Can't give and want the same resource — drop it from the Want side.
          if ((this.pGive[r] ?? 0) > 0) this.pWant[r] = 0;
          this.tradeOpen = true;
          this.rerender();
        });
      }
      hand.appendChild(card);
    }
    // Discoverability: a small labeled Trade button next to the cards — not
    // everyone knows that tapping a resource card starts a trade. Active only
    // when trading is actually possible (your build phase); dim otherwise.
    if (!discardMode) {
      const tradeBtn = el(
        `<button class="hand-trade-btn ${tradeMode ? "" : "off"}" title="${
          tradeMode
            ? "Open the trade tray — or tap a resource card to offer it"
            : "Trading opens during your trade & build phase"
        }"><span class="ht-ico">⇄</span><span class="ht-lbl">Trade</span></button>`,
      );
      if (tradeMode) {
        tradeBtn.addEventListener("click", () => {
          this.tradeOpen = true;
          this.rerender();
        });
      }
      hand.appendChild(tradeBtn);
    }
    bar.appendChild(hand);

    // P6c: trade tray lives in the bottom bar. Shown when a trade is being built
    // (tradeOpen / a Give selected) or whenever there is a live player offer.
    const giveSelected = RESOURCES.some((r) => (this.pGive[r] ?? 0) > 0);
    if (ps.pendingTrade) {
      const tray = el(`<div class="trade-tray"></div>`);
      this.fillPlayerTradeStatus(tray, state, me);
      bar.appendChild(tray);
    } else if (tradeMode && (this.tradeOpen || giveSelected)) {
      const tray = el(`<div class="trade-tray"></div>`);
      const head = el(`<div class="tray-head"><span class="tray-title">Trade</span></div>`);
      const close = el(`<button class="tray-close" title="Cancel trade">✕</button>`);
      close.addEventListener("click", () => { this.resetSelection(); this.rerender(); });
      head.appendChild(close);
      tray.appendChild(head);
      this.fillTradePanel(tray, me);
      bar.appendChild(tray);
    }

    if (discardMode) {
      const dc = el(`<div class="discard-controls"></div>`);
      dc.appendChild(el(`<span class="discard-count">Discard ${pickedTotal}/${owesDiscard}</span>`));
      const confirm = el(`<button class="discard-btn" ${pickedTotal === owesDiscard ? "" : "disabled"}>Discard</button>`);
      if (pickedTotal === owesDiscard) {
        confirm.addEventListener("click", () => {
          this.act({ t: "discard", resources: { ...this.discardSel } });
          this.discardSel = {};
        });
      }
      dc.appendChild(confirm);
      bar.appendChild(dc);
    }

    if (ps.lastRoll) {
      const [a, b] = ps.lastRoll;
      bar.appendChild(
        el(`<div class="dice">${DIE_PIPS[a]}${DIE_PIPS[b]}<span class="sum">${a + b}</span></div>`),
      );
    }

    // Phase flow strip: the three core turn steps with the current one lit, so
    // every player always sees where the turn is. Off-flow phases (setup,
    // encounter, game over) fall back to a plain label.
    const FLOW: { phase: string; label: string }[] = [
      { phase: "production", label: "Produce" },
      { phase: "tradeBuild", label: "Build" },
      { phase: "flight", label: "Fly" },
    ];
    const flowIdx = FLOW.findIndex((f) => f.phase === ps.phase);
    const phaseStrip =
      flowIdx >= 0
        ? `<span class="phase-flow">${FLOW.map(
            (f, i) =>
              `<span class="pf-step ${i === flowIdx ? "on" : i < flowIdx ? "done" : ""}">${f.label}</span>`,
          ).join(`<span class="pf-sep">›</span>`)}</span>`
        : `<span class="phase-name">${PHASE_LABEL[ps.phase]}</span>`;
    const banner = el(`
      <div class="turn-banner">
        <span class="phase" style="color:${COLOR_HEX[active.color]}">${escapeHtml(active.name)}</span>
        ${phaseStrip}
      </div>`);
    // Animate the action bar's content swap ONLY when the turn/phase actually
    // changes — the HUD re-renders wholesale on every state tick, so an
    // unconditional entrance animation would flicker constantly.
    const bannerKey = `${active.id}:${ps.phase}`;
    const phaseChanged = bannerKey !== this.lastBannerKey;
    this.lastBannerKey = bannerKey;
    // Turn timer chip (host-configured). Text is refreshed by an interval so it
    // ticks without a full HUD re-render.
    const timedStep = this.myTimedStep(state);
    if (timedStep) {
      const remain =
        timedStep.key === this.turnTimerStep
          ? Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000))
          : timedStep.seconds;
      banner.appendChild(el(`<span class="turn-timer ${remain <= 5 ? "low" : ""}">${fmtClock(remain)}</span>`));
    }
    bar.appendChild(banner);

    const actions = el(`<div class="actions ${phaseChanged ? "swap-in" : ""}"></div>`);
    if (owesDiscard > 0) {
      actions.appendChild(el(`<div class="waiting">Tap your cards above to discard ${owesDiscard}.</div>`));
    } else if (myTurn && ps.awaitingSteal) {
      this.fillSteal(actions, state, me);
    } else if (ps.pendingFriendship?.playerId === me.id) {
      this.fillFriendshipChoice(actions, ps.pendingFriendship.civ, ps.pendingFriendship.options);
    } else if (ps.phase === "gameOver") {
      const winner = state.players.find((p) => p.id === ps.winner);
      actions.appendChild(el(`<div class="winner">🏆 ${escapeHtml(winner?.name ?? "?")} wins!</div>`));
    } else if (ps.phase === "encounter") {
      // The encounter prompt is shown in a center overlay (visible to all).
      actions.appendChild(el(`<div class="waiting">Encounter in progress…</div>`));
    } else if (!myTurn) {
      actions.appendChild(el(`<div class="waiting">Waiting for ${escapeHtml(active.name)}…</div>`));
    } else {
      this.fillHumanActions(actions, state, me);
    }
    bar.appendChild(actions);
    // The build dock: always visible (every phase, every turn) so costs/uses
    // are one hover away; tiles only activate on your build turn. Hidden during
    // setup, where the build economy doesn't exist yet.
    if (ps.phase !== "setup" && ps.phase !== "gameOver") {
      bar.appendChild(this.buildDock(state, me));
    }
    bar.appendChild(el(`<div class="hud-error"></div>`));

    // AD6: the phase's PRIMARY action (Roll / Shake / End build / End turn) is
    // lifted OUT of the cluttered button row into one bold button floating just
    // above the center box — distinct, unmissable, and grayed when it's not
    // your turn so players always know "the one button to press". It's appended
    // to the (untransformed) screen root, NOT the action bar, so its
    // position:fixed anchors to the viewport (the bar has a CSS transform that
    // would otherwise trap it). positionPrimaryButton() then sits it just above
    // the bar's measured top.
    // Hidden while the bar is collapsed (you're spectating — the greyed
    // "their turn" button is just clutter then).
    const primaryBtn = barCollapsed ? null : this.buildPrimaryButton(state);
    if (primaryBtn) screen.appendChild(primaryBtn);

    // R6: top-left Exit button → confirm before leaving to the main menu.
    const exitBtn = el(`<button class="exit-menu" title="Exit to main menu">✕</button>`);
    exitBtn.addEventListener("click", () => this.confirmExit());
    screen.appendChild(exitBtn);

    // Floating tools: ⓘ costs/VP reference, 👁 hover-info toggle, ⌖ auto-recenter.
    screen.appendChild(this.buildToolsCluster());

    // Y3: once-per-game round-4 setup choices (starting ship / bonus
    // attachment) pop BIG in the center of the screen on the chooser's turn.
    const setupPop = this.buildSetupPop(state, me, myTurn);
    if (setupPop) screen.appendChild(setupPop);

    screen.appendChild(this.buildSidebar(state, me));
    screen.appendChild(scoreboard);
    screen.appendChild(bar);

    // The HUD re-renders wholesale, which would reset the scroll position of any
    // scrollable panel (e.g. expanding "Costs & victory points" snapped the Fleet
    // sidebar back to the top). Snapshot scroll offsets and restore them after.
    const scrollSel = [".sidebar-left", ".scoreboard", ".action-bar"];
    const prevScroll = new Map<string, number>();
    for (const sel of scrollSel) {
      const e = this.root.querySelector(sel);
      if (e) prevScroll.set(sel, e.scrollTop);
    }
    this.root.replaceChildren(screen);
    for (const sel of scrollSel) {
      const top = prevScroll.get(sel);
      const e = top ? this.root.querySelector(sel) : null;
      if (e && top) e.scrollTop = top;
    }

    this.syncEncounterOverlay(state, me);
    this.syncDiscardOverlay(state, me);
    this.syncEstablishPopover(state, me); // AD5: establish bubble above a tapped ship
    this.syncTurnTimer(state);
    this.syncGameOverOverlay(state);
    this.drawMinimap(state);
    // AD6: sit the floating primary button just above the action bar's top,
    // measured after layout settles (and clamped to stay on screen).
    requestAnimationFrame(() => this.positionPrimaryButton());

    // Set-up framing: glide the camera onto the starting-colonies area exactly
    // ONCE, when placement first begins (not every round) — new players
    // otherwise lose the area under the bottom bar, but repeated re-zooming each
    // round fought their own panning. After the first frame we never auto-zoom.
    const su = ps.setup;
    if (ps.phase === "setup" && su && su.step === "place" && this.lastSetupFocusKey !== "done") {
      this.lastSetupFocusKey = "done";
      // Measure the freshly-rendered HUD (bar/sidebar) on the next frame.
      requestAnimationFrame(() => this.focusSetupArea(state));
    }
  }

  /** Zoom/pan the map so the whole starting area (legal colony sites + every
   *  piece placed so far) fills the visible window between the HUD panels. */
  private focusSetupArea(state: GameState): void {
    const pts: { x: number; y: number }[] = [];
    for (const id of catanianColonySites(state)) {
      const it = state.intersections[id];
      if (it) pts.push(it);
    }
    // During set-up every existing piece is in the starting area too — include
    // them so the framed region stays stable as legal sites get used up.
    for (const b of state.buildings) {
      const it = state.intersections[b.intersectionId];
      if (it) pts.push(it);
    }
    for (const s of state.ships) {
      const it = state.intersections[s.intersectionId];
      if (it) pts.push(it);
    }
    if (pts.length === 0) return;
    this.board.focusRegion(pts, this.visibleView());
  }

  /** The on-screen rect NOT covered by HUD panels (sidebar / bar / tools). */
  private visibleView(): { left: number; top: number; right: number; bottom: number } {
    const sidebar = this.root.querySelector(".sidebar-left")?.getBoundingClientRect();
    const bar = this.root.querySelector(".actionbar")?.getBoundingClientRect();
    return {
      left: (sidebar ? sidebar.right : 0) + 14,
      top: 84, // below the exit button / event ticker
      right: window.innerWidth - 64, // clear of the floating tools column
      bottom: (bar ? bar.top : window.innerHeight * 0.62) - 14,
    };
  }

  /** Y8: cycle the camera through the player's fleet: 0 = frame everything I
   *  own, then each of my ships in turn. Resets after 4s of no taps. */
  private fleetCycle = 0;
  private fleetCycleAt = 0;
  private findMyFleet(): void {
    const state = this.game.getState();
    const myId = this.game.humanId;
    const ships = state.ships.filter((s) => s.owner === myId);
    const now = performance.now();
    if (now - this.fleetCycleAt > 4000) this.fleetCycle = 0; // stale — start over
    this.fleetCycleAt = now;
    const view = this.visibleView();
    if (this.fleetCycle === 0 || ships.length === 0) {
      // Everything I own: ships + buildings + my docked trade stations' outposts.
      const pts: { x: number; y: number }[] = [];
      for (const s of ships) {
        const it = state.intersections[s.intersectionId];
        if (it) pts.push(it);
      }
      for (const b of state.buildings.filter((x) => x.owner === myId)) {
        const it = state.intersections[b.intersectionId];
        if (it) pts.push(it);
      }
      if (pts.length === 0) return;
      this.board.focusRegion(pts, view);
      this.fleetCycle = 1;
      this.centerNote("Your fleet");
      return;
    }
    const idx = (this.fleetCycle - 1) % ships.length;
    const ship = ships[idx]!;
    const it = state.intersections[ship.intersectionId];
    if (it) {
      this.board.focusRegion([it], view);
      this.centerNote(`${ship.kind === "colonyShip" ? "Colony ship" : "Trade ship"} ${idx + 1} of ${ships.length}`);
    }
    this.fleetCycle++;
  }

  /** The timed step currently on the clock — shown to EVERY player. `mine` marks
   *  whether the local player is the one who must act (only they auto-resolve on
   *  expiry); others just watch the same countdown. Null when the timer is off. */
  private myTimedStep(state: GameState): { key: string; seconds: number; kind: string; mine: boolean } | null {
    const ps = state.phaseState;
    const chosen = state.config.turnSeconds ?? 0;
    if (chosen <= 0) return null;
    if (ps.phase === "gameOver" || ps.phase === "setup") return null;
    const me = state.players.find((p) => p.id === this.game.humanId);
    if (!me) return null;
    // 1. My own discard after a 7 takes priority on my screen.
    const owed = ps.pendingDiscards?.[me.id] ?? 0;
    if (owed > 0) return { key: `disc|${me.id}|${owed}`, seconds: chosen, kind: "discard", mine: true };
    // 2. Encounter (flat 20s) — the subject (or each unconfirmed player on an
    //    all-player card) acts; everyone else watches the same clock.
    if (ps.phase === "encounter" && ps.encounter) {
      const enc = ps.encounter;
      if (enc.allPlayers) {
        const mine = !(enc.confirmedBy ?? []).includes(me.id);
        return { key: `enc|${enc.cardId}|all`, seconds: 20, kind: "encounter", mine };
      }
      if (enc.awaiting === "duel" && enc.duel) {
        // Either dueller's shake is "mine" if it's my seat and I haven't shaken.
        const mine =
          (enc.subjectId === me.id && enc.duel.subjectRoll == null) ||
          (enc.duel.opponentId === me.id && enc.duel.oppRoll == null);
        return { key: `enc|${enc.cardId}|duel|${enc.duel.subjectRoll ?? "x"}|${enc.duel.oppRoll ?? "x"}`, seconds: 20, kind: "encounter", mine };
      }
      return { key: `enc|${enc.cardId}|${enc.awaiting}`, seconds: 20, kind: "encounter", mine: enc.subjectId === me.id };
    }
    // 3. The ACTIVE player's current step — shown to everyone; only they auto-act.
    const active = state.players[ps.activePlayerIndex];
    if (!active) return null;
    const mine = active.id === me.id;
    const i = ps.activePlayerIndex;
    if (ps.awaitingSteal) return { key: `steal|${i}`, seconds: chosen, kind: "steal", mine };
    if (ps.pendingFriendship) return null; // a friendship choice isn't auto-timed
    if (ps.phase === "production") return { key: `roll|${i}`, seconds: Math.min(3, chosen || 3), kind: "roll", mine };
    if (ps.phase === "tradeBuild") return { key: `build|${i}`, seconds: chosen, kind: "build", mine };
    if (ps.phase === "flight") return { key: `${ps.shake ? "move" : "shake"}|${i}`, seconds: chosen, kind: ps.shake ? "move" : "shake", mine };
    return null;
  }

  /**
   * Drive the host-configured countdown for whatever action is currently mine.
   * The deadline re-arms whenever the step changes; an interval ticks the clock
   * and, on expiry, auto-resolves THIS step: the dice roll, build/shake/move, a
   * random discard after a 7, an auto-steal from the richest opponent, or a
   * random encounter choice. A successful trade extends the build step (act()).
   */
  private syncTurnTimer(state: GameState): void {
    const step = this.myTimedStep(state);
    if (!step) {
      this.turnTimerStep = "";
      if (this.turnTimerInterval) { window.clearInterval(this.turnTimerInterval); this.turnTimerInterval = 0; }
      return;
    }
    if (step.key !== this.turnTimerStep) {
      this.turnTimerStep = step.key;
      this.turnDeadline = Date.now() + step.seconds * 1000;
      this.tradeBonusUsed = false; // each new step earns its trade bonus afresh
    }
    if (!this.turnTimerInterval) {
      this.turnTimerInterval = window.setInterval(() => this.tickTurnTimer(), 250);
    }
  }

  private tickTurnTimer(): void {
    const state = this.game.getState();
    const step = this.myTimedStep(state);
    if (!step) return;
    const remain = Math.max(0, Math.ceil((this.turnDeadline - Date.now()) / 1000));
    for (const chip of [this.root.querySelector(".turn-timer"), document.querySelector(".discard-overlay .dc-timer"), document.querySelector(".encounter-overlay .enc-timer")]) {
      if (chip) { chip.textContent = fmtClock(remain); (chip as HTMLElement).classList.toggle("low", remain <= 5); }
    }
    if (remain > 0) return;
    if (!step.mine) return; // only the responsible player auto-resolves; others just watch
    const ps = state.phaseState;
    const me = state.players.find((p) => p.id === this.game.humanId);
    if (!me) return;
    this.resetSelection();
    switch (step.kind) {
      case "discard": this.autoDiscardRandom(me, ps.pendingDiscards?.[me.id] ?? 0); break;
      case "steal": this.autoStealRichest(state, me); break;
      case "encounter": this.autoEncounterRandom(state, me); break;
      case "roll": if (!ps.lastRoll) this.act({ t: "rollDice" }); break;
      case "build": this.act({ t: "endTradeBuild" }); break;
      case "shake": this.act({ t: "shakeMothership" }); break;
      case "move": this.act({ t: "endTurn" }); break;
    }
  }

  /** Timed-out discard: jettison `owed` cards picked at random from the hand. */
  private autoDiscardRandom(me: PlayerState, owed: number): void {
    if (owed <= 0) return;
    const pool: Resource[] = [];
    for (const r of RESOURCES) for (let i = 0; i < me.hand[r]; i++) pool.push(r);
    const res: Partial<Record<Resource, number>> = {};
    for (let i = 0; i < owed && pool.length; i++) {
      const j = Math.floor(Math.random() * pool.length);
      const r = pool.splice(j, 1)[0]!;
      res[r] = (res[r] ?? 0) + 1;
    }
    this.discardSel = {};
    this.act({ t: "discard", resources: res });
  }

  /** Timed-out steal: take from the opponent holding the most cards. */
  private autoStealRichest(state: GameState, me: PlayerState): void {
    const victims = state.players
      .filter((p) => p.id !== me.id)
      .map((p) => ({ id: p.id, n: RESOURCES.reduce((s, r) => s + p.hand[r], 0) }))
      .sort((a, b) => b.n - a.n);
    const target = victims[0];
    if (target) this.act({ t: "stealTarget", targetId: target.id });
  }

  /** Timed-out encounter: make a random legal choice for the awaited prompt. */
  private autoEncounterRandom(state: GameState, me: PlayerState): void {
    const enc = state.phaseState.encounter;
    if (!enc) return;
    // Duel timed out — auto-shake my mothership so the fight resolves.
    if (enc.awaiting === "duel") { this.act({ t: "encounterShake" }); return; }
    if (enc.allPlayers) {
      // Wear & Tear: if over the upgrade limit, scrap a random owned upgrade.
      const card = ENCOUNTER_CARDS[enc.cardId];
      const threshold = card?.wearTearThreshold;
      const total = me.upgrades.booster + me.upgrades.cannon + me.upgrades.freightPod;
      if (threshold !== undefined && total > threshold) {
        const owned: number[] = [];
        if (me.upgrades.booster > 0) owned.push(0);
        if (me.upgrades.cannon > 0) owned.push(1);
        if (me.upgrades.freightPod > 0) owned.push(2);
        const pick = owned[Math.floor(Math.random() * owned.length)] ?? 0;
        this.act({ t: "encounterChoice", choice: pick });
      } else {
        this.act({ t: "encounterChoice", choice: 0 });
      }
      return;
    }
    if (enc.awaiting === "giveResources") {
      let owed = enc.lossCount ?? 0;
      const pool: Resource[] = [];
      for (const r of RESOURCES) for (let i = 0; i < me.hand[r]; i++) pool.push(r);
      const res: Partial<Record<Resource, number>> = {};
      for (let i = 0; i < owed && pool.length; i++) {
        const r = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]!;
        res[r] = (res[r] ?? 0) + 1;
      }
      this.act({ t: "encounterChoice", choice: 0, resources: res });
    } else if (enc.awaiting === "selectShip") {
      const mine = state.ships.filter((s) => s.owner === me.id);
      this.act({ t: "encounterChoice", choice: Math.floor(Math.random() * Math.max(1, mine.length)) });
    } else if (enc.awaiting === "confirm") {
      this.act({ t: "encounterChoice", choice: 0 });
    } else if (enc.awaiting === "number") {
      this.act({ t: "encounterChoice", choice: Math.floor(Math.random() * 4) });
    } else {
      this.act({ t: "encounterChoice", choice: Math.random() < 0.5 });
    }
  }

  /**
   * After a 7, EVERY over-limit player must discard before anyone can trade or end
   * their turn (the engine blocks the whole table on `anyDiscardsPending`). In
   * single-player the AI auto-discards, but online a non-active player can easily
   * miss the bottom-bar prompt (especially with the action bar collapsed on
   * mobile) — which silently freezes the game for everyone. So we surface the
   * discard as an unmissable center-screen modal for whoever owes one. */
  private syncDiscardOverlay(state: GameState, me: PlayerState): void {
    const owed = state.phaseState.pendingDiscards?.[me.id] ?? 0;
    if (owed <= 0) {
      if (this.shownDiscardSig) {
        document.querySelectorAll(".discard-overlay").forEach((n) => n.remove());
        this.shownDiscardSig = "";
      }
      return;
    }
    const sig = `${owed}|${RESOURCES.map((r) => this.discardSel[r] ?? 0).join(",")}`;
    if (sig === this.shownDiscardSig) return;
    this.shownDiscardSig = sig;
    document.querySelectorAll(".discard-overlay").forEach((n) => n.remove());

    const picked = RESOURCES.reduce((s, r) => s + (this.discardSel[r] ?? 0), 0);
    const overlay = el(`<div class="discard-overlay"><div class="discard-card"></div></div>`);
    const card = overlay.querySelector(".discard-card") as HTMLElement;
    card.appendChild(el(`<div class="enc-tag">Spacedock 7</div>`));
    card.appendChild(el(`<div class="enc-title">Discard ${owed} card${owed === 1 ? "" : "s"}</div>`));
    card.appendChild(
      el(`<div class="enc-text">Your hold is over the limit — jettison cargo before play can continue.</div>`),
    );
    // Timer chip (only when the host enabled a turn timer): on expiry the engine
    // auto-discards random cards. The interval refreshes this text.
    if ((state.config.turnSeconds ?? 0) > 0) {
      card.appendChild(el(`<div class="dc-timer turn-timer"></div>`));
    }
    const picker = el(`<div class="enc-give"></div>`);
    for (const r of RESOURCES) {
      const have = me.hand[r];
      const n = this.discardSel[r] ?? 0;
      const cell = el(
        `<div class="ptrade-cell res-cube ${n > 0 ? "on" : ""}" title="${RESOURCE_LABEL[r]}" style="--res:${RES_COLOR[r]}">
           <span class="pc-glyph res-glyph">${resourceGlyphSvg(r)}</span>
           <span class="pc-name">${RESOURCE_LABEL[r]}</span>
           ${n > 0 ? `<span class="pc-badge">${n}</span>` : ""}
           <div class="pc-stepper">
             <button class="step minus" ${n <= 0 ? "disabled" : ""}>−</button>
             <span class="pc-n">${n}/${have}</span>
             <button class="step plus" ${n >= have || picked >= owed ? "disabled" : ""}>+</button>
           </div>
         </div>`,
      );
      const [minus, plus] = cell.querySelectorAll("button");
      minus!.addEventListener("click", () => { this.discardSel[r] = Math.max(0, n - 1); this.rerender(); });
      plus!.addEventListener("click", () => { this.discardSel[r] = n + 1; this.rerender(); });
      picker.appendChild(cell);
    }
    card.appendChild(picker);
    card.appendChild(el(`<div class="enc-give-tally">${picked} / ${owed} selected</div>`));
    const btn = el(`<button class="discard-confirm" ${picked === owed ? "" : "disabled"}>Discard</button>`);
    if (picked === owed) {
      btn.addEventListener("click", () => {
        this.act({ t: "discard", resources: { ...this.discardSel } });
        this.discardSel = {};
      });
    }
    card.appendChild(btn);
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("show"));
  }

  /** Center-screen winner banner + final standings, shown the instant a player wins. */
  private syncGameOverOverlay(state: GameState): void {
    const ps = state.phaseState;
    if (ps.phase !== "gameOver") {
      this.gameOverShown = false;
      document.querySelectorAll(".gameover-overlay").forEach((n) => n.remove());
      return;
    }
    if (this.gameOverShown) return;
    this.gameOverShown = true;
    sfx.play("win");

    const winner = state.players.find((p) => p.id === ps.winner);
    const ranked = [...state.players].sort((a, b) => b.victoryPoints - a.victoryPoints);
    const rows = ranked
      .map((p, i) => {
        const colonies = state.buildings.filter((b) => b.owner === p.id && b.kind === "colony").length;
        const ports = state.buildings.filter((b) => b.owner === p.id && b.kind === "spaceport").length;
        const stations = state.tradeStations.filter((t) => t.owner === p.id).length;
        const markers = p.friendshipMarkers.length;
        const medals = p.victoryMedals; // pirate/ice conquest medals (+1 VP each)
        const fame = p.fameMedalPieces; // ½ VP each (every 2 pieces = 1 VP)
        const isWin = p.id === ps.winner;
        const pc = COLOR_HEX[p.color];

        // Every VP source the player holds, with its icon and EXACT point value,
        // so the breakdown always sums precisely to the total shown.
        const vpSrc: { ico: string; n: number; label: string; vp: number; sub: string; c: string }[] = [
          { ico: colonyIco(), n: colonies, label: "Colonies", vp: colonies, sub: "1 VP each", c: pc },
          { ico: spaceportIco(), n: ports, label: "Spaceports", vp: ports * 2, sub: "2 VP each", c: pc },
          { ico: shipIco("tradeShip"), n: stations, label: "Trade stations", vp: stations, sub: "1 VP each", c: pc },
          { ico: markerGlyphSvg(), n: markers, label: "Friendship markers", vp: markers * 2, sub: "2 VP each", c: "#7ad0ff" },
          { ico: medalGlyphSvg(), n: medals, label: "Conquest medals", vp: medals, sub: "pirate / ice · 1 VP each", c: "#57e389" },
          { ico: fameGlyphSvg(), n: fame, label: "Fame medal pieces", vp: Math.floor(fame / 2), sub: "½ VP each", c: "#ffd23f" },
        ].filter((s) => s.n > 0);
        const srcRows = vpSrc
          .map(
            (s) => `
            <div class="go-src">
              <span class="go-src-ico" style="color:${s.c}">${s.ico}</span>
              <span class="go-src-n">×${s.n}</span>
              <span class="go-src-lbl">${s.label}<span class="go-src-sub">${s.sub}</span></span>
              <span class="go-src-vp">+${s.vp}</span>
            </div>`,
          )
          .join("");

        // Non-VP "things they got" — mothership upgrades — as a muted footnote.
        const ups: string[] = [];
        const up = (k: "booster" | "cannon" | "freightPod", lbl: string): void => {
          if (p.upgrades[k] > 0) ups.push(`<span class="go-up" title="${p.upgrades[k]} ${lbl}">${upgradeIco(k)}<b>${p.upgrades[k]}</b></span>`);
        };
        up("booster", "boosters"); up("cannon", "cannons"); up("freightPod", "freight pods");
        const upsRow = ups.length
          ? `<div class="go-extras"><span class="go-extras-lbl">Mothership upgrades</span><span class="go-up-list">${ups.join("")}</span></div>`
          : "";

        return `
          <div class="go-row ${isWin ? "win" : ""}">
            <div class="go-row-head">
              <span class="go-rank">${i + 1}</span>
              <span class="avatar go-avatar">${avatarSvg(p.color)}</span>
              <span class="go-name" style="color:${pc}">${escapeHtml(p.name)}</span>
              <span class="go-vp" style="color:${pc}">${p.victoryPoints}<span class="go-vp-lbl">VP</span></span>
            </div>
            <div class="go-break">${srcRows}</div>
            ${upsRow}
          </div>`;
      })
      .join("");
    // R18: in LAN games the host can send everyone back to the same lobby for a
    // rematch; other players just wait. Single-player keeps a simple reload.
    const isMulti = !!this.game.isMultiplayer;
    const amHost = state.players[0]?.id === this.game.humanId;
    let footer: string;
    if (!isMulti) {
      footer = `<button class="go-newgame">New game</button>`;
    } else if (amHost) {
      footer = `<button class="go-playagain">Play again</button>
                <button class="go-leave secondary">Leave to menu</button>`;
    } else {
      footer = `<div class="go-wait">Waiting for the host to start a new game…</div>
                <button class="go-leave secondary">Leave to menu</button>`;
    }
    const overlay = el(`
      <div class="gameover-overlay">
        <div class="gameover-card">
          <div class="go-trophy">🏆</div>
          <div class="go-title" style="color:${winner ? COLOR_HEX[winner.color] : "#fff"}">${escapeHtml(winner?.name ?? "?")} wins!</div>
          <div class="go-sub">Reached ${winner?.victoryPoints ?? state.config.targetVictoryPoints} victory points</div>
          ${this.buildGameStory(state)}
          <div class="go-standings">${rows}</div>
          <div class="go-actions">${footer}</div>
        </div>
      </div>`);
    overlay.querySelector(".go-newgame")?.addEventListener("click", () => location.reload());
    overlay.querySelector(".go-leave")?.addEventListener("click", () => location.reload());
    overlay.querySelector(".go-playagain")?.addEventListener("click", () => {
      this.game.dispatch({ t: "playAgain" });
      // The server resets the room → broadcasts a fresh lobby; the lobby UI takes
      // over for everyone. Drop the overlay so it doesn't linger over the lobby.
      overlay.remove();
    });
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("show"));
  }

  /** Z2: the "story of the game" — a VP-over-time chart plus superlative chips
   *  (farthest flier, master trader, …) derived from the engine's stats. */
  private buildGameStory(state: GameState): string {
    const st = state.stats;
    if (!st) return "";
    const series = state.players.map((p) => ({ p, vps: st.vpHistory[p.id] ?? [] }));
    const maxLen = Math.max(0, ...series.map((s) => s.vps.length));
    if (maxLen < 3) return ""; // too short a game to chart
    const target = state.config.targetVictoryPoints;
    const maxVp = Math.max(target, ...series.flatMap((s) => s.vps), 1);
    const W = 560;
    const H = 170;
    const L = 30; // left gutter for the VP axis labels
    const x = (i: number): number => L + (i / (maxLen - 1)) * (W - L - 14);
    const y = (v: number): number => H - 22 - (v / maxVp) * (H - 40);
    // Horizontal guides at every 5 VP + the target line.
    let grid = "";
    for (let v = 5; v <= maxVp; v += 5) {
      const isTarget = v === target;
      grid += `<line x1="${L}" y1="${y(v)}" x2="${W - 14}" y2="${y(v)}" stroke="${isTarget ? "rgba(255,210,63,0.45)" : "rgba(140,180,255,0.14)"}" stroke-width="1" ${isTarget ? `stroke-dasharray="5 4"` : ""}/>
               <text x="${L - 6}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" fill="${isTarget ? "rgba(255,225,130,0.9)" : "rgba(170,195,235,0.55)"}">${v}</text>`;
    }
    const lines = series
      .map(({ p, vps }) => {
        if (vps.length === 0) return "";
        const c = COLOR_HEX[p.color];
        const pts = vps.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
        const last = vps[vps.length - 1]!;
        return `<polyline points="${pts}" fill="none" stroke="${c}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.92"/>
                <circle cx="${x(vps.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="4" fill="${c}"/>`;
      })
      .join("");
    const chart = `
      <svg class="go-chart" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" aria-label="Victory points over the game">
        ${grid}${lines}
        <text x="${(L + W - 14) / 2}" y="${H - 6}" text-anchor="middle" font-size="10" fill="rgba(170,195,235,0.55)">turns →</text>
      </svg>`;

    // Superlatives: best player per metric (only when someone actually scored it).
    const best = (rec: Record<string, number>): { p: (typeof state.players)[number]; n: number } | null => {
      let top: { p: (typeof state.players)[number]; n: number } | null = null;
      for (const p of state.players) {
        const n = rec[p.id] ?? 0;
        if (n > 0 && (!top || n > top.n)) top = { p, n };
      }
      return top;
    };
    const chips: string[] = [];
    const chip = (got: { p: (typeof state.players)[number]; n: number } | null, emoji: string, label: (n: number) => string): void => {
      if (!got) return;
      chips.push(
        `<span class="go-chip"><span class="go-chip-emo">${emoji}</span><b style="color:${COLOR_HEX[got.p.color]}">${escapeHtml(got.p.name)}</b> ${label(got.n)}</span>`,
      );
    };
    const pl = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;
    chip(best(st.resourcesGained), "🏭", (n) => `top producer · ${pl(n, "resource")}`);
    chip(best(st.distanceFlown), "🚀", (n) => `farthest flier · ${pl(n, "sector")}`);
    chip(best(st.tradesCompleted), "🤝", (n) => `master trader · ${pl(n, "trade")}`);
    chip(best(st.encountersFaced), "🛸", (n) => `most encounters · ${n}`);
    chip(best(st.piratesDefeated), "⚔️", (n) => `pirate hunter · ${pl(n, "base")}`);
    chip(best(st.icePlanetsTerraformed), "❄️", (n) => `terraformer · ${pl(n, "world")}`);
    const chipsHtml = chips.length ? `<div class="go-chips">${chips.join("")}</div>` : "";
    return `<div class="go-story"><div class="go-story-title">The story of the game</div>${chart}${chipsHtml}</div>`;
  }

  /** Left sidebar: mothership illustration + upgrade counts, shaker balls, trade. */
  private buildSidebar(state: GameState, me: PlayerState): HTMLElement {
    const ps = state.phaseState;
    // Play the slide animation only when the player actually toggled the panel.
    const toggled = this.lastSidebarCollapsed !== null && this.lastSidebarCollapsed !== this.sidebarCollapsed;
    this.lastSidebarCollapsed = this.sidebarCollapsed;
    const side = el(
      `<div class="hud-panel sidebar-left ${this.sidebarCollapsed ? "collapsed" : ""} ${toggled ? "panel-toggling" : ""}"></div>`,
    );
    // Tapping the panel's own border/padding (its "edge" — i.e. the container
    // itself, not a child control) toggles it collapsed/expanded.
    side.addEventListener("click", (e) => {
      if (e.target === side) { this.sidebarCollapsed = !this.sidebarCollapsed; this.rerender(); }
    });

    // R1: tap the header to collapse the whole left sidebar to a slim button —
    // useful on narrow / mobile screens where it would otherwise cover the board.
    const head = el(`<div class="side-head toggle" title="Tap to ${this.sidebarCollapsed ? "expand" : "collapse"} the panel"><span class="sh-label">Fleet</span><span class="tg-caret">${this.sidebarCollapsed ? "▸" : "▾"}</span></div>`);
    head.addEventListener("click", () => { this.sidebarCollapsed = !this.sidebarCollapsed; this.rerender(); });
    side.appendChild(head);
    if (this.sidebarCollapsed) return side;

    // --- Mothership section ---
    const ms = el(`<div class="side-sec"></div>`);
    ms.appendChild(el(`<div class="side-title">Mothership</div>`));
    ms.appendChild(el(`<div class="ms-art">${mothershipSvg(COLOR_HEX[me.color], me.upgrades)}</div>`));
    const stats = el(`<div class="ms-stats"></div>`);
    const stat = (ico: string, label: string, val: number | string, color: string): HTMLElement =>
      el(`<div class="ms-stat">
            <span class="ms-ico" style="--c:${color}">${ico}</span>
            <span class="ms-lbl">${label}</span>
            <span class="ms-val">${val}</span>
          </div>`);
    // Boosters / Cannons / Freight pods carry a full "what can I do with these?"
    // hover info (every use spelled out), gated on the hover-info toggle.
    const upRow = (kind: "booster" | "cannon" | "freightPod", label: string, color: string): HTMLElement => {
      const row = stat(upgradeIco(kind), label, me.upgrades[kind], color);
      row.classList.add("ms-stat-info");
      this.attachInfo(row, UPGRADE_USES[kind]);
      return row;
    };
    stats.appendChild(upRow("booster", "Boosters", "#ef8a2b"));
    stats.appendChild(upRow("cannon", "Cannons", "#6fb3ff"));
    stats.appendChild(upRow("freightPod", "Freight pods", "#ff6b6b"));
    stats.appendChild(stat(shipIco(), "Transport ships", me.supply.transportShips, "#c98bff"));
    stats.appendChild(stat(colonyIco(), "Colonies", me.supply.colonies, "#ffd23f"));
    {
      // Each fame medal piece is worth ½ VP; two pieces = 1 full victory point.
      const pieces = me.fameMedalPieces;
      const fameVp = pieces * 0.5;
      const fameRow = stat(
        fameGlyphSvg(),
        "Fame (½ ea)",
        `${pieces} = ${fameVp} VP`,
        "#ffd23f",
      );
      fameRow.setAttribute(
        "title",
        `Each fame medal piece is worth half a victory point. You hold ${pieces} piece${pieces === 1 ? "" : "s"} (${fameVp} VP); every 2 pieces add 1 point.`,
      );
      stats.appendChild(fameRow);
    }
    if (me.victoryMedals > 0) stats.appendChild(stat(medalGlyphSvg(), "VP medals", me.victoryMedals, "#57e389"));
    ms.appendChild(stats);
    side.appendChild(ms);

    // --- Shaker section ---
    const sh = el(`<div class="side-sec"></div>`);
    sh.appendChild(el(`<div class="side-title">Shaker</div>`));
    const ballsEl = el(`<div class="balls"></div>`);
    // Mark which of the 5 balls are the 2 drawn (consume matches once each).
    const drawn = ps.shake ? [...ps.shake.balls] : [];
    for (const b of MOTHERSHIP_BALLS) {
      let isDrawn = false;
      const idx = drawn.indexOf(b);
      if (idx >= 0) { isDrawn = true; drawn.splice(idx, 1); }
      ballsEl.appendChild(
        el(`<div class="ball b-${b} ${isDrawn ? "drawn" : ""}" title="${b} (${BALL_VALUE[b]})"></div>`),
      );
    }
    sh.appendChild(ballsEl);
    if (ps.shake) {
      const speed = ps.moveBudget ?? ps.shake.speed;
      sh.appendChild(el(`<div class="shake-result">Speed <b>${speed}</b></div>`));
    } else {
      sh.appendChild(el(`<div class="shake-hint">Shake in flight to draw 2 balls</div>`));
    }
    side.appendChild(sh);

    // --- Alliances / outposts section ---
    const myStations = state.tradeStations.filter((t) => t.owner === me.id).length;
    if (me.friendshipCards.length > 0 || me.friendshipMarkers.length > 0 || myStations > 0) {
      const al = el(`<div class="side-sec side-alliances"></div>`);
      al.appendChild(el(`<div class="side-title">Outpost alliances</div>`));
      if (myStations > 0) {
        al.appendChild(el(`<div class="ally-stations">${myStations} trade station${myStations > 1 ? "s" : ""}</div>`));
      }
      const myTurn = this.game.isHumanTurn();
      for (const id of me.friendshipCards) {
        const card = friendshipCardById(id);
        const civ = (card?.civ ?? "travelers") as AlienCiv;
        // Diplomat "Fame for Sale" is an *active* ability — make its card a button
        // so the player can find/use it right here (#2). Other cards are passive.
        if (id === "diplomats:fameForSale") {
          const used = (ps.fameBoughtBy ?? []).includes(me.id);
          const enabled = myTurn && !used && me.hand.goods >= 1;
          const hint = !myTurn
            ? "Wait for your turn"
            : used
            ? "Already used this turn"
            : me.hand.goods < 1
            ? "Need 1 goods"
            : "Tap: pay 1 goods → 1 fame";
          const cardEl = el(
            `<div class="ally-card ally-card-active${enabled ? "" : " disabled"}" data-card-id="${id}" style="--c:${CIV_COLOR[civ]}" title="${escapeHtml(card?.text ?? "")}">
                <span class="ally-av">${civAvatarSvg(civ)}</span>
                <span class="ally-text">
                  <span class="ally-civ">${CIV_LABEL[civ]}</span>
                  <span class="ally-name">${escapeHtml(card?.name ?? id)}</span>
                  <span class="ally-desc">${escapeHtml(card?.text ?? "")}</span>
                  <span class="ally-use">${hint}</span>
                </span>
              </div>`,
          );
          if (enabled) {
            cardEl.addEventListener("click", () => this.act({ t: "buyFame" }));
          }
          al.appendChild(cardEl);
          continue;
        }
        al.appendChild(
          el(`<div class="ally-card" data-card-id="${id}" style="--c:${CIV_COLOR[civ]}" title="${escapeHtml(card?.text ?? "")}">
                <span class="ally-av">${civAvatarSvg(civ)}</span>
                <span class="ally-text">
                  <span class="ally-civ">${CIV_LABEL[civ]}</span>
                  <span class="ally-name">${escapeHtml(card?.name ?? id)}</span>
                  <span class="ally-desc">${escapeHtml(card?.text ?? "")}</span>
                </span>
              </div>`),
        );
      }
      for (const civ of me.friendshipMarkers) {
        al.appendChild(
          el(`<div class="ally-marker" style="--c:${CIV_COLOR[civ as AlienCiv]}">${CIV_LABEL[civ as AlienCiv]} marker · +2 VP</div>`),
        );
      }
      side.appendChild(al);
    }

    // Trade moved to the bottom action bar (P6c) — click a resource card there to
    // start trading, which keeps the sidebar compact for small/mobile screens.

    // The build costs + VP reference moved OUT of the Fleet panel to the floating
    // "i" tool (see buildToolsCluster), keeping the sidebar focused on your fleet.

    // --- Log (M2): the activity log now lives inside the Fleet panel, so the
    // single Fleet toggle shows/hides it too (no separate floating log panel). ---
    const logSec = el(`<div class="side-sec side-log"></div>`);
    logSec.appendChild(el(`<div class="side-title">Log</div>`));
    const logBody = el(`<div class="side-log-body"></div>`);
    const lines = state.log.slice(-8);
    if (lines.length === 0) {
      logBody.appendChild(el(`<div class="log-line">No events yet.</div>`));
    } else {
      for (const line of lines) {
        logBody.appendChild(el(`<div class="log-line">${escapeHtml(line)}</div>`));
      }
    }
    logSec.appendChild(logBody);
    side.appendChild(logSec);

    return side;
  }

  /** Reference content (build costs + VP values) for the floating "i" popover. */
  private buildReferenceBody(): HTMLElement {
    const body = el(`<div class="ref-body"></div>`);

    // --- Build costs ---
    body.appendChild(el(`<div class="ref-subtitle">Building costs</div>`));
    const costGlyphs = (cost: Partial<Record<Resource, number>>): string => {
      let html = "";
      for (const r of RESOURCES) {
        const n = cost[r] ?? 0;
        for (let k = 0; k < n; k++) {
          html += `<span class="ref-res" style="color:${RES_COLOR[r]}" title="${RESOURCE_LABEL[r]}">${resourceGlyphSvg(r)}</span>`;
        }
      }
      return html;
    };
    const costRows: [string, string, Partial<Record<Resource, number>>][] = [
      [shipIco("tradeShip"), "Trade Ship", BUILD_COSTS.tradeShip],
      [shipIco("colonyShip"), "Colony Ship", BUILD_COSTS.colonyShip],
      [spaceportIco(), "Spaceport", BUILD_COSTS.spaceport],
      [upgradeIco("freightPod"), "Freight Pod", BUILD_COSTS.freightPod],
      [upgradeIco("cannon"), "Cannon", BUILD_COSTS.cannon],
      [upgradeIco("booster"), "Booster", BUILD_COSTS.booster],
    ];
    for (const [ico, name, cost] of costRows) {
      body.appendChild(
        el(`<div class="ref-row">
              <span class="ref-ico">${ico}</span>
              <span class="ref-name">${name}</span>
              <span class="ref-cost">${costGlyphs(cost)}</span>
            </div>`),
      );
    }

    // --- Victory points ---
    body.appendChild(el(`<div class="ref-subtitle">Victory points</div>`));
    const vpRows: [string, string][] = [
      ["Colony", `${VP.colony}`],
      ["Spaceport", `${VP.spaceport}`],
      ["Trade station", "1"],
      ["Friendship marker", `${VP.friendshipMarker}`],
      ["Fame medal piece", "½"],
      ["2 fame pieces", `${VP.fameMedalPair}`],
      ["Pirate base medal", `${VP.pirateBaseToken}`],
      ["Ice planet medal", `${VP.icePlanetToken}`],
    ];
    for (const [name, val] of vpRows) {
      body.appendChild(
        el(`<div class="ref-row vp-row">
              <span class="ref-name">${name}</span>
              <span class="ref-vp">${val} VP</span>
            </div>`),
      );
    }

    return body;
  }

  /** Floating HUD tools (top-right vertical stack):
   *   ⓘ  — open/close the Costs & victory-points reference popover
   *   👁 — toggle rich hover info on/off (descriptions + map tooltips)
   *   ⌖  — toggle the 60s idle auto-recenter on/off
   *  All three persist across reloads. */
  private buildToolsCluster(): HTMLElement {
    const wrap = el(`<div class="hud-tools"></div>`);

    const iBtn = el(
      `<button class="tool-btn ${this.showRef ? "active" : ""}" title="Building costs & victory points">ⓘ</button>`,
    );
    iBtn.addEventListener("click", () => { this.showRef = !this.showRef; this.rerender(); });
    wrap.appendChild(iBtn);

    // AA4: on small screens the stack collapses to ⓘ + a "⋯" expander so the
    // tools don't eat a whole edge of the phone screen.
    const small = window.innerWidth < 1000;
    if (small) {
      const more = el(
        `<button class="tool-btn ${this.toolsExpanded ? "active" : ""}" title="${this.toolsExpanded ? "Hide tools" : "More tools"}">⋯</button>`,
      );
      more.addEventListener("click", () => {
        this.toolsExpanded = !this.toolsExpanded;
        this.rerender();
      });
      wrap.appendChild(more);
    }
    const extra = (b: HTMLElement): void => {
      if (!small || this.toolsExpanded) wrap.appendChild(b);
    };

    const hoverBtn = el(
      `<button class="tool-btn ${this.hoverInfoOn ? "active" : ""}" title="Hover info: ${this.hoverInfoOn ? "on (tap to hide)" : "off (tap to show)"}">👁</button>`,
    );
    hoverBtn.addEventListener("click", () => {
      this.hoverInfoOn = !this.hoverInfoOn;
      try { localStorage.setItem("sf_hoverInfo", this.hoverInfoOn ? "1" : "0"); } catch { /* ignore */ }
      if (!this.hoverInfoOn) this.costPop.classList.remove("show");
      this.rerender();
    });
    extra(hoverBtn);

    const recBtn = el(
      `<button class="tool-btn ${this.autoRecenterOn ? "active" : ""}" title="Auto-recenter map (60s idle): ${this.autoRecenterOn ? "on" : "off"}">⌖</button>`,
    );
    recBtn.addEventListener("click", () => {
      this.autoRecenterOn = !this.autoRecenterOn;
      try { localStorage.setItem("sf_autoRecenter", this.autoRecenterOn ? "1" : "0"); } catch { /* ignore */ }
      this.board.setAutoRecenter(this.autoRecenterOn);
      this.rerender();
    });
    extra(recBtn);

    const sndBtn = el(
      `<button class="tool-btn ${sfx.muted ? "" : "active"}" title="Sound effects: ${sfx.muted ? "off (tap to enable)" : "on (tap to mute)"}">♪</button>`,
    );
    sndBtn.addEventListener("click", () => {
      sfx.setMuted(!sfx.muted);
      if (!sfx.muted) sfx.play("trade"); // tiny confirmation blip when enabling
      this.rerender();
    });
    extra(sndBtn);

    const musBtn = el(
      `<button class="tool-btn ${music.enabled ? "active" : ""}" title="Ambient music: ${music.enabled ? "on (tap to turn off)" : "off (tap to turn on)"}">♫</button>`,
    );
    musBtn.addEventListener("click", () => {
      music.setEnabled(!music.enabled);
      this.rerender();
    });
    extra(musBtn);

    // Y8: find my fleet — first tap frames everything you own; further taps
    // cycle the camera through your ships one by one.
    const fleetBtn = el(`<button class="tool-btn" title="Find my fleet (tap again to cycle ships)">⌕</button>`);
    fleetBtn.addEventListener("click", () => this.findMyFleet());
    extra(fleetBtn);

    // The reference popover hangs to the LEFT of the "i" button when open.
    if (this.showRef) {
      const pop = el(`<div class="ref-pop"></div>`);
      pop.appendChild(el(`<div class="ref-pop-title">Costs &amp; victory points</div>`));
      pop.appendChild(this.buildReferenceBody());
      wrap.appendChild(pop);
    }
    return wrap;
  }

  /**
   * The always-visible build dock: six equal square tiles (Colony / Trade /
   * Port / Boost / Cannon / Pod) styled like the resource cards — big icon,
   * tiny label, count badge. Tiles LIGHT UP (animated border light) and become
   * clickable only when you can actually build them on your trade & build turn
   * (the Trade tile also lights in flight while a free encounter ship is
   * waiting). Locked tiles stay visible and still show the full cost/uses
   * popover on hover, so the palette doubles as an always-on reference.
   */
  private buildDock(state: GameState, me: PlayerState): HTMLElement {
    const ps = state.phaseState;
    const myTurn = this.game.isHumanTurn();
    const afford = (cost: Partial<ResourceBag>): boolean =>
      RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));
    const blocked =
      (ps.pendingDiscards?.[me.id] ?? 0) > 0 ||
      !!ps.awaitingSteal ||
      !!ps.pendingFriendship ||
      !!ps.pendingTrade;
    const buildPhase = myTurn && ps.phase === "tradeBuild" && !blocked;
    const freeShips = ps.freeTradeShips?.[me.id] ?? 0;
    const hasLaunch = shipLaunchSites(me, state).length > 0;
    const transport = me.supply.transportShips;
    const colonyCount = state.buildings.filter((b) => b.owner === me.id && b.kind === "colony").length;

    const dock = el(`<div class="build-dock"></div>`);
    const tile = (o: {
      ico: string;
      name: string;
      left: number;
      ok: boolean;
      free?: boolean;
      cost: Partial<ResourceBag>;
      uses: string;
      onClick: () => void;
    }): void => {
      const t = el(
        `<button class="bd-tile ${o.ok ? "ok" : "locked"}${o.free ? " free" : ""}" aria-disabled="${!o.ok}">
           <span class="bd-ico">${o.ico}</span>
           <span class="bd-name">${o.name}</span>
           <span class="bd-left ${o.left <= 0 ? "none" : ""}">${o.left}</span>
         </button>`,
      );
      if (o.ok) t.addEventListener("click", o.onClick);
      this.attachCostTip(
        t,
        me,
        o.cost,
        (o.free ? "<b>FREE</b> — granted by an encounter (no resource cost).<br>" : "") + o.uses,
      );
      dock.appendChild(t);
    };

    tile({
      ico: shipIco("colonyShip"), name: "Colony", left: transport,
      cost: BUILD_COSTS.colonyShip, uses: BUILD_USES.colonyShip,
      ok: buildPhase && afford(BUILD_COSTS.colonyShip) && hasLaunch && transport > 0,
      onClick: () => { this.launchKind = "colonyShip"; this.mode = "launchShip"; this.rerender(); },
    });
    // The free encounter trade ship is also launchable mid-flight, so the tile
    // lights up there too (the engine allows the build in that one case).
    const freeOk =
      freeShips > 0 && myTurn && !blocked && hasLaunch && transport > 0 &&
      (ps.phase === "tradeBuild" || ps.phase === "flight");
    tile({
      ico: shipIco("tradeShip"), name: "Trade", left: transport, free: freeShips > 0,
      cost: BUILD_COSTS.tradeShip, uses: BUILD_USES.tradeShip,
      ok: freeOk || (buildPhase && afford(BUILD_COSTS.tradeShip) && hasLaunch && transport > 0),
      onClick: () => { this.launchKind = "tradeShip"; this.mode = "launchShip"; this.rerender(); },
    });
    tile({
      ico: spaceportIco(), name: "Port", left: colonyCount,
      cost: BUILD_COSTS.spaceport, uses: BUILD_USES.spaceport,
      ok: buildPhase && afford(BUILD_COSTS.spaceport) && colonyCount > 0,
      onClick: () => { this.mode = "pickColony"; this.rerender(); },
    });
    const upTile = (k: UpgradeKind, name: string): void => {
      const left = MAX_UPGRADES[k] - me.upgrades[k];
      tile({
        ico: upgradeIco(k), name, left,
        cost: BUILD_COSTS[k], uses: UPGRADE_USES[k],
        ok: buildPhase && afford(BUILD_COSTS[k]) && left > 0,
        onClick: () => this.act({ t: "build", what: k }),
      });
    };
    upTile("booster", "Boost");
    upTile("cannon", "Cannon");
    upTile("freightPod", "Pod");
    // Z3: nudge the single most valuable lit tile (port 2 VP > ships > upgrades)
    // — the pulse only becomes visible after a few idle seconds (CSS delay).
    const tiles = [...dock.querySelectorAll<HTMLElement>(".bd-tile")];
    for (const i of [2, 0, 1, 3, 4, 5]) {
      const t = tiles[i];
      if (t?.classList.contains("ok")) {
        t.classList.add("hint-pulse");
        break;
      }
    }
    return dock;
  }

  /** Y10: paint the corner minimap — planet clusters, outposts, every piece in
   *  its owner's color, and the live viewport rectangle. Click-to-jump is wired
   *  in the constructor via the stored board→canvas mapping. */
  private drawMinimap(state: GameState): void {
    const cv = this.mini;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const W = cv.width;
    const H = cv.height;
    // Board extents from the intersections (the authoritative geometry).
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const it of Object.values(state.intersections)) {
      if (it.x < minX) minX = it.x;
      if (it.x > maxX) maxX = it.x;
      if (it.y < minY) minY = it.y;
      if (it.y > maxY) maxY = it.y;
    }
    if (!isFinite(minX)) return;
    const pad = 10;
    const s = Math.min((W - pad * 2) / (maxX - minX), (H - pad * 2) / (maxY - minY));
    const ox = pad - minX * s + (W - pad * 2 - (maxX - minX) * s) / 2;
    const oy = pad - minY * s + (H - pad * 2 - (maxY - minY) * s) / 2;
    this.miniMapping = { s, ox, oy };
    const px = (x: number): number => x * s + ox;
    const py = (y: number): number => y * s + oy;

    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "rgba(6, 9, 18, 0.92)";
    ctx.fillRect(0, 0, W, H);

    // Planet clusters (per sector) + outposts.
    const PLANET_HEX: Record<string, string> = {
      red: "#ff5d5d", orange: "#ffa23f", blue: "#4fa8ff", green: "#57e389", multicolor: "#c98bff",
    };
    for (const sec of state.sectors) {
      const sx = 1.5 * sec.q;
      const sy = Math.sqrt(3) * (sec.r + sec.q / 2);
      if (sec.kind === "outpost") {
        ctx.fillStyle = sec.discovered ? "#9fd0ff" : "#3a4866";
        ctx.beginPath();
        ctx.moveTo(px(sx), py(sy) - 3.4);
        ctx.lineTo(px(sx) + 3, py(sy));
        ctx.lineTo(px(sx), py(sy) + 3.4);
        ctx.lineTo(px(sx) - 3, py(sy));
        ctx.fill();
        continue;
      }
      sec.planets.forEach((pl, i) => {
        const off = [
          { x: 0, y: -0.55 },
          { x: -0.5, y: 0.35 },
          { x: 0.5, y: 0.35 },
        ][i % 3]!;
        ctx.fillStyle = !pl.explored
          ? "#2e3a56"
          : pl.special === "pirateBase"
            ? "#ff7a6d"
            : pl.special === "icePlanet"
              ? "#bdefff"
              : (PLANET_HEX[pl.color as string] ?? "#8aa0c8");
        ctx.beginPath();
        ctx.arc(px(sx + off.x), py(sy + off.y), 2.1, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // Pieces in owner colors: buildings (squares), ships (dots), stations.
    const ownerHex = new Map(state.players.map((p) => [p.id, COLOR_HEX[p.color]]));
    for (const b of state.buildings) {
      const it = state.intersections[b.intersectionId];
      if (!it) continue;
      ctx.fillStyle = ownerHex.get(b.owner) ?? "#fff";
      const r = b.kind === "spaceport" ? 2.6 : 2;
      ctx.fillRect(px(it.x) - r, py(it.y) - r, r * 2, r * 2);
    }
    for (const sh of state.ships) {
      const it = state.intersections[sh.intersectionId];
      if (!it) continue;
      ctx.fillStyle = ownerHex.get(sh.owner) ?? "#fff";
      ctx.beginPath();
      ctx.arc(px(it.x), py(it.y), 1.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // The live "you are here" viewport box: a translucent fill + bright border,
    // clamped to the minimap so it's always visible (when zoomed in it shrinks
    // to clearly show which slice of the galaxy you're looking at).
    const vr = this.board.visibleBoardRect();
    let rx0 = px(vr.x0), ry0 = py(vr.y0), rx1 = px(vr.x1), ry1 = py(vr.y1);
    rx0 = Math.max(0, Math.min(rx0, W)); rx1 = Math.max(0, Math.min(rx1, W));
    ry0 = Math.max(0, Math.min(ry0, H)); ry1 = Math.max(0, Math.min(ry1, H));
    const rw = Math.max(4, rx1 - rx0), rh = Math.max(4, ry1 - ry0);
    ctx.fillStyle = "rgba(120, 190, 255, 0.16)";
    ctx.fillRect(rx0, ry0, rw, rh);
    ctx.strokeStyle = "rgba(180, 215, 255, 0.95)";
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rx0, ry0, rw, rh);
  }

  /** Y3: big center-screen chooser for the round-4 setup decisions (starting
   *  ship + bonus attachment) — a once-per-game moment that deserves more
   *  than small buttons in the bottom bar. Returns null when not applicable. */
  private buildSetupPop(state: GameState, me: PlayerState, myTurn: boolean): HTMLElement | null {
    const su = state.phaseState.setup;
    if (state.phaseState.phase !== "setup" || !su || !myTurn || su.round !== 4) return null;

    if (su.r4step === "ship" && !this.launchKind) {
      const noSites = shipLaunchSites(me, state).length === 0;
      const pop = el(`
        <div class="setup-pop">
          <div class="sp-title">Choose your starting ship</div>
          <div class="sp-sub">It launches from an open point next to your new spaceport.</div>
          <div class="sp-tiles"></div>
        </div>`);
      const tiles = pop.querySelector(".sp-tiles")!;
      const tile = (kind: ShipKind, name: string, desc: string): void => {
        const t = el(`
          <button class="sp-tile" ${noSites ? "disabled" : ""}>
            <span class="sp-ico">${shipIco(kind)}</span>
            <span class="sp-name">${name}</span>
            <span class="sp-desc">${desc}</span>
          </button>`);
        t.addEventListener("click", () => {
          this.launchKind = kind;
          this.mode = "setupShip";
          this.rerender();
        });
        tiles.appendChild(t);
      };
      tile("colonyShip", "Colony Ship", "Settles new colonies on open double-planet points (+1 VP each).");
      tile("tradeShip", "Trade Ship", "Docks at alien outposts for trade stations + friendship cards.");
      return pop;
    }

    if (su.r4step === "bonus") {
      const pop = el(`
        <div class="setup-pop">
          <div class="sp-title">Choose your bonus attachment</div>
          <div class="sp-sub">A free mothership upgrade to start your voyage.</div>
          <div class="sp-tiles"></div>
        </div>`);
      const tiles = pop.querySelector(".sp-tiles")!;
      const DESC: Record<UpgradeKind, string> = {
        booster: "+1 flight speed on every shake.",
        cannon: "+1 combat — pirates beware.",
        freightPod: "Cargo for trade stations & ice planets.",
      };
      const LABEL: Record<UpgradeKind, string> = { booster: "Booster", cannon: "Cannon", freightPod: "Freight Pod" };
      const seen = new Set<string>();
      for (const up of su.bonusPool ?? []) {
        if (seen.has(up)) continue;
        seen.add(up);
        const t = el(`
          <button class="sp-tile">
            <span class="sp-ico">${upgradeIco(up)}</span>
            <span class="sp-name">${LABEL[up]}</span>
            <span class="sp-desc">${DESC[up]}</span>
          </button>`);
        t.addEventListener("click", () =>
          this.boardConfirm(`Take the ${LABEL[up]} attachment?`, () => this.act({ t: "setupBonus", upgrade: up })));
        tiles.appendChild(t);
      }
      return pop;
    }
    return null;
  }

  /** Set up board click handlers appropriate to the current mode. */
  private wireBoard(state: GameState, me: PlayerState, myTurn: boolean): void {
    if (!myTurn || state.phaseState.phase === "gameOver") {
      this.board.clearHighlights();
      return;
    }

    // Set-up phase: click a glowing site to place a colony, or your colony to upgrade.
    const su = state.phaseState.setup;
    if (state.phaseState.phase === "setup" && su) {
      if (su.step === "place" && su.round >= 1 && su.round <= 3) {
        const sites = catanianColonySites(state);
        this.board.setHighlights(sites);
        this.board.onIntersectionClick = (id) => {
          if (sites.includes(id))
            this.boardConfirm("Place your colony here?", () => this.act({ t: "setupPlaceColony", intersectionId: id }), id);
        };
        return;
      }
      if (su.round === 4 && su.r4step === "upgrade") {
        const colonies = state.buildings
          .filter((b) => b.owner === me.id && b.kind === "colony")
          .map((b) => b.intersectionId);
        this.board.setHighlights(colonies);
        this.board.onIntersectionClick = (id) => {
          if (colonies.includes(id))
            this.boardConfirm("Upgrade this colony to a spaceport?", () => this.act({ t: "setupUpgrade", intersectionId: id }), id);
        };
        return;
      }
      if (su.round === 4 && su.r4step === "ship") {
        // Player picks which open point next to the spaceport to launch onto.
        const sites = shipLaunchSites(me, state);
        this.board.setHighlights(sites);
        const kind = this.launchKind;
        this.board.onIntersectionClick = (id) => {
          if (kind && sites.includes(id)) {
            const label = kind === "colonyShip" ? "Launch your colony ship here?" : "Launch your trade ship here?";
            this.boardConfirm(label, () => {
              this.act({ t: "setupPlaceShip", shipKind: kind, intersectionId: id });
              this.resetSelection();
            }, id);
          }
        };
        return;
      }
      this.board.clearHighlights();
      return;
    }

    if (this.mode === "launchShip" && this.launchKind) {
      const sites = shipLaunchSites(me, state);
      const kind = this.launchKind;
      this.board.setHighlights(sites);
      this.board.onIntersectionClick = (id) => {
        if (sites.includes(id)) {
          this.act({ t: "build", what: kind, targetId: id });
          this.resetSelection();
        }
      };
      return;
    }

    if (this.mode === "pickColony") {
      const colonies = state.buildings
        .filter((b) => b.owner === me.id && b.kind === "colony")
        .map((b) => b.intersectionId);
      this.board.setHighlights(colonies);
      this.board.onIntersectionClick = (id) => {
        if (colonies.includes(id)) {
          this.act({ t: "build", what: "spaceport", targetId: id });
          this.resetSelection();
        }
      };
      return;
    }

    // Trade & Build (idle): show the (up to 2) green launch points next to each
    // of the player's spaceports whenever they can afford a ship and have a free
    // transport. Clicking one opens the colony/trade ship choice (launchPickSite).
    if (state.phaseState.phase === "tradeBuild" && this.mode === "idle") {
      const sites = shipLaunchSites(me, state);
      const canAfford = (cost: Partial<ResourceBag>): boolean =>
        RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));
      const hasFreeTrade = (state.phaseState.freeTradeShips?.[me.id] ?? 0) > 0;
      const canShip =
        me.supply.transportShips > 0 &&
        sites.length > 0 &&
        (canAfford(BUILD_COSTS.colonyShip) || canAfford(BUILD_COSTS.tradeShip) || hasFreeTrade);
      if (canShip) {
        this.board.setHighlights(sites);
        this.board.onIntersectionClick = (id) => {
          if (sites.includes(id)) {
            this.launchPickSite = id;
            // Show the colony/trade chooser right on the map over the clicked
            // point (not in the center action bar).
            this.showLaunchPicker(me, id);
          }
        };
        // Keep an already-open picker anchored after a re-render.
        if (this.launchPickSite && sites.includes(this.launchPickSite)) {
          this.showLaunchPicker(me, this.launchPickSite);
        }
        return;
      }
      this.board.clearHighlights();
      return;
    }

    if (state.phaseState.phase === "flight" && state.phaseState.shake) {
      // Space jump: pick one of your ships, then tap ANY open point on the map.
      if (this.mode === "spaceJump") {
        this.board.onShipClick = (id) => {
          const s = state.ships.find((x) => x.id === id);
          if (s && s.owner === me.id) { this.selectedShipId = id; this.rerender(); }
        };
        if (this.selectedShipId) {
          this.board.setSelectedShip(this.selectedShipId);
          this.board.onIntersectionClick = (id) => {
            const sid = this.selectedShipId!;
            this.selectedShipId = null;
            this.mode = "idle";
            this.board.setSelectedShip(null);
            this.act({ t: "spaceJump", shipId: sid, toIntersectionId: id }, { center: true });
          };
        }
        return;
      }
      this.board.onShipClick = (id) => this.selectShip(state, me, id);
      if (this.mode === "moveShip" && this.selectedShipId) {
        this.board.setSelectedShip(this.selectedShipId);
        this.board.setHighlights([...this.moveTargets.keys()]);
        this.board.onIntersectionClick = (id) => {
          const path = this.moveTargets.get(id);
          if (!path) return;
          const sid = this.selectedShipId!;
          // Confirm the move with a small Yes/No popup over the tapped point
          // (like the colony/trade-ship picker) so a stray tap doesn't move.
          this.mapConfirm(id, () => {
            this.selectedShipId = null;
            this.moveTargets.clear();
            this.mode = "idle";
            this.board.setSelectedShip(null);
            this.act({ t: "moveShip", shipId: sid, path });
          });
        };
      } else {
        this.board.clearHighlights();
      }
      return;
    }

    this.board.clearHighlights();
  }

  private selectShip(state: GameState, me: PlayerState, shipId: string): void {
    const ship = state.ships.find((s) => s.id === shipId);
    if (!ship || ship.owner !== me.id) return;
    const speed = state.phaseState.moveBudget ?? state.phaseState.shake?.speed ?? 0;
    // A ship may move repeatedly until its cumulative distance reaches its speed.
    const remaining = speed - ship.distanceMoved;
    this.selectedShipId = shipId;
    this.mode = "moveShip";
    this.moveTargets =
      remaining > 0 ? reachable(state, ship.intersectionId, remaining) : new Map();
    this.render(state); // re-render to show establish buttons + highlights
  }

  /** AD6: place the fixed primary button just above the action bar's measured
   *  top edge, clamped so it always stays on screen (the bar can be tall). */
  private positionPrimaryButton(): void {
    const pa = this.root.querySelector(".primary-act") as HTMLElement | null;
    const barEl = this.root.querySelector(".actionbar") as HTMLElement | null;
    if (!pa || !barEl) return;
    const br = barEl.getBoundingClientRect();
    let bottom = window.innerHeight - br.top + 8;
    bottom = Math.max(8, Math.min(bottom, window.innerHeight - 70));
    pa.style.bottom = `${bottom}px`;
  }

  /** AD6: describe the phase's single primary action for the floating button. */
  private primaryDescriptor(
    state: GameState,
  ): { label: string; sub: string; run: () => void } | null {
    const ps = state.phaseState;
    if (ps.phase === "production") {
      return {
        label: "Roll the dice", sub: "Production", run: () => {
          if (!ps.lastRoll) this.act({ t: "rollDice" });
        },
      };
    }
    if (ps.phase === "tradeBuild") {
      return { label: "End build → Shake", sub: "Trade & build", run: () => this.endBuildAndShake() };
    }
    if (ps.phase === "flight") {
      if (!ps.shake) {
        return { label: "Shake mothership", sub: "Flight", run: () => this.act({ t: "shakeMothership" }) };
      }
      return {
        label: "End turn", sub: "Flight", run: () => { this.resetSelection(); this.act({ t: "endTurn" }); },
      };
    }
    return null;
  }

  /**
   * AD6: the big standalone primary-action button that floats above the action
   * box. It's the one move that advances your turn. Greyed (non-interactive)
   * when it isn't your turn — but kept on screen so its place never shifts.
   */
  private buildPrimaryButton(state: GameState): HTMLElement | null {
    const ps = state.phaseState;
    if (ps.phase === "setup" || ps.phase === "gameOver") return null;
    const desc = this.primaryDescriptor(state);
    if (!desc) return null;
    const myTurn = this.game.isHumanTurn();
    const me = state.players.find((p) => p.id === this.game.humanId);
    // A decision is owed elsewhere (encounter / discard / steal / trade / friendship)
    // — hide the primary so it can't be pressed past a required choice.
    const blocked =
      !!ps.encounter || !!ps.pendingTrade || !!ps.pendingFriendship || !!ps.awaitingSteal ||
      (me ? (ps.pendingDiscards?.[me.id] ?? 0) > 0 : false);
    if (blocked) return null;

    const active = state.players[ps.activePlayerIndex];
    const enabled = myTurn;
    const wrap = el(
      `<button class="primary-act ${enabled ? "" : "disabled"}">
         <span class="pa-label">${enabled ? escapeHtml(desc.label) : `${escapeHtml(active?.name ?? "Rival")}'s turn`}</span>
         <span class="pa-sub">${enabled ? escapeHtml(desc.sub) : "Please wait…"}</span>
       </button>`,
    );
    if (enabled) wrap.addEventListener("click", () => desc.run());
    return wrap;
  }

  /** AD5: can this ship settle right now? Returns the option (with a block
   *  reason for a pirate/ice-blocked colony) or null. */
  private establishOptionFor(
    state: GameState,
    me: PlayerState,
    ship: GameState["ships"][number],
  ): { kind: "colony" | "trade"; dock?: number; block?: string } | null {
    if (ship.owner !== me.id) return null;
    const inter = state.intersections[ship.intersectionId];
    if (!inter) return null;
    if (
      ship.kind === "colonyShip" &&
      inter.adjacentPlanets.length === 2 &&
      !state.buildings.some((b) => b.intersectionId === inter.id)
    ) {
      return { kind: "colony", block: colonyEstablishBlock(state, me, inter.id) ?? undefined };
    }
    if (ship.kind === "tradeShip" && inter.dockingPointOf) {
      return { kind: "trade", dock: freeDock(state, inter.id) };
    }
    return null;
  }

  /** AD5: floating "Establish …" bubble pinned above the selected ship. */
  private estabPop: HTMLElement | null = null;
  private estabRaf = 0;
  private estabKey = "";

  private confirmPop: HTMLElement | null = null;
  private confirmRaf = 0;

  private clearBoardConfirm(): void {
    if (this.confirmRaf) { cancelAnimationFrame(this.confirmRaf); this.confirmRaf = 0; }
    this.confirmPop?.remove();
    this.confirmPop = null;
  }

  /** Yes/No confirmation bubble for setup placements. When `anchorId` is given
   *  the bubble pins above that board point (and re-pins every frame so it
   *  tracks panning/zooming); otherwise it sits centered on screen. */
  private boardConfirm(label: string, onYes: () => void, anchorId?: string): void {
    this.clearBoardConfirm();
    const pop = el(
      `<div class="confirm-pop${anchorId ? "" : " centered"}">
         <div class="cp-msg">${label}</div>
         <div class="cp-row">
           <button class="cp-yes">Yes</button>
           <button class="cp-no">No</button>
         </div>
       </div>`,
    );
    pop.querySelector(".cp-yes")!.addEventListener("click", () => {
      this.clearBoardConfirm();
      onYes();
    });
    pop.querySelector(".cp-no")!.addEventListener("click", () => this.clearBoardConfirm());
    document.body.appendChild(pop);
    this.confirmPop = pop;
    if (anchorId) {
      const place = (): void => {
        if (!this.confirmPop) return;
        const pos = this.board.screenPosOf(anchorId);
        if (pos) {
          this.confirmPop.style.left = `${pos.x}px`;
          this.confirmPop.style.top = `${pos.y}px`;
        }
        this.confirmRaf = requestAnimationFrame(place);
      };
      place();
    }
  }

  private clearEstablishPopover(): void {
    if (this.estabRaf) { cancelAnimationFrame(this.estabRaf); this.estabRaf = 0; }
    this.estabPop?.remove();
    this.estabPop = null;
    this.estabKey = "";
  }

  /** Show the establish bubble above the tapped ship when it can settle. The
   *  bubble re-pins to the ship every frame so it tracks panning/zooming. */
  private syncEstablishPopover(state: GameState, me: PlayerState): void {
    const ps = state.phaseState;
    const ship = this.selectedShipId
      ? state.ships.find((s) => s.id === this.selectedShipId)
      : undefined;
    const opt =
      this.game.isHumanTurn() && ps.phase === "flight" && ps.shake && ship
        ? this.establishOptionFor(state, me, ship)
        : null;
    if (!ship || !opt) {
      this.clearEstablishPopover();
      return;
    }
    const key = `${ship.id}:${opt.kind}:${opt.block ?? ""}`;
    if (this.estabPop && this.estabKey === key) return; // already shown; RAF keeps it pinned
    this.clearEstablishPopover();
    this.estabKey = key;

    const label = opt.kind === "colony" ? "Establish Colony" : "Establish Trade Station";
    const pop = el(
      `<div class="estab-pop ${opt.block ? "blocked" : ""}"><button class="estab-pop-btn">${opt.block ? "⚠ Can't settle" : "✦ " + label}</button></div>`,
    );
    const button = pop.querySelector(".estab-pop-btn") as HTMLElement;
    if (opt.block) {
      button.addEventListener("click", () => this.centerNote(opt.block!));
    } else {
      button.addEventListener("click", () => {
        if (opt.kind === "colony") this.act({ t: "establishColony", shipId: ship.id }, { center: true });
        else this.act({ t: "establishTradeStation", shipId: ship.id, dock: opt.dock ?? 0 }, { center: true });
        this.resetSelection();
        this.rerender();
      });
    }
    document.body.appendChild(pop);
    this.estabPop = pop;
    const place = (): void => {
      if (!this.estabPop) return;
      const pos = this.board.screenPosOf(ship.intersectionId);
      if (pos) {
        this.estabPop.style.left = `${pos.x}px`;
        this.estabPop.style.top = `${pos.y}px`;
      }
      this.estabRaf = requestAnimationFrame(place);
    };
    place();
  }

  private fillHumanActions(actions: HTMLElement, state: GameState, me: PlayerState): void {
    const ps = state.phaseState;
    const btn = (
      label: string,
      onClick: () => void,
      opts: { disabled?: boolean; secondary?: boolean; title?: string } = {},
    ): HTMLElement => {
      const b = el(`<button class="${opts.secondary ? "secondary" : ""}">${label}</button>`);
      if (opts.title) (b as HTMLButtonElement).title = opts.title;
      if (opts.disabled) (b as HTMLButtonElement).disabled = true;
      else b.addEventListener("click", onClick);
      return b;
    };
    switch (ps.phase) {
      case "setup": {
        const su = ps.setup;
        if (!su) break;
        if (su.step === "rollStart") {
          const rolled = su.startRolls[state.players.indexOf(me)] !== undefined;
          if (rolled) {
            actions.appendChild(el(`<div class="waiting">You rolled. Waiting for the others…</div>`));
          } else {
            actions.appendChild(
              btn("🎲 Roll for starting position", () => this.act({ t: "setupRoll" })),
            );
          }
          break;
        }
        // Placement rounds 1–3: pick a glowing Catanian colony site.
        if (su.round >= 1 && su.round <= 3) {
          actions.appendChild(
            el(`<div class="waiting">Round ${su.round} of 4 — click a glowing colony site to place a colony.</div>`),
          );
          break;
        }
        // Round 4: upgrade → place ship → take a bonus upgrade. The SHIP and
        // BONUS choices pop as big center-screen modals (see buildSetupPop) —
        // this once-per-game moment deserves the spotlight, not tiny buttons.
        if (su.round === 4) {
          if (su.r4step === "upgrade") {
            actions.appendChild(
              el(`<div class="waiting">Round 4 — click one of your colonies to upgrade it to a spaceport.</div>`),
            );
          } else if (su.r4step === "ship") {
            const hint = this.launchKind
              ? `Round 4 — click a glowing point next to your spaceport to launch your ${this.launchKind === "colonyShip" ? "colony" : "trade"} ship.`
              : "Round 4 — choose your starting ship.";
            actions.appendChild(el(`<div class="waiting">${hint}</div>`));
          } else if (su.r4step === "bonus") {
            actions.appendChild(el(`<div class="waiting">Round 4 — choose your bonus attachment.</div>`));
          }
        }
        break;
      }

      case "production":
        // Rolling is the floating primary-action button now (AD6).
        actions.appendChild(el(`<div class="waiting">Roll to gather resources.</div>`));
        break;

      case "tradeBuild": {
        // The six build options live in the always-visible build dock (the row
        // of square tiles under the action bar) — they light up during this
        // phase. The center bar keeps only the phase-specific actions.
        // Diplomat "Fame for Sale": pay 1 goods for 1 fame piece, once per turn.
        if (me.friendshipCards.includes("diplomats:fameForSale")) {
          const used = (ps.fameBoughtBy ?? []).includes(me.id);
          actions.appendChild(
            btn("Buy Fame (1 goods)", () => this.act({ t: "buyFame" }), {
              disabled: used || me.hand.goods < 1,
              secondary: true,
              title: used
                ? "Already bought fame this turn."
                : me.hand.goods < 1
                ? "Need 1 goods."
                : "Pay 1 goods for 1 fame medal piece.",
            }),
          );
        }
        // "End build → Shake" is the floating primary-action button now (AD6).
        actions.appendChild(el(`<div class="waiting">Build from the dock below, or fly.</div>`));
        break;
      }

      case "flight": {
        // Shaking the mothership is the floating primary-action button now (AD6).
        if (!ps.shake) {
          actions.appendChild(el(`<div class="waiting">Shake the mothership to fly.</div>`));
          break;
        }
        const speed = ps.moveBudget ?? ps.shake.speed;
        actions.appendChild(el(`<div class="waiting">Speed ${speed}</div>`));

        // Space jump earned from an encounter: jump one ship to ANY open point.
        const jumps = ps.spaceJumps?.[me.id] ?? 0;
        if (jumps > 0) {
          if (this.mode === "spaceJump") {
            actions.appendChild(
              el(`<div class="waiting">✦ Space jump: ${this.selectedShipId ? "tap any open point on the map" : "tap one of your ships"}.</div>`),
            );
            actions.appendChild(btn("Cancel jump", () => { this.resetSelection(); this.rerender(); }, { secondary: true }));
          } else {
            actions.appendChild(btn(`✦ Space Jump${jumps > 1 ? ` (${jumps})` : ""}`, () => {
              this.resetSelection();
              this.mode = "spaceJump";
              this.rerender();
            }));
          }
        }

        // Free trade ship granted by an encounter: launch it at NO cost onto an
        // open point next to one of your spaceports, right here in flight.
        const freeShips = ps.freeTradeShips?.[me.id] ?? 0;
        if (freeShips > 0) {
          const hasLaunch = shipLaunchSites(me, state).length > 0;
          if (this.mode === "launchShip" && this.launchKind === "tradeShip") {
            actions.appendChild(el(`<div class="waiting">🚀 Tap a glowing point next to your spaceport to launch your free trade ship.</div>`));
            actions.appendChild(btn("Cancel", () => { this.resetSelection(); this.rerender(); }, { secondary: true }));
          } else {
            actions.appendChild(btn(
              `🚀 Launch free trade ship${freeShips > 1 ? ` (${freeShips})` : ""}`,
              () => { this.resetSelection(); this.launchKind = "tradeShip"; this.mode = "launchShip"; this.rerender(); },
              { disabled: !hasLaunch, title: hasLaunch ? "Launch your free trade ship (no resource cost)." : "No open space point next to a spaceport to launch from." },
            ));
          }
        }

        const ship = this.selectedShipId
          ? state.ships.find((s) => s.id === this.selectedShipId)
          : undefined;

        // AD5: establishing a colony / trade station now pops up ABOVE the ship
        // you tap (see syncEstablishPopover), not as buttons in this box. Here we
        // only compute whether ANY of your ships could settle, to drive the
        // auto-end-turn fallback below.
        const myShips = state.ships.filter((s) => s.owner === me.id);
        const establishAvailable = myShips.some((s) => this.establishOptionFor(state, me, s) !== null);

        // #6: a ship can move only if it's owned by me and not the damaged/frozen one.
        const canMove = myShips.some((s) => s.id !== ps.frozenShipId);
        // After the shake (no live encounter to resolve), if the player has nothing
        // to do — no ship to move and nothing to establish — end the turn for them
        // automatically rather than make them press End turn.
        if (
          this.game.isHumanTurn() &&
          !ps.encounter &&
          !canMove &&
          !establishAvailable &&
          (ps.shakeCount ?? 0) > this.lastAutoEndShake
        ) {
          this.lastAutoEndShake = ps.shakeCount ?? 0;
          actions.appendChild(el(`<div class="waiting">No ships to move — ending turn…</div>`));
          window.setTimeout(() => {
            const cur = this.game.getState().phaseState;
            if (cur.phase === "flight" && this.game.isHumanTurn() && !cur.encounter) {
              this.resetSelection();
              this.act({ t: "endTurn" });
            }
          }, 900);
          break;
        }

        if (myShips.length === 0) {
          actions.appendChild(el(`<div class="waiting">No ships — build one next turn.</div>`));
        } else {
          actions.appendChild(
            el(`<div class="waiting">${ship ? "Click a green node to move" : "Click a ship to move"}</div>`),
          );
        }
        actions.appendChild(btn("End turn", () => { this.resetSelection(); this.act({ t: "endTurn" }); }, { secondary: true }));
        break;
      }

      default:
        break;
    }
  }

  /**
   * Unified trade panel (N8). Build a Give/Want offer with steppers. The **Bank**
   * button trades with the supply — it's enabled only when the offer is exactly a
   * single bank trade (give = one resource at its bank ratio, want = 1 of one
   * resource). If the offer is anything more/other, Bank greys out and the
   * **Offer** button (player-to-player) takes over.
   */
  private fillTradePanel(actions: HTMLElement, me: PlayerState): void {
    const wrap = el(`<div class="ptrade-wrap"></div>`);
    const stepper = (
      label: string,
      bag: Partial<Record<Resource, number>>,
      cap: (r: Resource) => number,
    ): void => {
      const row = el(`<div class="ptrade-row"><span class="trade-lbl">${label}</span><div class="ptrade-cells"></div></div>`);
      const cells = row.querySelector(".ptrade-cells")!;
      for (const r of RESOURCES) {
        const n = bag[r] ?? 0;
        const cell = el(
          `<div class="ptrade-cell res-cube ${n > 0 ? "on" : ""}" title="${RESOURCE_LABEL[r]}" style="--res:${RES_COLOR[r]}">
             <span class="pc-glyph res-glyph">${resourceGlyphSvg(r)}</span>
             <span class="pc-name">${RESOURCE_LABEL[r]}</span>
             ${n > 0 ? `<span class="pc-badge">${n}</span>` : ""}
             <div class="pc-stepper">
               <button class="step minus" ${n <= 0 ? "disabled" : ""}>−</button>
               <span class="pc-n">${n}</span>
               <button class="step plus" ${n >= cap(r) ? "disabled" : ""}>+</button>
             </div>
           </div>`,
        );
        const [minus, plus] = cell.querySelectorAll("button");
        if (n > 0) minus!.addEventListener("click", () => { bag[r] = n - 1; this.rerender(); });
        if (n < cap(r)) plus!.addEventListener("click", () => { bag[r] = n + 1; this.rerender(); });
        cells.appendChild(cell);
      }
      wrap.appendChild(row);
    };
    // Give is chosen by tapping the hand cards (P6c) — show it as a compact,
    // read-only summary here; only the Want side gets steppers.
    const giveSummary = el(`<div class="ptrade-row give-row"><span class="trade-lbl">Give</span><div class="give-bag"></div></div>`);
    const giveBag = giveSummary.querySelector(".give-bag")!;
    const givenRes = RESOURCES.filter((r) => (this.pGive[r] ?? 0) > 0);
    if (givenRes.length === 0) {
      giveBag.appendChild(el(`<span class="give-hint">Tap your cards above to add</span>`));
    } else {
      for (const r of givenRes) {
        giveBag.appendChild(
          el(`<span class="bag-ico" title="${RESOURCE_LABEL[r]}" style="--res:${RES_COLOR[r]}"><span class="bi-g">${resourceGlyphSvg(r)}</span>${this.pGive[r]}</span>`),
        );
      }
    }
    wrap.appendChild(giveSummary);
    // You can only ask for resources you're NOT already giving — no swapping a
    // resource for the same resource. Cap those at 0 so their "+" stays disabled.
    stepper("Want", this.pWant, (r) => ((this.pGive[r] ?? 0) > 0 ? 0 : 9));

    const giveRes = RESOURCES.filter((r) => (this.pGive[r] ?? 0) > 0);
    const giveN = RESOURCES.reduce((s, r) => s + (this.pGive[r] ?? 0), 0);
    const wantN = RESOURCES.reduce((s, r) => s + (this.pWant[r] ?? 0), 0);

    // Bank trade across a mixed give: each given resource buys (amount / its
    // ratio) cards, and the amount must be a whole multiple of that ratio.
    // Total buy-power is the sum, and Want must equal that total. e.g.
    // 4 goods (2:1 → 2) + 3 food (3:1 → 1) = 3 cards in any mix.
    let bankBought = 0;
    let bankGiveValid = giveRes.length > 0;
    for (const g of giveRes) {
      const ratio = tradeRatioFor(me, g);
      const amt = this.pGive[g] ?? 0;
      if (amt % ratio !== 0) { bankGiveValid = false; break; }
      bankBought += amt / ratio;
    }
    const bankTrade = bankGiveValid && wantN > 0 && wantN === bankBought;

    const btns = el(`<div class="trade-actions"></div>`);
    // Bank button.
    const bankTitle = bankTrade
      ? "Trade with the supply at the bank ratio."
      : bankGiveValid
        ? `These cards buy ${bankBought} from the bank — set Want to ${bankBought}.`
        : "Give resources in whole multiples of their bank ratio (goods 2:1, others 3:1).";
    const bankBtn = el(`<button ${bankTrade ? "" : "disabled"} title="${bankTitle}">Bank</button>`);
    if (bankTrade) {
      bankBtn.addEventListener("click", () => {
        this.act({ t: "tradeWithSupply", give: { ...this.pGive }, take: { ...this.pWant } });
        this.resetSelection();
      });
    }
    btns.appendChild(bankBtn);
    // Offer-to-players button. R14: keep this available even when the offer also
    // qualifies as a bank trade, so the player can still choose to shop the deal to
    // other players rather than the supply. Only hide it when there's nothing set.
    if (giveN + wantN > 0) {
      const offer = el(`<button class="${bankTrade ? "secondary" : ""}">Offer to players</button>`);
      offer.addEventListener("click", () => {
        this.act({ t: "proposeTrade", give: { ...this.pGive }, want: { ...this.pWant } });
      });
      btns.appendChild(offer);
    }
    wrap.appendChild(btns);
    actions.appendChild(wrap);
  }

  /** Show a live offer's responses and let the proposer finalize with one player (or cancel). */
  private fillPlayerTradeStatus(actions: HTMLElement, state: GameState, me: PlayerState): void {
    const offer = state.phaseState.pendingTrade!;
    const bagText = (bag: Partial<Record<Resource, number>>): string => {
      const parts = RESOURCES.filter((r) => (bag[r] ?? 0) > 0).map(
        (r) =>
          `<span class="bag-ico" title="${RESOURCE_LABEL[r]}" style="--res:${RES_COLOR[r]}"><span class="bi-g">${resourceGlyphSvg(r)}</span>${bag[r]}</span>`,
      );
      return parts.length ? parts.join("") : "nothing";
    };
    const mine = offer.fromId === me.id;

    if (!mine) {
      const from = state.players.find((p) => p.id === offer.fromId);
      actions.appendChild(
        el(`<div class="ptrade-summary">${escapeHtml(from?.name ?? "A player")} offers you <b>${bagText(offer.give)}</b> for <b>${bagText(offer.want)}</b>.</div>`),
      );
      // Have I already responded to this offer?
      const myResp = offer.responses.find((rr) => rr.playerId === me.id);
      if (myResp) {
        const tag =
          myResp.kind === "accept" ? "You accepted — waiting on them." :
          myResp.kind === "decline" ? "You declined." : "You sent a counter.";
        actions.appendChild(el(`<div class="ptrade-mine-resp">${tag}</div>`));
        return;
      }
      // Can I cover what they want? (their "want" comes out of MY hand)
      const canCover = RESOURCES.every((r) => me.hand[r] >= (offer.want[r] ?? 0));
      const btns = el(`<div class="trade-actions"></div>`);
      const accept = el(`<button ${canCover ? "" : "disabled"} title="${canCover ? "Accept the offer." : "You don't have what they want."}">Accept</button>`);
      if (canCover) accept.addEventListener("click", () => { this.act({ t: "respondTrade", accept: true }); });
      const counterBtn = el(`<button class="secondary">${this.counterOpen ? "Hide counter" : "Counter…"}</button>`);
      counterBtn.addEventListener("click", () => { this.counterOpen = !this.counterOpen; this.rerender(); });
      const decline = el(`<button class="secondary">Decline</button>`);
      decline.addEventListener("click", () => { this.counterOpen = false; this.act({ t: "respondTrade", accept: false }); });
      btns.append(accept, counterBtn, decline);
      actions.appendChild(btns);
      // R7: a counter-offer editor (from the human's own perspective). The engine
      // expresses counters from the PROPOSER's perspective, so we map:
      //   counterGive (proposer gives) = what I want to receive (cWant)
      //   counterWant (proposer wants) = what I'm offering           (cGive)
      if (this.counterOpen) this.fillCounterEditor(actions, me);
      return;
    }

    actions.appendChild(
      el(`<div class="ptrade-summary">You offer <b>${bagText(offer.give)}</b> for <b>${bagText(offer.want)}</b>.</div>`),
    );
    const list = el(`<div class="ptrade-responses"></div>`);
    for (const p of state.players) {
      if (p.id === offer.fromId) continue;
      const resp = offer.responses.find((rr) => rr.playerId === p.id);
      const row = el(`<div class="ptrade-resp"><span class="dot ${p.color}"></span><span class="pname">${escapeHtml(p.name)}</span></div>`);
      if (!resp) {
        row.appendChild(el(`<span class="resp-tag waiting">thinking…</span>`));
      } else if (resp.kind === "decline") {
        row.appendChild(el(`<span class="resp-tag decline">declined</span>`));
      } else if (resp.kind === "accept") {
        row.appendChild(el(`<span class="resp-tag accept">accepts</span>`));
        const b = el(`<button class="resp-do">Trade</button>`);
        b.addEventListener("click", () => { this.act({ t: "finalizeTrade", withId: p.id }); this.resetSelection(); });
        row.appendChild(b);
      } else {
        row.appendChild(
          el(`<span class="resp-tag counter">counters: give <b>${bagText(resp.give ?? {})}</b> for <b>${bagText(resp.want ?? {})}</b></span>`),
        );
        const b = el(`<button class="resp-do">Accept counter</button>`);
        b.addEventListener("click", () => { this.act({ t: "finalizeTrade", withId: p.id }); this.resetSelection(); });
        row.appendChild(b);
      }
      list.appendChild(row);
    }
    actions.appendChild(list);
    const cancel = el(`<button class="secondary">Cancel offer</button>`);
    cancel.addEventListener("click", () => { this.act({ t: "cancelTrade" }); this.resetSelection(); });
    actions.appendChild(cancel);
  }

  /**
   * R7: lets a human who RECEIVED an offer build a counter from their own point of
   * view ("I give" / "I want") with steppers, then send it. We bound each stepper:
   * "I give" can't exceed what's in hand; "I want" is capped at a small number and
   * forbidden on resources already being given (no same-for-same swaps).
   */
  private fillCounterEditor(actions: HTMLElement, me: PlayerState): void {
    const wrap = el(`<div class="ptrade-wrap counter-wrap"></div>`);
    const stepper = (
      label: string,
      bag: Partial<Record<Resource, number>>,
      cap: (r: Resource) => number,
    ): void => {
      const row = el(`<div class="ptrade-row"><span class="trade-lbl">${label}</span><div class="ptrade-cells"></div></div>`);
      const cells = row.querySelector(".ptrade-cells")!;
      for (const r of RESOURCES) {
        const n = bag[r] ?? 0;
        const cell = el(
          `<div class="ptrade-cell res-cube ${n > 0 ? "on" : ""}" title="${RESOURCE_LABEL[r]}" style="--res:${RES_COLOR[r]}">
             <span class="pc-glyph res-glyph">${resourceGlyphSvg(r)}</span>
             <span class="pc-name">${RESOURCE_LABEL[r]}</span>
             ${n > 0 ? `<span class="pc-badge">${n}</span>` : ""}
             <div class="pc-stepper">
               <button class="step minus" ${n <= 0 ? "disabled" : ""}>−</button>
               <span class="pc-n">${n}</span>
               <button class="step plus" ${n >= cap(r) ? "disabled" : ""}>+</button>
             </div>
           </div>`,
        );
        const [minus, plus] = cell.querySelectorAll("button");
        if (n > 0) minus!.addEventListener("click", () => { bag[r] = n - 1; this.rerender(); });
        if (n < cap(r)) plus!.addEventListener("click", () => { bag[r] = n + 1; this.rerender(); });
        cells.appendChild(cell);
      }
      wrap.appendChild(row);
    };
    // "I give" capped by hand; "I want" capped at 9 but 0 for resources I'm giving.
    stepper("You give", this.cGive, (r) => Math.min(me.hand[r], 9));
    stepper("You want", this.cWant, (r) => ((this.cGive[r] ?? 0) > 0 ? 0 : 9));

    const giveN = RESOURCES.reduce((s, r) => s + (this.cGive[r] ?? 0), 0);
    const wantN = RESOURCES.reduce((s, r) => s + (this.cWant[r] ?? 0), 0);
    const btns = el(`<div class="trade-actions"></div>`);
    const send = el(`<button ${giveN > 0 && wantN > 0 ? "" : "disabled"} title="Send this counter-offer back.">Send counter</button>`);
    if (giveN > 0 && wantN > 0) {
      send.addEventListener("click", () => {
        // Map the human's perspective → the proposer's perspective for the engine.
        this.act({
          t: "respondTrade",
          accept: true,
          counterGive: { ...this.cWant },
          counterWant: { ...this.cGive },
        });
        this.counterOpen = false;
        this.cGive = {};
        this.cWant = {};
      });
    }
    btns.appendChild(send);
    wrap.appendChild(btns);
    actions.appendChild(wrap);
  }

  /** Keep the center-screen encounter overlay (visible to all) in sync with state. */
  private syncEncounterOverlay(state: GameState, me: PlayerState): void {
    const enc = state.phaseState.encounter;

    // Entering / switching encounter: snapshot players, (re)build the overlay.
    // All-player cards also rebuild whenever the confirmation count changes so the
    // "x of N confirmed" tally and the local Confirm button stay current.
    const confirmCount = enc?.confirmedBy?.length ?? -1;
    const isNew =
      enc &&
      (this.shownEncounter?.cardId !== enc.cardId ||
        this.shownEncounter?.subjectId !== enc.subjectId);
    const confirmChanged = enc?.allPlayers && confirmCount !== this.shownConfirmCount;
    // A card can switch its prompt mid-resolution (combat defeat → "selectShip").
    const stepChanged = enc && this.shownEncounter?.awaiting !== enc.awaiting;
    // A duel rebuilds whenever either roll arrives (so the buttons / rolls update).
    const duelSig = `${enc?.duel?.subjectRoll ?? "x"}|${enc?.duel?.oppRoll ?? "x"}`;
    const duelChanged = enc?.awaiting === "duel" && duelSig !== this.shownDuelSig;
    if (enc && (isNew || confirmChanged || stepChanged || duelChanged)) {
      if (isNew) { this.snapshotPlayers(state); this.encLogMark = state.log.length; sfx.play("encounter"); }
      this.shownEncounter = { cardId: enc.cardId, subjectId: enc.subjectId, awaiting: enc.awaiting };
      this.shownConfirmCount = confirmCount;
      this.shownDuelSig = duelSig;
      // Only a brand-new card plays the 3D flip reveal; mid-card updates
      // (duel rolls, confirm tallies) re-render already face-up.
      this.buildEncounterOverlay(state, enc.subjectId === me.id, me, !!isNew);
    }

    // Encounter resolved: animate the result for the subject, then drop overlay.
    if (!enc && this.shownEncounter) {
      const subjectId = this.shownEncounter.subjectId;
      this.shownEncounter = null;
      this.shownConfirmCount = -1;
      this.removeEncounterOverlay();
      this.playEncounterResult(state, subjectId, subjectId === me.id);
    }
  }

  private snapshotPlayers(state: GameState): void {
    this.encSnapshot = {};
    for (const p of state.players) {
      this.encSnapshot[p.id] = {
        fame: p.fameMedalPieces,
        medals: p.victoryMedals,
        hand: { ...p.hand },
      };
    }
  }

  private buildEncounterOverlay(state: GameState, mineToChoose: boolean, me: PlayerState, reveal = false): void {
    this.removeEncounterOverlay();
    const enc = state.phaseState.encounter!;
    const card = ENCOUNTER_CARDS[enc.cardId];
    const subject = state.players.find((p) => p.id === enc.subjectId)!;
    // Y5: the card is a physical object — a 3D shell with an ornate card BACK
    // that flips over to reveal the face (only on a fresh draw), then floats.
    const overlay = el(`
      <div class="encounter-overlay">
        <div class="enc-3d ${reveal ? "flip" : "revealed"}">
          <div class="enc-face enc-back">
            <div class="eb-ring"></div>
            <div class="eb-emblem">${shipIco()}</div>
            <div class="eb-label">ENCOUNTER</div>
            <div class="eb-num">№ ${enc.cardId}</div>
          </div>
          <div class="enc-face enc-front"><div class="encounter-card"></div></div>
        </div>
      </div>`);
    const cardEl = overlay.querySelector(".encounter-card") as HTMLElement;
    // Crest: each card category carries its own emblem at the top of the face.
    const crest =
      card?.category === "merchant"
        ? civAvatarSvg("merchants")
        : card?.category === "traveler"
          ? civAvatarSvg("travelers" as AlienCiv)
          : card?.category === "pirate"
            ? pirateGlyphSvg()
            : card?.category === "bounty"
              ? medalGlyphSvg()
              : card?.category === "wearTear"
                ? upgradeIco("freightPod")
                : shipIco();
    cardEl.appendChild(el(`<div class="enc-crest">${crest}</div>`));
    cardEl.appendChild(el(`<div class="enc-tag">Encounter</div>`));
    cardEl.appendChild(el(`<div class="enc-title">${escapeHtml(card?.title ?? "Encounter")}</div>`));
    cardEl.appendChild(el(`<div class="enc-text">${escapeHtml(card?.text ?? "")}</div>`));

    // Interactive duel: the subject and the designated rival each shake. Whoever
    // hasn't shaken yet (and it's their seat) gets a Shake button; everyone sees
    // both rolls as they come in.
    if (enc.awaiting === "duel" && enc.duel) {
      const opp = state.players.find((p) => p.id === enc.duel!.opponentId);
      const statLabel = enc.duel.stat === "combat" ? "combat strength" : "speed";
      cardEl.appendChild(el(`<div class="enc-subject">Duel — compare ${statLabel}</div>`));
      const row = (p: PlayerState | undefined, roll: number | undefined, role: string): HTMLElement => {
        const name = p ? escapeHtml(p.name) : "Rival";
        const col = p ? COLOR_HEX[p.color] : "#fff";
        return el(`<div class="enc-rost" style="color:${col};opacity:1">${role}: <b>${name}</b> ${roll != null ? `— shook <b>${roll}</b>` : "— …"}</div>`);
      };
      const roster = el(`<div class="enc-roster" style="flex-direction:column;gap:6px"></div>`);
      roster.appendChild(row(subject, enc.duel.subjectRoll, "Pilot"));
      roster.appendChild(row(opp, enc.duel.oppRoll, "Rival"));
      cardEl.appendChild(roster);
      const iAmSubject = enc.subjectId === me.id && enc.duel.subjectRoll == null;
      const iAmOpp = enc.duel.opponentId === me.id && enc.duel.oppRoll == null;
      const choices = el(`<div class="enc-choices"></div>`);
      if (iAmSubject || iAmOpp) {
        if (iAmOpp) cardEl.querySelector(".enc-text")!.textContent = "You act as the rival — shake your mothership!";
        const b = el(`<button>🎲 Shake the mothership</button>`);
        b.addEventListener("click", () => {
          // One shake per dueller: disable instantly so a fast double-tap (or
          // multiplayer latency) can't fire a second, rejected shake.
          (b as HTMLButtonElement).disabled = true;
          this.act({ t: "encounterShake" });
        });
        choices.appendChild(b);
      } else {
        choices.appendChild(el(`<div class="enc-wait">Waiting for both motherships to shake…</div>`));
      }
      cardEl.appendChild(choices);
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("show"));
      return;
    }

    if (enc.allPlayers) {
      // Wear & Tear: affects everyone — stays up until all players confirm.
      const everyone = state.players.filter((p) => p.connected);
      const confirmed = enc.confirmedBy ?? [];
      cardEl.appendChild(
        el(`<div class="enc-subject">Affects all players — ${confirmed.length}/${everyone.length} confirmed</div>`),
      );
      const roster = el(`<div class="enc-roster"></div>`);
      for (const p of everyone) {
        const done = confirmed.includes(p.id);
        roster.appendChild(
          el(`<span class="enc-rost ${done ? "done" : ""}" style="color:${COLOR_HEX[p.color]}">${done ? "✓" : "…"} ${escapeHtml(p.name)}</span>`),
        );
      }
      cardEl.appendChild(roster);
      if (!confirmed.includes(me.id)) {
        const choices = el(`<div class="enc-choices"></div>`);
        // P6i: if I'm over the upgrade limit, I choose WHICH upgrade to scrap —
        // each as its own button (disabled when I hold none of that kind). At or
        // below the limit, a plain Confirm acknowledges the card.
        const threshold = card?.wearTearThreshold;
        const myTotal = me.upgrades.booster + me.upgrades.cannon + me.upgrades.freightPod;
        if (threshold !== undefined && myTotal > threshold) {
          choices.classList.add("col");
          cardEl.querySelector(".enc-text")!.textContent =
            `You're over the limit — choose which upgrade to scrap (${myTotal} upgrades).`;
          const opts: [UpgradeKind, string, number][] = [
            ["booster", "Booster", 0],
            ["cannon", "Cannon", 1],
            ["freightPod", "Freight Pod", 2],
          ];
          for (const [kind, label, idx] of opts) {
            const have = me.upgrades[kind];
            const b = el(`<button class="enc-opt" ${have > 0 ? "" : "disabled"}><span class="ms-ico">${upgradeIco(kind)}</span><span class="eo-n">Scrap ${label}</span><span class="eo-hint">you have ${have}</span></button>`);
            if (have > 0) b.addEventListener("click", () => this.act({ t: "encounterChoice", choice: idx }));
            choices.appendChild(b);
          }
        } else {
          const b = el(`<button>Confirm</button>`);
          b.addEventListener("click", () => this.act({ t: "encounterChoice", choice: 0 }));
          choices.appendChild(b);
        }
        cardEl.appendChild(choices);
      } else {
        cardEl.appendChild(el(`<div class="enc-wait">Waiting for the other players…</div>`));
      }
      document.body.appendChild(overlay);
      requestAnimationFrame(() => overlay.classList.add("show"));
      return;
    }

    cardEl.appendChild(
      el(`<div class="enc-subject" style="color:${COLOR_HEX[subject.color]}">${escapeHtml(subject.name)} is resolving this encounter</div>`),
    );

    if (mineToChoose) {
      const choices = el(`<div class="enc-choices"></div>`);
      if (enc.awaiting === "giveResources") {
        // Surrender N resources of your choice — pick which from your hand.
        choices.classList.add("col");
        const owed = enc.lossCount ?? 0;
        cardEl.querySelector(".enc-text")!.textContent =
          `Hand over ${owed} resource(s) — choose which from your hand.`;
        const picked: Partial<Record<Resource, number>> = {};
        const picker = el(`<div class="enc-give"></div>`);
        const tally = el(`<div class="enc-give-tally"></div>`);
        const giveBtn = el(`<button disabled>Give</button>`);
        const refresh = (): void => {
          picker.innerHTML = "";
          let total = 0;
          for (const r of RESOURCES) {
            const have = subject.hand[r];
            const n = picked[r] ?? 0;
            total += n;
            const cell = el(
              `<div class="ptrade-cell res-cube ${n > 0 ? "on" : ""}" title="${RESOURCE_LABEL[r]}" style="--res:${RES_COLOR[r]}">
                 <span class="pc-glyph res-glyph">${resourceGlyphSvg(r)}</span>
                 <span class="pc-name">${RESOURCE_LABEL[r]}</span>
                 ${n > 0 ? `<span class="pc-badge">${n}</span>` : ""}
                 <div class="pc-stepper">
                   <button class="step minus" ${n <= 0 ? "disabled" : ""}>−</button>
                   <span class="pc-n">${n}/${have}</span>
                   <button class="step plus" ${n >= have || total >= owed ? "disabled" : ""}>+</button>
                 </div>
               </div>`,
            );
            const [minus, plus] = cell.querySelectorAll("button");
            minus!.addEventListener("click", () => { picked[r] = Math.max(0, n - 1); refresh(); });
            plus!.addEventListener("click", () => { picked[r] = n + 1; refresh(); });
            picker.appendChild(cell);
          }
          tally.textContent = `${total} / ${owed} selected`;
          giveBtn.toggleAttribute("disabled", total !== owed);
        };
        giveBtn.addEventListener("click", () =>
          this.act({ t: "encounterChoice", choice: 0, resources: { ...picked } }),
        );
        refresh();
        choices.append(picker, tally, giveBtn);
        cardEl.appendChild(choices);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add("show"));
        return;
      }
      if (enc.awaiting === "selectShip") {
        // Combat defeat: pick which of your ships is immobilized this turn.
        const myShips = state.ships.filter((s) => s.owner === subject.id);
        cardEl.querySelector(".enc-text")!.textContent =
          "Defeat! Choose one of your ships — it cannot move this turn.";
        myShips.forEach((s, i) => {
          const label = s.kind === "colonyShip" ? "Colony ship" : "Trade ship";
          const b = el(`<button class="secondary">${label} #${i + 1}</button>`);
          b.addEventListener("click", () => this.act({ t: "encounterChoice", choice: i }));
          choices.appendChild(b);
        });
        cardEl.appendChild(choices);
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add("show"));
        return;
      }
      if (enc.awaiting === "confirm") {
        // Auto-resolving bounty card: a single acknowledgement button.
        const b = el(`<button>Continue</button>`);
        b.addEventListener("click", () => this.act({ t: "encounterChoice", choice: 0 }));
        choices.appendChild(b);
      } else if (enc.awaiting === "number") {
        // P6d: the *outcome* is hidden — show only the choice itself (how much
        // you offer). What you gain or lose is a surprise revealed after you pick.
        choices.classList.add("col");
        for (const n of [0, 1, 2, 3]) {
          const label = n === 0 ? "Offer nothing" : `Offer ${n}`;
          const b = el(
            `<button class="secondary enc-opt"><span class="eo-n">${n}</span><span class="eo-hint">${label}</span></button>`,
          );
          b.addEventListener("click", () => this.act({ t: "encounterChoice", choice: n }));
          choices.appendChild(b);
        }
      } else {
        // P6d: plain Yes / No — outcome stays secret until the player commits.
        choices.classList.add("col");
        const yes = el(`<button class="enc-opt"><span class="eo-n">Yes</span></button>`);
        yes.addEventListener("click", () => this.act({ t: "encounterChoice", choice: true }));
        const no = el(`<button class="secondary enc-opt"><span class="eo-n">No</span></button>`);
        no.addEventListener("click", () => this.act({ t: "encounterChoice", choice: false }));
        choices.append(yes, no);
      }
      cardEl.appendChild(choices);
    } else {
      // R9: spectators see the SAME choices the subject is weighing, rendered
      // read-only, plus a banner naming whose decision it is and (when known)
      // the option they're leaning toward. The buttons are disabled so a
      // spectator can't act, but the full menu is visible — no more blind wait.
      const sColor = COLOR_HEX[subject.color];
      cardEl.appendChild(
        el(`<div class="enc-watch" style="--accent:${sColor}">Watching ${escapeHtml(subject.name)} decide…</div>`),
      );
      const choices = el(`<div class="enc-choices spectate"></div>`);
      if (enc.awaiting === "giveResources") {
        const owed = enc.lossCount ?? 0;
        choices.appendChild(el(`<div class="enc-wait">Choosing ${owed} resource(s) to hand over…</div>`));
      } else if (enc.awaiting === "selectShip") {
        choices.appendChild(el(`<div class="enc-wait">Choosing which ship to immobilize…</div>`));
      } else if (enc.awaiting === "confirm") {
        choices.appendChild(el(`<button class="enc-opt" disabled><span class="eo-n">Continue</span></button>`));
      } else if (enc.awaiting === "number") {
        // Spectators see the OUTCOME of each offer (the "answer") — the chooser does not.
        choices.classList.add("col");
        for (const n of [0, 1, 2, 3]) {
          const hint = card?.choiceHints?.[n] ?? (n === 0 ? "Offer nothing" : `Offer ${n}`);
          choices.appendChild(
            el(`<button class="secondary enc-opt" disabled><span class="eo-n">${n}</span><span class="eo-hint">${escapeHtml(hint)}</span></button>`),
          );
        }
      } else {
        // Spectators see what each answer does; the chooser sees only Yes / No.
        choices.classList.add("col");
        choices.appendChild(el(`<button class="enc-opt" disabled><span class="eo-n">Yes</span>${card?.yesHint ? `<span class="eo-hint">${escapeHtml(card.yesHint)}</span>` : ""}</button>`));
        choices.appendChild(el(`<button class="secondary enc-opt" disabled><span class="eo-n">No</span>${card?.noHint ? `<span class="eo-hint">${escapeHtml(card.noHint)}</span>` : ""}</button>`));
      }
      cardEl.appendChild(choices);
    }

    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add("show"));
  }

  private removeEncounterOverlay(): void {
    document.querySelectorAll(".encounter-overlay").forEach((n) => n.remove());
  }

  /** Show the encounter outcome in the center, then fly gains to hand / sidebar. */
  private playEncounterResult(state: GameState, subjectId: string, mine: boolean): void {
    const subject = state.players.find((p) => p.id === subjectId);
    const snap = this.encSnapshot[subjectId];
    if (!subject || !snap) return;

    const fameDelta = subject.fameMedalPieces - snap.fame;
    const medalDelta = subject.victoryMedals - snap.medals;
    const resDeltas = RESOURCES.map((r) => ({ r, d: subject.hand[r] - snap.hand[r] }));
    const gained = resDeltas.filter((x) => x.d > 0);
    const lost = resDeltas.filter((x) => x.d < 0);

    // Prefer the card's own narration (the descriptive sentences it logged while
    // resolving) so the player reads WHAT happened — e.g. "You capture the pirate
    // ship — a free trade ship and 1 fame." — falling back to a neutral line.
    const narration = state.log
      .slice(this.encLogMark)
      .filter((l) => !/^Encounter:/.test(l) && !/ shakes: /.test(l))
      .slice(-2)
      .join("  ");
    const label = narration || "The encounter passes without incident.";

    // OUTCOME panel: verdict word + burst + sparks + delta chips. The tone is
    // judged from the net swing (medals weigh double).
    const swing =
      medalDelta * 2 +
      fameDelta +
      gained.reduce((s, x) => s + x.d, 0) +
      lost.reduce((s, x) => s + x.d, 0);
    const tone = swing > 0 ? "gain" : swing < 0 ? "loss" : "even";
    const verdict =
      tone === "gain"
        ? mine ? "FORTUNE!" : `${escapeHtml(subject.name.split(" ")[0] ?? "")} PROFITS`
        : tone === "loss"
          ? mine ? "SETBACK" : `${escapeHtml(subject.name.split(" ")[0] ?? "")} SUFFERS`
          : "RESOLVED";
    const chip = (cls: string, glyphHtml: string, text: string): string =>
      `<span class="er-chip ${cls}" style="animation-delay:${0.35 + chipCount++ * 0.09}s">${glyphHtml}${text}</span>`;
    let chipCount = 0;
    let chips = "";
    if (medalDelta > 0) chips += chip("gain", medalGlyphSvg(), `+${medalDelta} VP medal`);
    if (fameDelta > 0) chips += chip("gain", fameGlyphSvg(), `+${fameDelta} fame`);
    if (fameDelta < 0) chips += chip("loss", fameGlyphSvg(), `${fameDelta} fame`);
    for (const g of gained) chips += chip("gain", resourceGlyphSvg(g.r), `+${g.d} ${RESOURCE_LABEL[g.r]}`);
    for (const l of lost) chips += chip("loss", resourceGlyphSvg(l.r), `${l.d} ${RESOURCE_LABEL[l.r]}`);
    const sparks = Array.from({ length: 12 }, (_v, i) => {
      const a = (Math.PI * 2 * i) / 12 + 0.26;
      const d = 90 + (i % 3) * 38;
      return `<i class="er-spark" style="--dx:${(Math.cos(a) * d).toFixed(0)}px;--dy:${(Math.sin(a) * d).toFixed(0)}px;animation-delay:${(i % 4) * 0.04}s"></i>`;
    }).join("");
    const toast = el(`
      <div class="enc-result tone-${tone}">
        <div class="er-burst"></div>
        ${sparks}
        <div class="er-verdict">${verdict}</div>
        <div class="er-narr">${escapeHtml(label)}</div>
        ${chips ? `<div class="er-chips">${chips}</div>` : ""}
      </div>`);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    sfx.play(tone === "gain" ? "medal" : tone === "loss" ? "steal" : "trade");
    const center = { x: window.innerWidth / 2, y: window.innerHeight * 0.38 };

    // Mine: fame/medal → left sidebar, resources → hand cards.
    // Opponent: everything flies to their scoreboard row (item: show on every turn).
    let i = 0;
    const rowCenter = this.scoreRowCenter(subjectId);
    if (fameDelta > 0 || medalDelta > 0) {
      let to: { x: number; y: number } | null = null;
      if (mine) {
        const sideEl = this.root.querySelector(".sidebar-left .side-sec");
        if (sideEl) {
          const sb = sideEl.getBoundingClientRect();
          to = { x: sb.left + sb.width / 2, y: sb.top + 40 };
        }
      } else {
        to = rowCenter;
      }
      if (to) {
        const n = Math.max(1, fameDelta + medalDelta);
        for (let k = 0; k < Math.min(n, 3); k++) {
          this.flyToken(medalDelta > 0 ? medalGlyphSvg() : fameGlyphSvg(), "#ffd23f", center, to, 700 + i * 130, null);
          i++;
        }
      }
    }
    {
      const handRect = (r: Resource): { x: number; y: number } | null => {
        const card = this.root.querySelector(`.res-card[data-res="${r}"]`);
        if (!card) return null;
        const b = card.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      };
      for (const g of gained) {
        const to = mine ? handRect(g.r) : rowCenter;
        if (!to) continue;
        for (let k = 0; k < Math.min(g.d, 3); k++) {
          this.flyToken(resourceGlyphSvg(g.r), RES_COLOR[g.r], center, to, 700 + i * 130, null);
          i++;
        }
      }
    }

    // Untracked timers (see flyToken): a result toast must always clean itself up
    // even if a dice roll clears diceTimers in the meantime.
    window.setTimeout(() => toast.classList.remove("show"), 3400);
    window.setTimeout(() => toast.remove(), 3750);
  }

  private fillFriendshipChoice(actions: HTMLElement, civ: AlienCiv, options: string[]): void {
    actions.appendChild(
      el(`<div class="encounter friend-head"><span class="fh-av">${civAvatarSvg(civ)}</span><span><b>${CIV_LABEL[civ]} alliance</b><br>Choose an ability to add to your sidebar.</span></div>`),
    );
    const wrap = el(`<div class="friend-choices"></div>`);
    for (const id of options) {
      const card = friendshipCardById(id);
      const b = el(
        `<button class="friend-card" style="--c:${CIV_COLOR[civ]}">
           <span class="fc-name">${escapeHtml(card?.name ?? id)}</span>
           <span class="fc-text">${escapeHtml(card?.text ?? "")}</span>
         </button>`,
      );
      b.addEventListener("click", () => this.act({ t: "chooseFriendship", cardId: id }));
      wrap.appendChild(b);
    }
    actions.appendChild(wrap);
  }

  private fillSteal(actions: HTMLElement, state: GameState, me: PlayerState): void {
    actions.appendChild(el(`<div class="encounter">A 7! Steal 1 card from a player.</div>`));
    const row = el(`<div class="actions"></div>`);
    for (const p of state.players) {
      if (p.id === me.id) continue;
      const cards = RESOURCES.reduce((s, r) => s + p.hand[r], 0);
      const b = el(
        `<button ${cards > 0 ? "" : "disabled"} style="--c:${COLOR_HEX[p.color]}">${escapeHtml(p.name)} (${cards})</button>`,
      );
      if (cards > 0) b.addEventListener("click", () => this.act({ t: "stealTarget", targetId: p.id }));
      row.appendChild(b);
    }
    actions.appendChild(row);
  }

  private rerender(): void {
    this.render(this.game.getState());
  }

  /** Big center-screen dice animation: spin random faces, settle on a+b, fade out. */
  private playDiceRoll(a: number, b: number): void {
    this.diceTimers.forEach((t) => window.clearTimeout(t));
    this.diceTimers.forEach((t) => window.clearInterval(t));
    this.diceTimers = [];
    // Sweep any transient FX from a prior roll so nothing can linger on screen.
    document
      .querySelectorAll(".dice-overlay, .result-toast, .fly-token")
      .forEach((n) => n.remove());

    const overlay = el(
      `<div class="dice-overlay"><div class="dice-stage rolling">
         <div class="big-die">${dieFace(1)}</div>
         <div class="big-die">${dieFace(1)}</div>
       </div></div>`,
    );
    document.body.appendChild(overlay);
    const stage = overlay.querySelector(".dice-stage") as HTMLElement;
    const dice = overlay.querySelectorAll<HTMLElement>(".big-die");
    requestAnimationFrame(() => stage.classList.add("show"));

    const spin = window.setInterval(() => {
      dice[0]!.innerHTML = dieFace(1 + Math.floor(Math.random() * 6));
      dice[1]!.innerHTML = dieFace(1 + Math.floor(Math.random() * 6));
    }, 80);
    this.diceTimers.push(spin);

    this.diceTimers.push(
      window.setTimeout(() => {
        window.clearInterval(spin);
        stage.classList.remove("rolling");
        stage.classList.add("settle");
        dice[0]!.innerHTML = dieFace(a);
        dice[1]!.innerHTML = dieFace(b);
        stage.insertAdjacentHTML("beforeend", `<div class="dice-sum">${a + b}</div>`);
      }, 820),
    );
    this.diceTimers.push(
      window.setTimeout(() => stage.classList.remove("show"), 1700),
    );
    this.diceTimers.push(
      window.setTimeout(() => overlay.remove(), 2050),
    );
  }

  /** Fly produced resources from their board source to the hand; reserve cards from the VP marker. */
  /** Center of a player's scoreboard row (for opponent gain animations). */
  private scoreRowCenter(pid: string): { x: number; y: number } | null {
    const rowEl = this.root.querySelector(`.score-row[data-pid="${pid}"]`);
    if (!rowEl) return null;
    const b = rowEl.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  }

  private playResourceGains(state: GameState, me: PlayerState): void {
    const handRect = (r: Resource): { x: number; y: number } | null => {
      const card = this.root.querySelector(`.res-card[data-res="${r}"]`);
      if (!card) return null;
      const b = card.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const bloomCard = (r: Resource): void => {
      const card = this.root.querySelector(`.res-card[data-res="${r}"]`);
      if (!card) return;
      card.classList.remove("bloom-hit");
      void (card as HTMLElement).offsetWidth; // restart animation
      card.classList.add("bloom-hit");
    };

    // Position of my Green Folk friendship card for a given resource (P6h): the
    // extra bonus token flies from that card, not from the planet.
    const allyCardRect = (cardId: string): { x: number; y: number } | null => {
      const card = this.root.querySelector(`.ally-card[data-card-id="${cardId}"]`);
      if (!card) return null;
      const b = card.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const bloomAlly = (cardId: string): void => {
      const card = this.root.querySelector(`.ally-card[data-card-id="${cardId}"]`);
      if (!card) return;
      card.classList.remove("ally-pulse");
      void (card as HTMLElement).offsetWidth;
      card.classList.add("ally-pulse");
    };

    // Production gains animate for EVERY player: mine fly to my hand cards,
    // opponents' fly to their scoreboard row.
    let i = 0;
    const events = state.phaseState.lastProduction ?? [];
    for (const ev of events) {
      const from = this.board.screenPosOf(ev.intersectionId);
      if (!from) continue;
      const isMe = ev.owner === me.id;
      const to = isMe ? handRect(ev.resource) : this.scoreRowCenter(ev.owner);
      if (!to) continue;
      const bonus = isMe ? Math.min(ev.bonus ?? 0, ev.amount) : 0;
      const base = Math.min(ev.amount, 3) - Math.min(bonus, 3);
      // Base yield flies from the planet.
      for (let k = 0; k < base; k++) {
        const delay = i * 110;
        this.flyToken(
          resourceGlyphSvg(ev.resource),
          RES_COLOR[ev.resource],
          from,
          to,
          delay,
          isMe ? () => bloomCard(ev.resource) : null,
        );
        i++;
      }
      // P6h: Green Folk "Production Increase" bonus flies from the friendship card.
      const cardId = `greenFolk:${ev.resource}`;
      const cardFrom = bonus > 0 ? allyCardRect(cardId) : null;
      const bonusN = Math.min(bonus, 3);
      for (let k = 0; k < bonusN; k++) {
        const delay = i * 110;
        this.flyToken(
          resourceGlyphSvg(ev.resource),
          RES_COLOR[ev.resource],
          cardFrom ?? from, // fall back to the planet if the card isn't on screen
          to!,
          delay,
          () => { bloomCard(ev.resource); if (cardFrom) bloomAlly(cardId); },
        );
        i++;
      }
    }

  }

  /**
   * Mothership shake animation: flash random balls in quick succession (so the
   * randomness reads), then settle by enlarging & shining the two drawn balls.
   */
  private playShakeAnimation(): void {
    const container = this.root.querySelector(".balls");
    if (!container) return;
    const balls = Array.from(container.querySelectorAll(".ball")) as HTMLElement[];
    if (balls.length === 0) return;
    // Suppress the resting "drawn" emphasis while cycling.
    container.classList.add("shaking");
    const drawnEls = balls.filter((b) => b.classList.contains("drawn"));
    const STEP = 80;
    const CYCLE_MS = 880;
    let elapsed = 0;
    const tick = (): void => {
      balls.forEach((b) => b.classList.remove("flash"));
      // Light up two random balls each step to convey the random draw.
      const order = [...balls].sort(() => Math.random() - 0.5);
      order.slice(0, 2).forEach((b) => b.classList.add("flash"));
      elapsed += STEP;
      if (elapsed < CYCLE_MS) {
        this.diceTimers.push(window.setTimeout(tick, STEP));
      } else {
        balls.forEach((b) => b.classList.remove("flash"));
        container.classList.remove("shaking");
        drawnEls.forEach((b) => {
          b.classList.remove("settle");
          void b.offsetWidth; // restart animation
          b.classList.add("settle");
        });
      }
    };
    tick();
  }

  /**
   * Big center-screen shake, mirroring the dice roll: shows whose mothership is
   * shaking, cycles all 5 balls, then settles on the 2 drawn ones and reveals the
   * resulting speed & combat. Visible to ALL players so everyone sees the result.
   */
  private playShakeCenter(state: GameState): void {
    const ps = state.phaseState;
    if (!ps.shake) return;
    const active = state.players[ps.activePlayerIndex];
    if (!active) return;
    document.querySelectorAll(".shake-overlay").forEach((n) => n.remove());

    const drawn = [...ps.shake.balls];
    const ballHtml = MOTHERSHIP_BALLS.map((b) => {
      const idx = drawn.indexOf(b);
      const isDrawn = idx >= 0;
      if (isDrawn) drawn.splice(idx, 1);
      return `<div class="cs-ball ball b-${b} ${isDrawn ? "is-drawn" : ""}" data-val="${BALL_VALUE[b]}"></div>`;
    }).join("");

    const speed = ps.moveBudget ?? ps.shake.speed;
    const combat = ps.shake.combat;
    // R9: tint the shaker window in the active player's color so spectators can
    // tell at a glance whose mothership is shaking.
    const accent = COLOR_HEX[active.color] ?? "#ffd23f";
    const overlay = el(
      `<div class="shake-overlay">
         <div class="shake-stars"></div>
         <div class="shake-stage" style="--accent:${accent}">
           <div class="cs-title" style="color:${accent}">${escapeHtml(active.name)} shakes the mothership</div>
           <div class="cs-balls">${ballHtml}</div>
           <div class="cs-result" style="visibility:hidden">Speed <b>${speed}</b> · Combat <b>${combat}</b></div>
         </div>
       </div>`,
    );
    document.body.appendChild(overlay);
    // Racing light streaks BEHIND the shaker stage (the verbatim shader from
    // the owner's reference, lights only): screen-blended over the board, and
    // it stops itself when the overlay is removed.
    new ShakerStreaks(overlay.querySelector(".shake-stars") as HTMLElement);
    const stage = overlay.querySelector(".shake-stage") as HTMLElement;
    const ballEls = Array.from(overlay.querySelectorAll<HTMLElement>(".cs-ball"));
    const resultEl = overlay.querySelector(".cs-result") as HTMLElement;
    requestAnimationFrame(() => stage.classList.add("show"));

    // Cycle: flash two random balls repeatedly, then settle on the drawn pair.
    const STEP = 80;
    const CYCLE_MS = 900;
    let elapsed = 0;
    const tick = (): void => {
      ballEls.forEach((b) => b.classList.remove("flash"));
      [...ballEls].sort(() => Math.random() - 0.5).slice(0, 2).forEach((b) => b.classList.add("flash"));
      elapsed += STEP;
      if (elapsed < CYCLE_MS) {
        this.diceTimers.push(window.setTimeout(tick, STEP));
      } else {
        ballEls.forEach((b) => b.classList.remove("flash"));
        ballEls.filter((b) => b.classList.contains("is-drawn")).forEach((b) => b.classList.add("settle"));
        resultEl.style.visibility = "visible";
        resultEl.classList.add("cs-pop");
      }
    };
    this.diceTimers.push(window.setTimeout(tick, 30));
    this.diceTimers.push(window.setTimeout(() => stage.classList.remove("show"), 2200));
    this.diceTimers.push(window.setTimeout(() => overlay.remove(), 2550));
  }

  /**
   * Fly the broken pirate/ice token and its +1 VP medal from the planet to the
   * conquering player. For me they land on my mothership art; for an opponent
   * they fly to their scoreboard row.
   */
  private playClearedSpecial(
    me: PlayerState,
    lc: { playerId: string; kind: "pirateBase" | "icePlanet"; intersectionId: string },
  ): void {
    const from = this.board.screenPosOf(lc.intersectionId);
    if (!from) return;
    const mine = lc.playerId === me.id;
    let to: { x: number; y: number } | null;
    if (mine) {
      const art = this.root.querySelector(".ms-art");
      if (art) {
        const b = art.getBoundingClientRect();
        to = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      } else {
        to = this.scoreRowCenter(lc.playerId);
      }
    } else {
      to = this.scoreRowCenter(lc.playerId);
    }
    if (!to) return;
    const bloomArt = (): void => {
      const art = this.root.querySelector(".ms-art");
      if (!art) return;
      art.classList.remove("ms-conquer");
      void (art as HTMLElement).offsetWidth;
      art.classList.add("ms-conquer");
    };
    // First the captured token glyph, then the +1 VP medal chasing it in.
    const tokenGlyph = lc.kind === "pirateBase" ? pirateGlyphSvg() : iceGlyphSvg();
    const tokenColor = lc.kind === "pirateBase" ? "#ff6b6b" : "#7fd6ff";
    this.flyToken(tokenGlyph, tokenColor, from, to, 0, mine ? bloomArt : null);
    this.flyToken(medalGlyphSvg(), "#ffd23f", from, to, 260, mine ? bloomArt : null);
  }

  /**
   * Q4: a 7-steal — fly a face-down card from the victim's scoreboard row to the
   * thief's row (works whether the human is the thief, the victim, or neither).
   */
  private playSteal(fromId: string, toId: string): void {
    const from = this.scoreRowCenter(fromId);
    const to = this.scoreRowCenter(toId);
    if (!from || !to) return;
    const bloomThief = (): void => {
      const rowEl = this.root.querySelector(`.score-row[data-pid="${toId}"]`);
      if (!rowEl) return;
      rowEl.classList.remove("marker-gain");
      void (rowEl as HTMLElement).offsetWidth;
      rowEl.classList.add("marker-gain");
      window.setTimeout(() => rowEl.classList.remove("marker-gain"), 1200);
    };
    this.flyToken(cardGlyphSvg(), "#9fd0ff", from, to, 0, bloomThief);
    // R11: if the LOCAL player is the victim, also fly a card out of their own
    // hand (the bottom resource bar), not just the scoreboard row, so the theft
    // is visible right where their cards live.
    const humanId = this.game.humanId;
    if (fromId === humanId) {
      const handEl = this.root.querySelector(".hand");
      if (handEl) {
        const b = handEl.getBoundingClientRect();
        const handFrom = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        this.flyToken(cardGlyphSvg(), "#9fd0ff", handFrom, to, 80, null);
        handEl.classList.remove("hand-robbed");
        void (handEl as HTMLElement).offsetWidth;
        handEl.classList.add("hand-robbed");
        window.setTimeout(() => handEl.classList.remove("hand-robbed"), 700);
      }
    }
  }

  /**
   * R10: a player bought a mothership upgrade. Fly the upgrade icon down to their
   * scoreboard row (so every player sees it), bloom that row, and — if it's the
   * local player's upgrade — bloom the sidebar mothership art too.
   */
  private playUpgrade(playerId: string, kind: UpgradeKind): void {
    const to = this.scoreRowCenter(playerId);
    if (!to) return;
    const player = this.game.getState().players.find((p) => p.id === playerId);
    const color = player ? COLOR_HEX[player.color] : "#ffd23f";
    const from = { x: to.x, y: to.y - 90 };
    const bloomRow = (): void => {
      const rowEl = this.root.querySelector(`.score-row[data-pid="${playerId}"]`);
      if (!rowEl) return;
      rowEl.classList.remove("marker-gain");
      void (rowEl as HTMLElement).offsetWidth;
      rowEl.classList.add("marker-gain");
      window.setTimeout(() => rowEl.classList.remove("marker-gain"), 1200);
    };
    this.flyToken(upgradeIco(kind), color, from, to, 0, bloomRow);
    // Bloom the local mothership art when the buyer is the local player.
    if (playerId === this.game.humanId) {
      const art = this.root.querySelector(".ms-art");
      if (art) {
        art.classList.remove("ms-conquer");
        void (art as HTMLElement).offsetWidth;
        art.classList.add("ms-conquer");
        window.setTimeout(() => art.classList.remove("ms-conquer"), 900);
      }
    }
  }

  /**
   * R8: a completed player-to-player trade — fly a card EACH way between the two
   * players' scoreboard rows. If the local player is one of the two, the card on
   * their side flies to/from their hand bar so the swap reads clearly.
   */
  private playTrade(fromId: string, toId: string): void {
    const humanId = this.game.humanId;
    const handCenter = (): { x: number; y: number } | null => {
      const handEl = this.root.querySelector(".hand");
      if (!handEl) return null;
      const b = handEl.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const anchor = (pid: string): { x: number; y: number } | null =>
      pid === humanId ? handCenter() ?? this.scoreRowCenter(pid) : this.scoreRowCenter(pid);
    const a = anchor(fromId);
    const b = anchor(toId);
    if (!a || !b) return;
    const bloomRow = (pid: string): void => {
      const rowEl = this.root.querySelector(`.score-row[data-pid="${pid}"]`);
      if (!rowEl) return;
      rowEl.classList.remove("marker-gain");
      void (rowEl as HTMLElement).offsetWidth;
      rowEl.classList.add("marker-gain");
      window.setTimeout(() => rowEl.classList.remove("marker-gain"), 1000);
    };
    // One card each direction (the two halves of the swap).
    this.flyToken(cardGlyphSvg(), "#9fd0ff", a, b, 0, () => bloomRow(toId));
    this.flyToken(cardGlyphSvg(), "#9fe6b0", b, a, 120, () => bloomRow(fromId));
  }

  /**
   * #8: celebrate a newly-won outpost friendship marker (+2 VP). A glowing
   * "+2 VP" badge sweeps from the screen center to the player's scoreboard row,
   * which blooms as it lands.
   */
  private playMarkerGain(pid: string, civ: AlienCiv): void {
    const to = this.scoreRowCenter(pid);
    if (!to) return;
    const from = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const color = CIV_COLOR[civ] ?? "#ffd23f";
    const bloomRow = (): void => {
      const rowEl = this.root.querySelector(`.score-row[data-pid="${pid}"]`);
      if (!rowEl) return;
      rowEl.classList.remove("marker-gain");
      void (rowEl as HTMLElement).offsetWidth;
      rowEl.classList.add("marker-gain");
      window.setTimeout(() => rowEl.classList.remove("marker-gain"), 1400);
    };
    const badge = el(
      `<div class="marker-fly" style="--c:${color}">
         <span class="mf-civ">${CIV_LABEL[civ] ?? "Outpost"}</span>
         <span class="mf-vp">+2 VP</span>
       </div>`,
    );
    badge.style.left = `${from.x}px`;
    badge.style.top = `${from.y}px`;
    document.body.appendChild(badge);
    requestAnimationFrame(() => badge.classList.add("pop"));
    window.setTimeout(() => {
      badge.classList.remove("pop");
      badge.classList.add("fly");
      badge.style.left = `${to.x}px`;
      badge.style.top = `${to.y}px`;
    }, 700);
    window.setTimeout(() => {
      badge.remove();
      bloomRow();
    }, 700 + 760);
  }

  /** Animate the SPECIFIC reserve-pile cards a player drew flying into their hand. */
  private playReserveDraw(
    _state: GameState,
    me: PlayerState,
    draw: { playerId: string; gains: Partial<Record<Resource, number>> },
  ): void {
    const rowEl = this.root.querySelector(`.score-row[data-pid="${draw.playerId}"]`);
    if (!rowEl) return;
    const rb = rowEl.getBoundingClientRect();
    const from = { x: rb.left + rb.width / 2, y: rb.bottom };
    const mine = draw.playerId === me.id;
    const bloomCard = (r: Resource): void => {
      const card = this.root.querySelector(`.res-card[data-res="${r}"]`);
      if (!card) return;
      card.classList.remove("bloom-hit");
      void (card as HTMLElement).offsetWidth;
      card.classList.add("bloom-hit");
    };
    const handTo = (r: Resource): { x: number; y: number } | null => {
      const card = this.root.querySelector(`.res-card[data-res="${r}"]`);
      if (!card) return null;
      const b = card.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    };
    const rowCenter = { x: rb.left + rb.width / 2, y: rb.top + rb.height / 2 };
    let i = 0;
    for (const r of RESOURCES) {
      const n = draw.gains[r] ?? 0;
      for (let k = 0; k < n; k++) {
        const to = mine ? handTo(r) ?? rowCenter : rowCenter;
        this.flyToken(
          resourceGlyphSvg(r),
          RES_COLOR[r],
          from,
          to,
          i * 160,
          mine ? () => bloomCard(r) : null,
        );
        i++;
      }
    }
  }

  /** Animate a single glyph token blooming at `from` then gliding to `to`. */
  private flyToken(
    innerHtml: string,
    color: string,
    from: { x: number; y: number },
    to: { x: number; y: number },
    delay: number,
    onArrive: (() => void) | null,
  ): void {
    const tok = el(`<div class="fly-token" style="color:${color}">${innerHtml}</div>`);
    tok.style.left = `${from.x}px`;
    tok.style.top = `${from.y}px`;
    document.body.appendChild(tok);
    // NOTE: these timers are intentionally NOT tracked in diceTimers. A fly token
    // self-removes; if a new dice roll cleared diceTimers it would orphan the token
    // on screen forever (the old "stuck notification" bug). Self-managing is safe.
    window.setTimeout(() => requestAnimationFrame(() => tok.classList.add("bloom")), delay);
    window.setTimeout(() => {
      tok.classList.remove("bloom");
      tok.classList.add("fly");
      tok.style.left = `${to.x}px`;
      tok.style.top = `${to.y}px`;
    }, delay + 220);
    window.setTimeout(() => {
      tok.remove();
      onArrive?.();
    }, delay + 220 + 720);
  }
}

const PIP_MAP: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
};

function dieFace(n: number): string {
  const on = new Set(PIP_MAP[n] ?? []);
  let s = "";
  for (let i = 0; i < 9; i++) s += `<i class="${on.has(i) ? "on" : ""}"></i>`;
  return s;
}

/** BFS reachable destinations within `speed`; returns dest id -> path (steps). */
function reachable(state: GameState, start: string, speed: number): Map<string, string[]> {
  const prev = new Map<string, string>();
  const dist = new Map<string, number>([[start, 0]]);
  const queue: string[] = [start];
  while (queue.length) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    if (d >= speed) continue;
    for (const nb of state.intersections[cur]?.neighbors ?? []) {
      if (dist.has(nb)) continue;
      dist.set(nb, d + 1);
      prev.set(nb, cur);
      queue.push(nb);
    }
  }
  const occupied = (id: string): boolean =>
    state.buildings.some((b) => b.intersectionId === id) ||
    state.ships.some((s) => s.intersectionId === id);

  const out = new Map<string, string[]>();
  for (const [id] of dist) {
    if (id === start || occupied(id)) continue;
    const path: string[] = [];
    let node = id;
    while (node !== start) {
      path.unshift(node);
      node = prev.get(node)!;
    }
    out.set(id, path);
  }
  return out;
}

function freeDock(state: GameState, intersectionId: string): number {
  const outpostId = state.intersections[intersectionId]?.dockingPointOf;
  const used = new Set(state.tradeStations.filter((t) => t.outpostId === outpostId).map((t) => t.dock));
  for (let i = 0; i < 5; i++) if (!used.has(i)) return i;
  return 0;
}

/**
 * Original stylized vector avatar for an alien civilisation, used on the
 * friendship/outpost cards. Each civ has its own creature silhouette and
 * palette — these are drawn from scratch (no copied art): Scientists = tan
 * primate in a red cap, Green Folk = green frilled dragon, Diplomats = blue
 * crested lizard in armour, Merchants = tan long-eared trader.
 */
function civAvatarSvg(civ: string): string {
  const frame = (bg: string, inner: string): string =>
    `<svg viewBox="0 0 40 40" width="34" height="34" style="display:block">
      <circle cx="20" cy="20" r="19" fill="${bg}" stroke="#0a0f1e" stroke-width="1.5"/>
      ${inner}
    </svg>`;
  switch (civ) {
    case "scientists":
      return frame(
        "#1a2238",
        `<ellipse cx="20" cy="23" rx="11" ry="12" fill="#c9925e" stroke="#0a0f1e" stroke-width="1"/>
         <ellipse cx="20" cy="27" rx="6" ry="4.6" fill="#e3b98a"/>
         <circle cx="16" cy="21" r="1.7" fill="#0a0f1e"/><circle cx="24" cy="21" r="1.7" fill="#0a0f1e"/>
         <circle cx="19" cy="27" r="0.8" fill="#7a5532"/><circle cx="21" cy="27" r="0.8" fill="#7a5532"/>
         <path d="M9 17 Q20 1 31 17 Z" fill="#d23a33" stroke="#0a0f1e" stroke-width="1"/>
         <rect x="9" y="15.5" width="22" height="3" rx="1" fill="#f2f2f2" stroke="#0a0f1e" stroke-width="0.6"/>`,
      );
    case "greenFolk":
      return frame(
        "#11261a",
        `<path d="M10 15 L3 9 L12 14 Z" fill="#3f8f30" stroke="#0a0f1e" stroke-width="0.6"/>
         <path d="M30 15 L37 9 L28 14 Z" fill="#3f8f30" stroke="#0a0f1e" stroke-width="0.6"/>
         <ellipse cx="20" cy="21" rx="11" ry="12" fill="#4ca63a" stroke="#0a0f1e" stroke-width="1"/>
         <ellipse cx="20" cy="28" rx="5.6" ry="4" fill="#6fc456"/>
         <circle cx="15.5" cy="19" r="2.6" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.8"/><circle cx="15.5" cy="19" r="1" fill="#0a0f1e"/>
         <circle cx="24.5" cy="19" r="2.6" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.8"/><circle cx="24.5" cy="19" r="1" fill="#0a0f1e"/>
         <circle cx="18.4" cy="28" r="0.8" fill="#0a0f1e"/><circle cx="21.6" cy="28" r="0.8" fill="#0a0f1e"/>`,
      );
    case "diplomats":
      return frame(
        "#0e1c33",
        `<path d="M5 37 Q20 29 35 37 L35 40 L5 40 Z" fill="#cfd8e8" stroke="#0a0f1e" stroke-width="1"/>
         <ellipse cx="20" cy="19" rx="10.5" ry="11.5" fill="#4f7fd0" stroke="#0a0f1e" stroke-width="1"/>
         <path d="M20 8 Q24 4 21 1" stroke="#0a0f1e" stroke-width="1.2" fill="none"/>
         <ellipse cx="22" cy="24" rx="5" ry="3.4" fill="#6f9ce0"/>
         <circle cx="16" cy="17" r="2.1" fill="#fff" stroke="#0a0f1e" stroke-width="0.7"/><circle cx="16.4" cy="17" r="0.9" fill="#0a0f1e"/>
         <circle cx="24" cy="17" r="2.1" fill="#fff" stroke="#0a0f1e" stroke-width="0.7"/><circle cx="24.4" cy="17" r="0.9" fill="#0a0f1e"/>
         <circle cx="20" cy="30" r="1.4" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.6"/>`,
      );
    case "merchants":
      return frame(
        "#2a2114",
        `<polygon points="7,19 3,10 12,15" fill="#caa46a" stroke="#0a0f1e" stroke-width="0.7"/>
         <polygon points="33,19 37,10 28,15" fill="#caa46a" stroke="#0a0f1e" stroke-width="0.7"/>
         <ellipse cx="20" cy="21" rx="10" ry="12" fill="#d8b483" stroke="#0a0f1e" stroke-width="1"/>
         <path d="M20 20 L17.6 28 L22.4 28 Z" fill="#c49a63"/>
         <circle cx="15.5" cy="19" r="1.6" fill="#0a0f1e"/><circle cx="24.5" cy="19" r="1.6" fill="#0a0f1e"/>
         <path d="M16 31 Q20 33 24 31" stroke="#0a0f1e" stroke-width="1" fill="none"/>`,
      );
    default:
      return frame(
        "#1c2236",
        `<circle cx="20" cy="20" r="11" fill="#8fa4c4" stroke="#0a0f1e" stroke-width="1"/>
         <path d="M11 19 A9 9 0 0 1 29 19 L29 23 L11 23 Z" fill="#cfe0f5" stroke="#0a0f1e" stroke-width="0.7"/>
         <circle cx="20" cy="13" r="2" fill="#ffd23f" stroke="#0a0f1e" stroke-width="0.6"/>`,
      );
  }
}

/**
 * Full-colour inline SVG resource glyph mirroring the board art (24x24):
 * carbon = blue crystal cluster, fuel = gold cylinder, food = green
 * seed-creature, ore = red rock, goods = purple/gold chest.
 */
/**
 * Resource glyphs, fully redesigned (sci-fi set — old printed-card look kept
 * in git history if the owner wants to revert):
 *   ore    = a molten asteroid with glowing magma fissures
 *   fuel   = an energy cell: capsule with a window of glowing propellant
 *   carbon = a graphene molecule lattice (fused hexagons + bright nodes)
 *   food   = a hydroponic sprout under a glass dome
 *   goods  = a sealed cargo case with gold straps and a glowing seal
 */
function resourceGlyphSvg(r: Resource): string {
  const wrap = (inner: string): string =>
    `<svg viewBox="0 0 24 24" width="22" height="22" stroke-linejoin="round" stroke-linecap="round">${inner}</svg>`;
  switch (r) {
    case "carbon":
      return wrap(
        `<polygon points="12,4 15.1,5.8 15.1,9.4 12,11.2 8.9,9.4 8.9,5.8" fill="rgba(87,182,240,0.22)" stroke="#57b6f0" stroke-width="1.2"/>
         <polygon points="8.9,9.4 12,11.2 12,14.8 8.9,16.6 5.8,14.8 5.8,11.2" fill="rgba(47,127,214,0.18)" stroke="#3f97e4" stroke-width="1.2"/>
         <polygon points="15.1,9.4 18.2,11.2 18.2,14.8 15.1,16.6 12,14.8 12,11.2" fill="rgba(47,127,214,0.18)" stroke="#3f97e4" stroke-width="1.2"/>
         <circle cx="12" cy="11.2" r="1.5" fill="#dff4ff"/>
         <circle cx="8.9" cy="9.4" r="1.1" fill="#bfe9ff"/>
         <circle cx="15.1" cy="9.4" r="1.1" fill="#bfe9ff"/>
         <circle cx="12" cy="14.8" r="1.1" fill="#bfe9ff"/>
         <circle cx="12" cy="4" r="0.8" fill="#8fd2ff"/>
         <circle cx="5.8" cy="14.8" r="0.8" fill="#8fd2ff"/>
         <circle cx="18.2" cy="14.8" r="0.8" fill="#8fd2ff"/>`,
      );
    case "fuel":
      return wrap(
        `<rect x="10.9" y="2.2" width="2.2" height="1.8" fill="#a06c14" stroke="#0a0f1e" stroke-width="0.5"/>
         <rect x="9.2" y="3.8" width="5.6" height="2.6" rx="1" fill="#f6c659" stroke="#0a0f1e" stroke-width="0.7"/>
         <rect x="7.8" y="6.2" width="8.4" height="13.2" rx="2.6" fill="#b97e1f" stroke="#0a0f1e" stroke-width="0.8"/>
         <rect x="9.5" y="8" width="5" height="9.6" rx="1.8" fill="#241806" stroke="#0a0f1e" stroke-width="0.5"/>
         <rect x="9.5" y="11.8" width="5" height="5.8" rx="1.8" fill="#ffc34d"/>
         <circle cx="11" cy="13.6" r="0.6" fill="#ffe7ab"/>
         <circle cx="13" cy="15.6" r="0.5" fill="#ffe7ab"/>
         <path d="M12.7 8.7 L10.9 11.6 H12.2 L11.3 14 L13.8 10.7 H12.4 Z" fill="#ffe7ab"/>`,
      );
    case "food":
      return wrap(
        `<path d="M4.8 14 a7.2 7.2 0 0 1 14.4 0" fill="rgba(143,214,111,0.12)" stroke="#8fd66f" stroke-width="0.9" opacity="0.85"/>
         <path d="M12 16.2 C12 13.4 12 11 12 8.4" stroke="#3f8f30" stroke-width="1.6" fill="none"/>
         <path d="M12 12.4 C9.2 12 7.4 10 7.6 7.4 C10.4 7.8 11.9 9.8 12 12.4 Z" fill="#57c244" stroke="#0a0f1e" stroke-width="0.5"/>
         <path d="M12 10 C14.8 9.6 16.5 7.7 16.4 5.2 C13.6 5.6 12.1 7.5 12 10 Z" fill="#7ad862" stroke="#0a0f1e" stroke-width="0.5"/>
         <ellipse cx="12" cy="16.2" rx="5.2" ry="1.2" fill="#5a3d22" stroke="#0a0f1e" stroke-width="0.5"/>
         <path d="M6.8 16.4 H17.2 L16 20 A2.1 2.1 0 0 1 14 21.4 H10 A2.1 2.1 0 0 1 8 20 Z" fill="#2f7325" stroke="#0a0f1e" stroke-width="0.7"/>`,
      );
    case "ore":
      return wrap(
        `<polygon points="4,13 7,5.6 14,4 20.4,9.6 18.6,17.6 9,19.6" fill="#a32a28" stroke="#0a0f1e" stroke-width="0.8"/>
         <polygon points="7,5.6 14,4 12.6,9.2 8.2,10" fill="#d6504c" opacity="0.9"/>
         <polygon points="9,19.6 18.6,17.6 17.2,13.4 10.4,14.6" fill="#6e1a19" opacity="0.8"/>
         <path d="M6.6 12.6 L10.2 11.2 L12.6 13.6 L16.2 12 L18 14.2" stroke="#ffb054" stroke-width="1.3" fill="none"/>
         <path d="M10.2 11.2 L9.6 15.6" stroke="#ff7d3e" stroke-width="1" fill="none"/>
         <circle cx="16.2" cy="12" r="0.9" fill="#ffd28a"/>
         <circle cx="6.6" cy="12.6" r="0.7" fill="#ffd28a" opacity="0.8"/>`,
      );
    case "goods":
      return wrap(
        `<path d="M9.5 7 V5.6 A2.5 2.1 0 0 1 14.5 5.6 V7" stroke="#e3b341" stroke-width="1.5" fill="none"/>
         <rect x="4.4" y="7" width="15.2" height="11.6" rx="2" fill="#7b4fc4" stroke="#0a0f1e" stroke-width="0.8"/>
         <rect x="4.4" y="7" width="15.2" height="3.2" rx="2" fill="#9a73e0" opacity="0.85"/>
         <rect x="7.4" y="7" width="2" height="11.6" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.4"/>
         <rect x="14.6" y="7" width="2" height="11.6" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.4"/>
         <circle cx="12" cy="13" r="2.6" fill="rgba(255,217,106,0.25)"/>
         <polygon points="12,10.8 14,13 12,15.2 10,13" fill="#ffd96a" stroke="#0a0f1e" stroke-width="0.5"/>`,
      );
  }
}

/**
 * Brass / bronze riveted mothership in a 3-quarter view (modelled on the
 * official Starfarers rocket reference). Each upgrade type mounts in real
 * attachment slots on the hull: a slot fills with its accent colour when the
 * player owns that upgrade, and shows as a grayed-out empty socket otherwise —
 * so the loadout reads at a glance, with no confusing numbers on the rocket.
 */
function mothershipSvg(
  color: string,
  upgrades: { booster: number; cannon: number; freightPod: number } = {
    booster: 0,
    cannon: 0,
    freightPod: 0,
  },
): string {
  // Slot colours per the requested loadout: cannons = blue (on top), boosters =
  // orange (at the base near the legs), freight pods = red (on the side).
  const CANNON = "#6fb3ff";
  const CANNON_RIM = "#1d3a5c";
  const BOOST = "#ef8a2b";
  const BOOST_RIM = "#8a4a12";
  const FREIGHT = "#ff6b6b";
  const FREIGHT_RIM = "#7a2424";
  const EMPTY = "#2a3142"; // unfilled socket
  const EMPTY_RIM = "#475066";

  // A compact strip of slot pips next to an attachment: `n` of `max` lit.
  const pips = (
    cx: number,
    cy: number,
    max: number,
    n: number,
    hot: string,
    vertical: boolean,
  ): string => {
    const step = 6.2;
    const out: string[] = [];
    for (let i = 0; i < max; i++) {
      const on = i < n;
      const x = vertical ? cx : cx + (i - (max - 1) / 2) * step;
      const y = vertical ? cy + (i - (max - 1) / 2) * step : cy;
      out.push(
        `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.1" fill="${on ? hot : EMPTY}" stroke="${on ? "#05060f" : EMPTY_RIM}" stroke-width="0.7"/>`,
      );
    }
    return out.join("");
  };

  const boosterOn = upgrades.booster > 0;
  const cannonOn = upgrades.cannon > 0;
  const freightOn = upgrades.freightPod > 0;

  return `<svg viewBox="0 0 120 184" width="150" height="200" fill="none">
    <defs>
      <linearGradient id="msbody" x1="30%" y1="0%" x2="78%" y2="0%">
        <stop offset="0%" stop-color="#a06a2c"/>
        <stop offset="42%" stop-color="#d9a85a"/>
        <stop offset="100%" stop-color="#7a5021"/>
      </linearGradient>
      <linearGradient id="msnose" x1="35%" y1="0%" x2="80%" y2="0%">
        <stop offset="0%" stop-color="#b07d38"/>
        <stop offset="45%" stop-color="#e6bd72"/>
        <stop offset="100%" stop-color="#83571f"/>
      </linearGradient>
      <radialGradient id="msowner" cx="50%" cy="50%" r="60%">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.95"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.3"/>
      </radialGradient>
    </defs>

    <!-- tripod landing legs -->
    <g stroke="#5e3d18" stroke-width="2.2" fill="#9a6a30">
      <path d="M46 118 C30 128 24 142 26 158" fill="none" stroke-width="6" stroke-linecap="round"/>
      <ellipse cx="25" cy="160" rx="6" ry="4" />
      <path d="M74 118 C90 128 96 142 94 158" fill="none" stroke-width="6" stroke-linecap="round"/>
      <ellipse cx="95" cy="160" rx="6" ry="4" />
    </g>

    <!-- exhaust bell at the base -->
    <path d="M52 150 L68 150 L72 170 L48 170 Z" fill="#6f4a20" stroke="#4a3010" stroke-width="1.6"/>
    <ellipse cx="60" cy="170" rx="13" ry="5" fill="#3a2810" stroke="#4a3010" stroke-width="1.4"/>

    <!-- main hull body -->
    <path d="M42 56 L78 56 L76 120 L44 120 Z" fill="url(#msbody)" stroke="#4a3010" stroke-width="1.8"/>
    <!-- ribbed engine bands near the base -->
    <g stroke="#5e3d18" stroke-width="1.4">
      <line x1="44.6" y1="104" x2="75.4" y2="104"/>
      <line x1="45"   y1="109" x2="75"   y2="109"/>
      <line x1="45.3" y1="114" x2="74.7" y2="114"/>
    </g>

    <!-- nose cone with vertical vent -->
    <path d="M60 6 C44 20 38 38 42 58 L78 58 C82 38 76 20 60 6 Z" fill="url(#msnose)" stroke="#4a3010" stroke-width="1.8"/>
    <rect x="55" y="14" width="10" height="30" rx="5" fill="#3a2810" stroke="#5e3d18" stroke-width="1.2"/>
    <!-- owner-colour cockpit glow on the shoulder -->
    <circle cx="60" cy="64" r="6.5" fill="url(#msowner)" stroke="${color}" stroke-width="1.6"/>

    <!-- rivet lines down the body -->
    <g fill="#5e3d18">
      ${[68, 78, 88, 98].map((y) => `<circle cx="48" cy="${y}" r="1.2"/><circle cx="60" cy="${y}" r="1.2"/><circle cx="72" cy="${y}" r="1.2"/>`).join("")}
    </g>

    <!-- CANNON slot (blue): ribbed fin up top, alongside the nose cone. -->
    <g>
      <path d="M40 24 C29 30 26 44 32 58 L42 54 L44 26 Z"
            fill="${cannonOn ? CANNON : EMPTY}" stroke="${cannonOn ? CANNON_RIM : EMPTY_RIM}" stroke-width="1.4"
            ${cannonOn ? "" : 'stroke-dasharray="3 2.5"'}/>
      ${cannonOn ? `<g stroke="${CANNON_RIM}" stroke-width="1" opacity="0.7"><line x1="31" y1="34" x2="42" y2="31"/><line x1="30" y1="42" x2="42" y2="40"/><line x1="31" y1="50" x2="42" y2="49"/></g>` : ""}
    </g>
    ${pips(20, 42, MAX_UPGRADES.cannon, upgrades.cannon, CANNON, true)}

    <!-- FREIGHT slot (red): teardrop pod on the side of the hull. -->
    <g>
      <path d="M40 82 C30 84 28 96 36 104 C44 100 44 86 40 82 Z"
            fill="${freightOn ? FREIGHT : EMPTY}" stroke="${freightOn ? FREIGHT_RIM : EMPTY_RIM}" stroke-width="1.4"
            ${freightOn ? "" : 'stroke-dasharray="3 2.5"'}/>
    </g>
    ${pips(96, 86, MAX_UPGRADES.freightPod, upgrades.freightPod, FREIGHT, true)}

    <!-- BOOSTER slot (orange): nozzle pod at the base between the legs. -->
    <g>
      <ellipse cx="60" cy="142" rx="11" ry="7"
               fill="${boosterOn ? BOOST : EMPTY}" stroke="${boosterOn ? BOOST_RIM : EMPTY_RIM}" stroke-width="1.4"
               ${boosterOn ? "" : 'stroke-dasharray="3 2.5"'}/>
      ${boosterOn ? `<g stroke="${BOOST_RIM}" stroke-width="1" opacity="0.6"><line x1="52" y1="142" x2="68" y2="142"/></g>` : ""}
    </g>
    ${pips(60, 156, MAX_UPGRADES.booster, upgrades.booster, BOOST, false)}
  </svg>`;
}

function upgradeIco(kind: "booster" | "cannon" | "freightPod"): string {
  const w = (inner: string): string =>
    `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round">${inner}</svg>`;
  switch (kind) {
    case "booster":
      return w(`<path d="M12 3 C15 8 16 13 12 21 C8 13 9 8 12 3 Z" fill="currentColor"/><path d="M8 19 L6 22 M16 19 L18 22"/>`);
    case "cannon":
      return w(`<rect x="4" y="9" width="13" height="6" rx="1.5" fill="currentColor"/><path d="M17 12 L21 12"/><circle cx="6" cy="12" r="2.4" fill="#0a0f1e"/>`);
    case "freightPod":
      return w(`<rect x="5" y="7" width="14" height="11" rx="1.5" fill="currentColor"/><path d="M5 11 H19 M12 7 V18"/>`);
  }
}

function fameGlyphSvg(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" stroke="none"><path d="M12 2 L14.6 8.6 L21.5 9 L16.2 13.4 L18 20.2 L12 16.4 L6 20.2 L7.8 13.4 L2.5 9 L9.4 8.6 Z"/></svg>`;
}

function medalGlyphSvg(): string {
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="14" r="6.5" fill="currentColor"/><circle cx="12" cy="14" r="3" fill="#0a0f1e" stroke="none"/><path d="M8 3 L10.5 8 M16 3 L13.5 8" stroke-width="2"/></svg>`;
}

function pirateGlyphSvg(): string {
  // A skull — the captured pirate base.
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor" stroke="none"><path d="M12 2 C7 2 4 5.5 4 10 C4 12.6 5.3 14.6 7 15.8 L7 18 C7 19.1 7.9 20 9 20 L15 20 C16.1 20 17 19.1 17 18 L17 15.8 C18.7 14.6 20 12.6 20 10 C20 5.5 17 2 12 2 Z M9 9 A1.6 1.6 0 1 0 9 12.2 A1.6 1.6 0 0 0 9 9 Z M15 9 A1.6 1.6 0 1 0 15 12.2 A1.6 1.6 0 0 0 15 9 Z" fill-rule="evenodd"/></svg>`;
}

function iceGlyphSvg(): string {
  // A snowflake — the terraformed ice planet.
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M12 2 V22 M3.3 7 L20.7 17 M20.7 7 L3.3 17"/><path d="M12 5 L10 3 M12 5 L14 3 M12 19 L10 21 M12 19 L14 21"/></svg>`;
}

function cardGlyphSvg(): string {
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="3" width="14" height="18" rx="2" fill="currentColor" opacity="0.85"/><rect x="2.5" y="6" width="14" height="18" rx="2" fill="#0a0f1e" stroke="currentColor"/></svg>`;
}

function markerGlyphSvg(): string {
  // Two interlocking rings — a friendship/alliance marker.
  return `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/></svg>`;
}

// Shared ink colour for the piece-icon outlines (matches the board's dark navy).
const PIECE_INK = "#0a0f1e";

/** Y6: commander avatar — an original space-suit portrait tinted with the
 *  player's color (helmet shell + reflective visor + collar), used in the
 *  scoreboard, win screen and turn contexts instead of plain color dots. */
function avatarSvg(color: PlayerColor): string {
  const c = COLOR_HEX[color];
  return `<svg viewBox="0 0 24 24" width="22" height="22" fill="none">
    <circle cx="12" cy="12" r="11" fill="color-mix(in srgb, ${c} 22%, #0a0f1e)" stroke="${c}" stroke-width="1.3"/>
    <path d="M5.5 12.2 a6.5 6.8 0 0 1 13 0 v2.2 a2 2 0 0 1 -2 2 h-9 a2 2 0 0 1 -2 -2 Z" fill="${c}" stroke="${PIECE_INK}" stroke-width="0.7"/>
    <path d="M7.4 12 a4.6 4.8 0 0 1 9.2 0 v1.4 a1.4 1.4 0 0 1 -1.4 1.4 h-6.4 a1.4 1.4 0 0 1 -1.4 -1.4 Z" fill="#101728"/>
    <path d="M8.4 11.2 a3.4 3 0 0 1 4.4 -2.4" stroke="#bfe0ff" stroke-width="1" stroke-linecap="round" opacity="0.8"/>
    <path d="M7 17.4 q5 2.6 10 0 l0.6 2.2 q-5.6 2.8 -11.2 0 Z" fill="color-mix(in srgb, ${c} 70%, #fff)" stroke="${PIECE_INK}" stroke-width="0.6"/>
  </svg>`;
}

/**
 * Y4 redesigned piece icons — each piece gets its OWN silhouette so they
 * read at a glance even at 20px:
 *   colony ship  = a VERTICAL rocket carrying a green habitat dome
 *   trade ship   = a HORIZONTAL freighter stacked with gold cargo crates
 *   (plain ship) = a small neutral shuttle
 *   colony       = a big glass dome habitat on a pad
 *   spaceport    = a tall control tower with a landing ring + beacon
 */
function shipIco(kind?: "colonyShip" | "tradeShip"): string {
  if (kind === "colonyShip") {
    // Upright settler rocket: habitat dome nose (green), body, legs, flame.
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
      <path d="M7.6 10.4 a4.4 4.4 0 0 1 8.8 0 Z" fill="#57e389" stroke="${PIECE_INK}" stroke-width="0.7"/>
      <path d="M9.2 9.6 a2.8 2.6 0 0 1 5.4 0" fill="none" stroke="${PIECE_INK}" stroke-width="0.6" opacity="0.5"/>
      <rect x="7.6" y="10.4" width="8.8" height="7.2" rx="1.4" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.7"/>
      <circle cx="12" cy="13.6" r="1.5" fill="${PIECE_INK}" opacity="0.45"/>
      <polygon points="7.6,14.4 4.6,19 7.6,17.6" fill="currentColor" fill-opacity="0.8" stroke="${PIECE_INK}" stroke-width="0.5"/>
      <polygon points="16.4,14.4 19.4,19 16.4,17.6" fill="currentColor" fill-opacity="0.8" stroke="${PIECE_INK}" stroke-width="0.5"/>
      <path d="M10 17.6 L12 21.6 L14 17.6 Z" fill="#ffd23f" stroke="${PIECE_INK}" stroke-width="0.5"/>
    </svg>`;
  }
  if (kind === "tradeShip") {
    // Horizontal cargo freighter: long hull, gold crates on deck, engine glow.
    return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
      <rect x="5.2" y="6.4" width="3.2" height="3.2" rx="0.6" fill="#ffd23f" stroke="${PIECE_INK}" stroke-width="0.6"/>
      <rect x="9" y="6.4" width="3.2" height="3.2" rx="0.6" fill="#ffb13f" stroke="${PIECE_INK}" stroke-width="0.6"/>
      <rect x="12.8" y="6.4" width="3.2" height="3.2" rx="0.6" fill="#ffd23f" stroke="${PIECE_INK}" stroke-width="0.6"/>
      <path d="M3.5 10 H17.5 L21.5 12.6 L17.5 16.4 H3.5 Q2 13.2 3.5 10 Z" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.7"/>
      <circle cx="18" cy="12.9" r="1.2" fill="${PIECE_INK}" opacity="0.45"/>
      <rect x="1" y="11.4" width="2.4" height="3" rx="0.8" fill="#6fd0ff" stroke="${PIECE_INK}" stroke-width="0.5"/>
      <path d="M4 18 H16" stroke="${PIECE_INK}" stroke-width="0.6" opacity="0.35"/>
    </svg>`;
  }
  // Generic transport shuttle (supply count): small angled wedge ship.
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
    <path d="M3 13 L17 8.4 L21 12 L17 15.6 Z" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.7"/>
    <circle cx="16.6" cy="12" r="1.1" fill="${PIECE_INK}" opacity="0.45"/>
    <path d="M6 10.6 L3.4 7.8 M6 15.4 L3.4 18.2" stroke="currentColor" stroke-width="1.4"/>
  </svg>`;
}

/** Colony: a wide glass dome habitat (teal glow) with an airlock tunnel. */
function colonyIco(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
    <ellipse cx="12" cy="18.6" rx="9.4" ry="2.4" fill="currentColor" fill-opacity="0.55" stroke="${PIECE_INK}" stroke-width="0.5"/>
    <path d="M4.4 18.4 a7.6 7.4 0 0 1 15.2 0 Z" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.8"/>
    <path d="M6.4 18.2 a5.6 5.6 0 0 1 11.2 0" fill="none" stroke="#9fe8ff" stroke-width="1" opacity="0.85"/>
    <path d="M8.6 18 a3.4 3.6 0 0 1 6.8 0" fill="none" stroke="#9fe8ff" stroke-width="0.7" opacity="0.55"/>
    <rect x="10.6" y="13.4" width="2.8" height="5" rx="0.7" fill="${PIECE_INK}" opacity="0.4"/>
    <rect x="18.6" y="16.2" width="3.6" height="2.4" rx="1.2" fill="currentColor" fill-opacity="0.85" stroke="${PIECE_INK}" stroke-width="0.5"/>
  </svg>`;
}

/** Spaceport: a tall control tower piercing a landing ring, beacon on top. */
function spaceportIco(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
    <ellipse cx="12" cy="19.4" rx="8.6" ry="2" fill="currentColor" fill-opacity="0.55" stroke="${PIECE_INK}" stroke-width="0.5"/>
    <path d="M10.2 19.4 L11 7.4 H13 L13.8 19.4 Z" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.7"/>
    <ellipse cx="12" cy="10.6" rx="8" ry="2.6" fill="none" stroke="#6fd0ff" stroke-width="1.2"/>
    <ellipse cx="12" cy="10.6" rx="8" ry="2.6" fill="none" stroke="${PIECE_INK}" stroke-width="0.4" opacity="0.4"/>
    <rect x="9.4" y="5" width="5.2" height="3" rx="1.5" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.7"/>
    <circle cx="12" cy="3.4" r="1.3" fill="#ffd23f" stroke="${PIECE_INK}" stroke-width="0.5"/>
    <path d="M12 4.7 V5" stroke="${PIECE_INK}" stroke-width="0.6"/>
  </svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

/** Seconds → "m:ss" for the turn-timer chip. */
function fmtClock(secs: number): string {
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
