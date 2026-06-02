import {
  BALL_VALUE,
  BUILD_COSTS,
  MAX_UPGRADES,
  ENCOUNTER_CARDS,
  MOTHERSHIP_BALLS,
  RESOURCES,
  RESOURCE_LABEL,
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
  | "setupColony"
  | "setupUpgrade"
  | "launchShip"
  | "setupShip";

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
  /** Whether the Building Costs / VP reference card is expanded. */
  private showRef = false;
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
  /** Encounter currently shown in the center overlay (cardId + subject + step). */
  private shownEncounter: { cardId: number; subjectId: string; awaiting: string } | null = null;
  /** How many players had confirmed an all-player card when the overlay last rebuilt. */
  private shownConfirmCount = -1;
  /** Snapshot of each player's fame/medals/hand taken when an encounter opens. */
  private encSnapshot: Record<string, { fame: number; medals: number; hand: ResourceBag }> = {};
  /** Whether the center-screen game-over results overlay is already shown. */
  private gameOverShown = false;
  /** R1/R2: collapse toggles for the side panels on small screens. */
  private sidebarCollapsed = true;
  private scoreCompact = true;

  constructor(mount: HTMLElement, game: GameDriver, board: BoardRenderer) {
    this.root = mount;
    this.game = game;
    this.board = board;
    this.unsubscribe = game.subscribe((s) => this.render(s));
    // Q6: Space triggers the contextual primary action (roll / end / shake).
    this.keyHandler = (e) => this.onKeyDown(e);
    window.addEventListener("keydown", this.keyHandler);
    // Q5: floating build-cost popover (resource icons + what's missing).
    this.costPop = document.createElement("div");
    this.costPop.className = "build-cost-pop";
    document.body.appendChild(this.costPop);
  }

  /** Cleanly tear the HUD down (R18: returning to the lobby for a rematch). Drops
   *  all subscriptions, window listeners, pending timers, and body-level overlays
   *  so a freshly-mounted HUD starts from a clean slate. */
  destroy(): void {
    this.unsubscribe?.();
    if (this.keyHandler) window.removeEventListener("keydown", this.keyHandler);
    this.diceTimers.forEach((t) => window.clearTimeout(t));
    this.diceTimers = [];
    this.costPop?.remove();
    this.root.replaceChildren();
    document
      .querySelectorAll(
        ".gameover-overlay, .encounter-overlay, .shake-overlay, .dice-overlay, .result-toast, .fly-token, .marker-fly, .exit-confirm",
      )
      .forEach((n) => n.remove());
  }

  private unsubscribe: (() => void) | null = null;
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;

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
      const cells = RESOURCES.filter((r) => (cost[r] ?? 0) > 0)
        .map((r) => {
          const need = cost[r] ?? 0;
          const have = me.hand[r];
          const ok = have >= need;
          return `<span class="bc-cell ${ok ? "ok" : "miss"}" style="--res:${RES_COLOR[r]}">
                    <span class="bc-glyph">${resourceGlyphSvg(r)}</span>
                    <span class="bc-num">${Math.min(have, need)}/${need}</span>
                  </span>`;
        })
        .join("");
      const ready = RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));
      const head = ready
        ? `<div class="bc-head ready">✓ All resources ready</div>`
        : `<div class="bc-head short">Missing resources (red)</div>`;
      return `${head}<div class="bc-cells">${cells}</div>${extra ? `<div class="bc-extra">${escapeHtml(extra)}</div>` : ""}`;
    };
    const show = (e: PointerEvent): void => {
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
    // Now in flight (unless the phase change errored): shake right away.
    const after = this.game.getState().phaseState;
    if (after.phase === "flight" && !after.shake && !after.encounter) {
      this.act({ t: "shakeMothership" });
    }
  }

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
   * R6: confirm before bailing out to the main menu. Shows a center modal with
   * Exit / Stay; Exit reloads the page (which returns to the landing screen, the
   * same path the game-over "New game" button uses).
   */
  private confirmExit(): void {
    document.querySelectorAll(".exit-confirm").forEach((n) => n.remove());
    const modal = el(`
      <div class="exit-confirm">
        <div class="exit-box">
          <div class="exit-title">Leave the game?</div>
          <div class="exit-msg">You'll return to the main menu and this game will be lost.</div>
          <div class="exit-actions">
            <button class="exit-yes">Exit to menu</button>
            <button class="secondary exit-no">Keep playing</button>
          </div>
        </div>
      </div>`);
    modal.querySelector(".exit-yes")!.addEventListener("click", () => location.reload());
    const close = (): void => modal.remove();
    modal.querySelector(".exit-no")!.addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add("show"));
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
    this.board.clearHighlights();
    this.board.onIntersectionClick = null;
    this.board.onShipClick = null;
  }

  private render(state: GameState): void {
    const ps = state.phaseState;
    const active = state.players[ps.activePlayerIndex]!;

    // Trigger the center-screen dice animation once per new roll.
    const rc = ps.rollCount ?? 0;
    if (rc > this.lastAnimatedRoll && ps.lastRoll) {
      this.lastAnimatedRoll = rc;
      this.playDiceRoll(ps.lastRoll[0], ps.lastRoll[1]);
    }
    const me0 = state.players.find((p) => p.id === this.game.humanId)!;
    if (rc > this.lastAnimatedGains) {
      this.lastAnimatedGains = rc;
      this.diceTimers.push(
        window.setTimeout(() => this.playResourceGains(state, me0), 950),
      );
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
      this.diceTimers.push(window.setTimeout(() => this.playShakeAnimation(), 30));
      // Big center-screen shake, visible to everyone (mirrors the dice roll).
      this.playShakeCenter(state);
    }
    // A pirate base / ice planet just broke: fly the token + VP medal to the
    // conquering player's mothership (mine) or scoreboard row (opponent).
    const lc = ps.lastClearedSpecial;
    if (lc && lc.seq > this.lastAnimatedClear) {
      this.lastAnimatedClear = lc.seq;
      this.diceTimers.push(window.setTimeout(() => this.playClearedSpecial(me0, lc), 200));
    }
    // Q4: a 7-steal just happened — fly a card from the victim's row to the thief's.
    const stl = ps.lastSteal;
    if (stl && stl.seq > this.lastAnimatedSteal) {
      this.lastAnimatedSteal = stl.seq;
      this.diceTimers.push(window.setTimeout(() => this.playSteal(stl.fromId, stl.toId), 200));
    }
    // R8: a player-to-player trade just completed — fly a card each way between the
    // two players' rows (and the local player's hand, if they're involved).
    const tr = ps.lastTrade;
    if (tr && tr.seq > this.lastAnimatedTrade) {
      this.lastAnimatedTrade = tr.seq;
      this.diceTimers.push(window.setTimeout(() => this.playTrade(tr.fromId, tr.toId), 150));
    }
    // R10: any player bought a mothership upgrade — bloom the upgrade on their
    // scoreboard row (visible to all) and on the local mothership art if it's theirs.
    const up = ps.lastUpgrade;
    if (up && up.seq > this.lastAnimatedUpgrade) {
      this.lastAnimatedUpgrade = up.seq;
      this.diceTimers.push(window.setTimeout(() => this.playUpgrade(up.playerId, up.kind), 120));
    }
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
    const scoreboard = el(`<div class="hud-panel scoreboard ${this.scoreCompact ? "compact" : ""}"></div>`);
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
      const row = el(`
        <div class="score-row ${isActive ? "active" : ""}" data-pid="${p.id}">
          <div class="score-main">
            <span class="dot ${p.color}"></span>
            <span class="pname">${escapeHtml(p.name)}</span>
            ${bonusBadge}
            <span class="vp" style="color:${COLOR_HEX[p.color]}">${p.victoryPoints}<span class="vp-target">/${target}</span></span>
          </div>
          ${meta}
          ${upgRow}
        </div>`);
      scoreRows.appendChild(row);
    }
    scoreboard.appendChild(scoreRows);

    // M2: the activity log is now a section inside the Fleet sidebar (see
    // buildSidebar) rather than a separate floating panel.
    const bar = el(`<div class="hud-panel actionbar"></div>`);

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
      const MAX_EDGES = 7;
      const edges = Math.min(Math.max(n - 1, 0), MAX_EDGES);
      const gutter = edges * 6;
      const edgeHtml = Array.from(
        { length: edges },
        (_v, i) => `<span class="res-edge" style="left:-${(edges - i) * 6}px"></span>`,
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

    const banner = el(`
      <div class="turn-banner">
        <span class="phase" style="color:${COLOR_HEX[active.color]}">${escapeHtml(active.name)}</span>
        <span class="phase-name">${PHASE_LABEL[ps.phase]}</span>
      </div>`);
    bar.appendChild(banner);

    const actions = el(`<div class="actions"></div>`);
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
    bar.appendChild(el(`<div class="hud-error"></div>`));

    // R6: top-left Exit button → confirm before leaving to the main menu.
    const exitBtn = el(`<button class="exit-menu" title="Exit to main menu">✕</button>`);
    exitBtn.addEventListener("click", () => this.confirmExit());
    screen.appendChild(exitBtn);

    screen.appendChild(this.buildSidebar(state, me));
    screen.appendChild(scoreboard);
    screen.appendChild(bar);
    this.root.replaceChildren(screen);

    this.syncEncounterOverlay(state, me);
    this.syncGameOverOverlay(state);
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

    const winner = state.players.find((p) => p.id === ps.winner);
    const ranked = [...state.players].sort((a, b) => b.victoryPoints - a.victoryPoints);
    const rows = ranked
      .map((p, i) => {
        const colonies = state.buildings.filter((b) => b.owner === p.id && b.kind === "colony").length;
        const ports = state.buildings.filter((b) => b.owner === p.id && b.kind === "spaceport").length;
        const stations = state.tradeStations.filter((t) => t.owner === p.id).length;
        const isWin = p.id === ps.winner;
        return `
          <div class="go-row ${isWin ? "win" : ""}">
            <span class="go-rank">${i + 1}</span>
            <span class="dot ${p.color}"></span>
            <span class="go-name">${escapeHtml(p.name)}</span>
            <span class="go-detail">${colonies}🪐 · ${ports}🛰 · ${stations}🤝 · ${p.friendshipMarkers.length}★</span>
            <span class="go-vp" style="color:${COLOR_HEX[p.color]}">${p.victoryPoints}</span>
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

  /** Left sidebar: mothership illustration + upgrade counts, shaker balls, trade. */
  private buildSidebar(state: GameState, me: PlayerState): HTMLElement {
    const ps = state.phaseState;
    const side = el(`<div class="hud-panel sidebar-left ${this.sidebarCollapsed ? "collapsed" : ""}"></div>`);

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
    stats.appendChild(stat(upgradeIco("booster"), "Boosters", me.upgrades.booster, "#6fb3ff"));
    stats.appendChild(stat(upgradeIco("cannon"), "Cannons", me.upgrades.cannon, "#ff6b6b"));
    stats.appendChild(stat(upgradeIco("freightPod"), "Freight pods", me.upgrades.freightPod, "#57e389"));
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
      sh.appendChild(
        el(`<div class="shake-result">Speed <b>${speed}</b> · Combat <b>${ps.shake.combat}</b></div>`),
      );
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

    // --- Reference card (build costs + VP), collapsible ---
    side.appendChild(this.buildReferencePanel());

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

  /** Collapsible reference: what each build costs and what every VP source is worth. */
  private buildReferencePanel(): HTMLElement {
    const sec = el(`<div class="side-sec side-ref"></div>`);
    const head = el(
      `<button class="ref-toggle" aria-expanded="${this.showRef}">
         <span>${this.showRef ? "▾" : "▸"} Costs &amp; victory points</span>
       </button>`,
    );
    head.addEventListener("click", () => { this.showRef = !this.showRef; this.rerender(); });
    sec.appendChild(head);
    if (!this.showRef) return sec;

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

    sec.appendChild(body);
    return sec;
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
          if (sites.includes(id)) this.act({ t: "setupPlaceColony", intersectionId: id });
        };
        return;
      }
      if (su.round === 4 && su.r4step === "upgrade") {
        const colonies = state.buildings
          .filter((b) => b.owner === me.id && b.kind === "colony")
          .map((b) => b.intersectionId);
        this.board.setHighlights(colonies);
        this.board.onIntersectionClick = (id) => {
          if (colonies.includes(id)) this.act({ t: "setupUpgrade", intersectionId: id });
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
            this.act({ t: "setupPlaceShip", shipKind: kind, intersectionId: id });
            this.resetSelection();
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
      const canShip =
        me.supply.transportShips > 0 &&
        sites.length > 0 &&
        (canAfford(BUILD_COSTS.colonyShip) || canAfford(BUILD_COSTS.tradeShip));
      if (canShip) {
        this.board.setHighlights(sites);
        this.board.onIntersectionClick = (id) => {
          if (sites.includes(id)) {
            this.launchPickSite = id;
            this.rerender();
          }
        };
        return;
      }
      this.board.clearHighlights();
      return;
    }

    if (state.phaseState.phase === "flight" && state.phaseState.shake) {
      this.board.onShipClick = (id) => this.selectShip(state, me, id);
      if (this.mode === "moveShip" && this.selectedShipId) {
        this.board.setSelectedShip(this.selectedShipId);
        this.board.setHighlights([...this.moveTargets.keys()]);
        this.board.onIntersectionClick = (id) => {
          const path = this.moveTargets.get(id);
          if (path) {
            const sid = this.selectedShipId!;
            // Clear the selection BEFORE dispatching so the re-render the
            // dispatch triggers re-wires the board for plain ship selection —
            // letting the player immediately pick and move ANOTHER ship.
            this.selectedShipId = null;
            this.moveTargets.clear();
            this.mode = "idle";
            this.board.setSelectedShip(null);
            this.act({ t: "moveShip", shipId: sid, path });
          }
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
    const afford = (cost: Partial<ResourceBag>): boolean =>
      RESOURCES.every((r) => me.hand[r] >= (cost[r] ?? 0));
    // Human-readable cost ("1 ore, 2 fuel") and the shortfall against my hand.
    const costStr = (cost: Partial<ResourceBag>): string =>
      RESOURCES.filter((r) => (cost[r] ?? 0) > 0).map((r) => `${cost[r]} ${r}`).join(", ");
    const missingStr = (cost: Partial<ResourceBag>): string =>
      RESOURCES.filter((r) => (cost[r] ?? 0) > me.hand[r])
        .map((r) => `${(cost[r] ?? 0) - me.hand[r]} ${r}`)
        .join(", ");
    // Build a tooltip describing what a build needs and what's still missing.
    const buildTip = (cost: Partial<ResourceBag>, extra?: string): string => {
      const miss = missingStr(cost);
      const parts = [`Requires: ${costStr(cost)}`];
      if (miss) parts.push(`Missing: ${miss}`);
      if (extra) parts.push(extra);
      return parts.join("  ·  ");
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
        // Round 4: upgrade → place ship → take a bonus upgrade.
        if (su.round === 4) {
          if (su.r4step === "upgrade") {
            actions.appendChild(
              el(`<div class="waiting">Round 4 — click one of your colonies to upgrade it to a spaceport.</div>`),
            );
          } else if (su.r4step === "ship") {
            const sites = shipLaunchSites(me, state);
            const noSites = sites.length === 0;
            const hint = this.launchKind
              ? `Round 4 — click a glowing point next to your spaceport to launch your ${this.launchKind === "colonyShip" ? "colony" : "trade"} ship.`
              : "Round 4 — choose a ship, then click an open point next to your spaceport.";
            actions.appendChild(el(`<div class="waiting">${hint}</div>`));
            actions.appendChild(
              btn("Colony Ship", () => { this.launchKind = "colonyShip"; this.mode = "setupShip"; this.rerender(); },
                { disabled: noSites }),
            );
            actions.appendChild(
              btn("Trade Ship", () => { this.launchKind = "tradeShip"; this.mode = "setupShip"; this.rerender(); },
                { disabled: noSites, secondary: true }),
            );
          } else if (su.r4step === "bonus") {
            actions.appendChild(el(`<div class="waiting">Round 4 — take one bonus upgrade.</div>`));
            const pool = su.bonusPool ?? [];
            const seen = new Set<string>();
            for (const up of pool) {
              if (seen.has(up)) continue;
              seen.add(up);
              const label = up === "booster" ? "+Booster" : up === "cannon" ? "+Cannon" : "+Freight Pod";
              actions.appendChild(btn(label, () => this.act({ t: "setupBonus", upgrade: up }), { secondary: up !== "booster" }));
            }
          }
        }
        break;
      }

      case "production":
        actions.appendChild(btn("🎲 Roll dice", () => this.act({ t: "rollDice" })));
        break;

      case "tradeBuild": {
        // A green launch point was clicked on the map → let the player choose
        // which ship to launch from it (colony ship / trade ship).
        if (this.launchPickSite) {
          const site = this.launchPickSite;
          const noTransport = me.supply.transportShips <= 0;
          actions.appendChild(
            el(`<div class="waiting">Choose a ship to launch from this point.</div>`),
          );
          actions.appendChild(
            btn(`${shipIco("colonyShip")} Colony Ship`, () => {
              this.act({ t: "build", what: "colonyShip", targetId: site });
              this.resetSelection();
            }, {
              disabled: !afford(BUILD_COSTS.colonyShip) || noTransport,
              title: buildTip(BUILD_COSTS.colonyShip, "Launches a colony ship."),
            }),
          );
          actions.appendChild(
            btn(`${shipIco("tradeShip")} Trade Ship`, () => {
              this.act({ t: "build", what: "tradeShip", targetId: site });
              this.resetSelection();
            }, {
              disabled: !afford(BUILD_COSTS.tradeShip) || noTransport,
              secondary: true,
              title: buildTip(BUILD_COSTS.tradeShip, "Launches a trade ship."),
            }),
          );
          actions.appendChild(
            btn("Cancel", () => { this.launchPickSite = null; this.rerender(); }, { secondary: true }),
          );
          break;
        }
        const hasColony = state.buildings.some((b) => b.owner === me.id && b.kind === "colony");
        const hasLaunch = shipLaunchSites(me, state).length > 0;
        const noTransport = me.supply.transportShips <= 0;

        // Colony / Trade ship: need resources, an open launch point, and a free
        // transport ship in supply. Tell the player exactly which is missing.
        const shipTip = (cost: Partial<ResourceBag>, kind: string): string => {
          const blockers: string[] = [];
          if (noTransport) blockers.push("no transport ships left (all in use)");
          if (!hasLaunch) blockers.push("no open space point next to a spaceport");
          return buildTip(cost, blockers.length ? `Can't build: ${blockers.join("; ")}` : `Launches a ${kind}.`);
        };
        // Each build button also gets a hover/click icon popover (Q5) showing,
        // per resource, how much you have vs. need — green when satisfied, red
        // when short — plus a header telling you if you can build it right now.
        const addBuild = (b: HTMLElement, cost: Partial<ResourceBag>, extra?: string): HTMLElement => {
          this.attachCostTip(b, me, cost, extra);
          actions.appendChild(b);
          return b;
        };
        // How many of each piece you have left to build, so the button shows both
        // what the piece looks like (icon) and how many remain. Ships draw from
        // your transport-ship pool; spaceports upgrade an existing colony; the
        // three mothership upgrades each cap out at MAX_UPGRADES.
        const transportLeft = me.supply.transportShips;
        const colonyCount = state.buildings.filter((b) => b.owner === me.id && b.kind === "colony").length;
        const boosterLeft = MAX_UPGRADES.booster - me.upgrades.booster;
        const cannonLeft = MAX_UPGRADES.cannon - me.upgrades.cannon;
        const freightLeft = MAX_UPGRADES.freightPod - me.upgrades.freightPod;
        // Compose an icon + name + "N left" pill for a build button's label.
        const buildLabel = (icon: string, name: string, left: number): string =>
          `<span class="b-ico">${icon}</span><span class="b-name">${name}</span>` +
          `<span class="b-left ${left <= 0 ? "none" : ""}" title="${left} left to build">${left}</span>`;
        addBuild(
          btn(buildLabel(shipIco("colonyShip"), "Colony Ship", transportLeft), () => { this.launchKind = "colonyShip"; this.mode = "launchShip"; this.render(state); }, {
            disabled: !afford(BUILD_COSTS.colonyShip) || !hasLaunch || noTransport,
            title: shipTip(BUILD_COSTS.colonyShip, "colony ship"),
          }),
          BUILD_COSTS.colonyShip,
          "Launches a colony ship.",
        );
        addBuild(
          btn(buildLabel(shipIco("tradeShip"), "Trade Ship", transportLeft), () => { this.launchKind = "tradeShip"; this.mode = "launchShip"; this.render(state); }, {
            disabled: !afford(BUILD_COSTS.tradeShip) || !hasLaunch || noTransport,
            title: shipTip(BUILD_COSTS.tradeShip, "trade ship"),
          }),
          BUILD_COSTS.tradeShip,
          "Launches a trade ship.",
        );
        addBuild(
          btn(
            buildLabel(spaceportIco(), "Spaceport", colonyCount),
            () => { this.mode = "pickColony"; this.render(state); },
            {
              disabled: !afford(BUILD_COSTS.spaceport) || !hasColony,
              secondary: true,
              title: buildTip(
                BUILD_COSTS.spaceport,
                hasColony ? "Upgrades one of your colonies (+1 VP)." : "Can't build: you have no colony to upgrade.",
              ),
            },
          ),
          BUILD_COSTS.spaceport,
          "Upgrades a colony (+1 VP).",
        );
        addBuild(
          btn(buildLabel(upgradeIco("booster"), "Booster", boosterLeft), () => this.act({ t: "build", what: "booster" }), {
            disabled: !afford(BUILD_COSTS.booster) || boosterLeft <= 0, secondary: true,
            title: buildTip(BUILD_COSTS.booster, "+1 ship speed."),
          }),
          BUILD_COSTS.booster,
          "+1 ship speed.",
        );
        addBuild(
          btn(buildLabel(upgradeIco("cannon"), "Cannon", cannonLeft), () => this.act({ t: "build", what: "cannon" }), {
            disabled: !afford(BUILD_COSTS.cannon) || cannonLeft <= 0, secondary: true,
            title: buildTip(BUILD_COSTS.cannon, "+1 combat / clears pirate bases."),
          }),
          BUILD_COSTS.cannon,
          "+1 combat / clears pirate bases.",
        );
        addBuild(
          btn(buildLabel(upgradeIco("freightPod"), "Freight Pod", freightLeft), () => this.act({ t: "build", what: "freightPod" }), {
            disabled: !afford(BUILD_COSTS.freightPod) || freightLeft <= 0, secondary: true,
            title: buildTip(BUILD_COSTS.freightPod, "Extra trade stations / terraforms ice planets."),
          }),
          BUILD_COSTS.freightPod,
          "Extra trade stations / terraforms ice planets.",
        );
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
        actions.appendChild(btn("End build → Shake", () => this.endBuildAndShake()));
        break;
      }

      case "flight": {
        if (!ps.shake) {
          actions.appendChild(btn("Shake mothership", () => this.act({ t: "shakeMothership" })));
          break;
        }
        const speed = ps.moveBudget ?? ps.shake.speed;
        actions.appendChild(el(`<div class="waiting">Speed ${speed} · combat ${ps.shake.combat}</div>`));

        const ship = this.selectedShipId
          ? state.ships.find((s) => s.id === this.selectedShipId)
          : undefined;

        // Establish buttons appear for ANY of the player's ships that is parked on
        // a valid site — whether or not it's selected, and whether or not it has
        // already moved this turn. So a ship that just finished moving can still
        // settle a colony / dock at an outpost without re-selecting it.
        const myShips = state.ships.filter((s) => s.owner === me.id);
        let establishAvailable = false;
        for (const s of myShips) {
          const inter = state.intersections[s.intersectionId]!;
          if (s.kind === "colonyShip" && inter.adjacentPlanets.length === 2 &&
              !state.buildings.some((b) => b.intersectionId === inter.id)) {
            establishAvailable = true;
            // R12: a pirate base / ice planet next to the site blocks settling until
            // the player has enough cannons / freight pods. Grey the button and, on
            // click, surface a center notification spelling out exactly why.
            const block = colonyEstablishBlock(state, me, inter.id);
            if (block) {
              const b = btn("Establish Colony", () => {}, {
                disabled: true,
                title: block,
              });
              // A disabled <button> swallows clicks, so wrap it so the player can
              // still tap to read the reason in a center notification.
              const wrap = el(`<span class="estab-blocked" title="${escapeHtml(block)}"></span>`);
              wrap.appendChild(b);
              wrap.addEventListener("click", () => this.centerNote(block));
              actions.appendChild(wrap);
            } else {
              actions.appendChild(
                btn("Establish Colony", () => {
                  this.act({ t: "establishColony", shipId: s.id }, { center: true });
                  this.resetSelection();
                  this.rerender(); // re-wire the board so another ship can move
                }),
              );
            }
          }
          if (s.kind === "tradeShip" && inter.dockingPointOf) {
            establishAvailable = true;
            actions.appendChild(
              btn("Establish Trade Station", () => {
                this.act({ t: "establishTradeStation", shipId: s.id, dock: freeDock(state, inter.id) }, { center: true });
                this.resetSelection();
                this.rerender(); // re-wire the board so another ship can move
              }),
            );
          }
        }

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
    if (enc && (isNew || confirmChanged || stepChanged)) {
      if (isNew) this.snapshotPlayers(state);
      this.shownEncounter = { cardId: enc.cardId, subjectId: enc.subjectId, awaiting: enc.awaiting };
      this.shownConfirmCount = confirmCount;
      this.buildEncounterOverlay(state, enc.subjectId === me.id, me);
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

  private buildEncounterOverlay(state: GameState, mineToChoose: boolean, me: PlayerState): void {
    this.removeEncounterOverlay();
    const enc = state.phaseState.encounter!;
    const card = ENCOUNTER_CARDS[enc.cardId];
    const subject = state.players.find((p) => p.id === enc.subjectId)!;
    const overlay = el(`<div class="encounter-overlay"><div class="encounter-card"></div></div>`);
    const cardEl = overlay.querySelector(".encounter-card") as HTMLElement;
    cardEl.appendChild(el(`<div class="enc-tag">Encounter</div>`));
    cardEl.appendChild(el(`<div class="enc-title">${escapeHtml(card?.title ?? "Encounter")}</div>`));
    cardEl.appendChild(el(`<div class="enc-text">${escapeHtml(card?.text ?? "")}</div>`));

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
        choices.classList.add("col");
        for (const n of [0, 1, 2, 3]) {
          const label = n === 0 ? "Offer nothing" : `Offer ${n}`;
          choices.appendChild(
            el(`<button class="secondary enc-opt" disabled><span class="eo-n">${n}</span><span class="eo-hint">${label}</span></button>`),
          );
        }
      } else {
        choices.classList.add("col");
        choices.appendChild(el(`<button class="enc-opt" disabled><span class="eo-n">Yes</span></button>`));
        choices.appendChild(el(`<button class="secondary enc-opt" disabled><span class="eo-n">No</span></button>`));
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

    const parts: string[] = [];
    let glyph = "";
    if (medalDelta > 0) { parts.push(`+${medalDelta} VP medal`); glyph = medalGlyphSvg(); }
    if (fameDelta > 0) { parts.push(`+${fameDelta} fame (${fameDelta * 0.5} VP)`); if (!glyph) glyph = fameGlyphSvg(); }
    if (fameDelta < 0) parts.push(`${fameDelta} fame (${fameDelta * 0.5} VP)`);
    for (const g of gained) parts.push(`+${g.d} ${RESOURCE_LABEL[g.r]}`);
    for (const l of lost) parts.push(`${l.d} ${RESOURCE_LABEL[l.r]}`);
    const label = parts.length ? parts.join("  ·  ") : "No change";

    // Center toast.
    const toast = el(`<div class="result-toast"><span class="rt-glyph">${glyph}</span><span>${escapeHtml(label)}</span></div>`);
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
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
    window.setTimeout(() => toast.classList.remove("show"), 1900);
    window.setTimeout(() => toast.remove(), 2250);
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
      `<div class="shake-overlay"><div class="shake-stage" style="--accent:${accent}">
         <div class="cs-title" style="color:${accent}">${escapeHtml(active.name)} shakes the mothership</div>
         <div class="cs-balls">${ballHtml}</div>
         <div class="cs-result" style="visibility:hidden">Speed <b>${speed}</b> · Combat <b>${combat}</b></div>
       </div></div>`,
    );
    document.body.appendChild(overlay);
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
function resourceGlyphSvg(r: Resource): string {
  const wrap = (inner: string): string =>
    `<svg viewBox="0 0 24 24" width="22" height="22" stroke-linejoin="round">${inner}</svg>`;
  switch (r) {
    case "carbon":
      return wrap(
        `<polygon points="6,15.5 8.5,6.5 11,15.5" fill="#2f7fd6" stroke="#0a0f1e" stroke-width="0.7"/>
         <polygon points="13,15.5 16,7.5 18.2,15.5" fill="#3f97e4" stroke="#0a0f1e" stroke-width="0.7"/>
         <polygon points="9,16.5 12,2.5 15,16.5" fill="#57b6f0" stroke="#0a0f1e" stroke-width="0.7"/>
         <line x1="12" y1="2.5" x2="12" y2="16.5" stroke="#bfe9ff" stroke-width="0.8"/>`,
      );
    case "fuel":
      return wrap(
        `<rect x="8" y="5" width="8" height="14" fill="#d99a2b" stroke="#0a0f1e" stroke-width="0.7"/>
         <rect x="8.8" y="5" width="2.2" height="14" fill="#f6c659" opacity="0.6"/>
         <ellipse cx="12" cy="5" rx="4" ry="1.7" fill="#f6c659" stroke="#0a0f1e" stroke-width="0.7"/>
         <ellipse cx="12" cy="19" rx="4" ry="1.7" fill="#a06c14" stroke="#0a0f1e" stroke-width="0.7"/>
         <rect x="8" y="11" width="8" height="1.8" fill="#a06c14"/>`,
      );
    case "food":
      return wrap(
        `<circle cx="12" cy="12" r="8.5" fill="#4ca63a" stroke="#0a0f1e" stroke-width="0.7"/>
         <circle cx="8.4" cy="9.4" r="2" fill="#8fd66f" opacity="0.7"/>
         <circle cx="15.2" cy="14.5" r="1.7" fill="#8fd66f" opacity="0.7"/>
         <circle cx="9.5" cy="15.5" r="1.6" fill="#8fd66f" opacity="0.7"/>
         <circle cx="13" cy="11" r="2.9" fill="#eafff0" stroke="#0a0f1e" stroke-width="0.6"/>
         <circle cx="13.7" cy="11.4" r="1.4" fill="#0a0f1e"/>`,
      );
    case "ore":
      return wrap(
        `<polygon points="3.5,13 6.5,5.5 13,4.5 20,11 17.3,18.6 6,19" fill="#cc3633" stroke="#0a0f1e" stroke-width="0.7"/>
         <polygon points="6.5,5.5 13,4.5 12,10.2 6,10.6" fill="#f0746a" opacity="0.85"/>
         <polygon points="6,19 17.3,18.6 16,12 7,12.4" fill="#8c2120" opacity="0.7"/>`,
      );
    case "goods":
      return wrap(
        `<path d="M4 12 L4 9 Q4 4.5 12 4.5 Q20 4.5 20 9 L20 12 Z" fill="#7b4fc4" stroke="#0a0f1e" stroke-width="0.7"/>
         <rect x="4" y="11.5" width="16" height="8.5" fill="#7b4fc4" stroke="#0a0f1e" stroke-width="0.7"/>
         <rect x="4" y="11.5" width="16" height="2" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.4"/>
         <rect x="10.4" y="5" width="3.2" height="15" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.4"/>
         <circle cx="12" cy="14.8" r="1.6" fill="#e3b341" stroke="#0a0f1e" stroke-width="0.5"/>`,
      );
  }
}

/** Stylized top-down mothership illustration in the owner's color. */
function mothershipSvg(
  color: string,
  upgrades: { booster: number; cannon: number; freightPod: number } = {
    booster: 0,
    cannon: 0,
    freightPod: 0,
  },
): string {
  const BOOST = "#6fb3ff";
  const CANNON = "#ff6b6b";
  const FREIGHT = "#57e389";
  // A small numbered badge pinned to the relevant part of the hull.
  const badge = (x: number, y: number, fill: string, n: number): string =>
    `<g>
       <circle cx="${x}" cy="${y}" r="9.5" fill="${fill}" stroke="#05060f" stroke-width="1.6"/>
       <text x="${x}" y="${y + 4}" text-anchor="middle" font-size="12" font-weight="800"
             font-family="system-ui, sans-serif" fill="#0a0f1e">${n}</text>
     </g>`;
  // Light a part up when the player owns at least one of that upgrade.
  const lit = (on: boolean, hot: string): string => (on ? hot : "#2a3350");
  return `<svg viewBox="0 0 120 104" width="150" height="130" fill="none">
    <defs>
      <radialGradient id="msglow" cx="50%" cy="42%" r="60%">
        <stop offset="0%" stop-color="${color}" stop-opacity="0.9"/>
        <stop offset="100%" stop-color="${color}" stop-opacity="0.25"/>
      </radialGradient>
    </defs>
    <!-- engine boosters (glow when boosters owned) -->
    <rect x="20" y="70" width="14" height="18" rx="4" fill="${lit(upgrades.booster > 0, BOOST)}" stroke="${color}" stroke-width="1.4"/>
    <rect x="86" y="70" width="14" height="18" rx="4" fill="${lit(upgrades.booster > 0, BOOST)}" stroke="${color}" stroke-width="1.4"/>
    <rect x="53" y="74" width="14" height="18" rx="4" fill="${lit(upgrades.booster > 0, BOOST)}" stroke="${color}" stroke-width="1.4"/>
    <!-- freight pods slung under the hull (glow when owned) -->
    <rect x="40" y="62" width="12" height="9" rx="2" fill="${lit(upgrades.freightPod > 0, FREIGHT)}" stroke="${color}" stroke-width="1.2"/>
    <rect x="68" y="62" width="12" height="9" rx="2" fill="${lit(upgrades.freightPod > 0, FREIGHT)}" stroke="${color}" stroke-width="1.2"/>
    <!-- hull -->
    <path d="M60 6 C40 18 30 40 32 64 L88 64 C90 40 80 18 60 6 Z"
          fill="url(#msglow)" stroke="${color}" stroke-width="2"/>
    <!-- side cannons (glow when owned) -->
    <rect x="14" y="40" width="18" height="8" rx="3" fill="${lit(upgrades.cannon > 0, CANNON)}" stroke="${color}" stroke-width="1.4"/>
    <rect x="88" y="40" width="18" height="8" rx="3" fill="${lit(upgrades.cannon > 0, CANNON)}" stroke="${color}" stroke-width="1.4"/>
    <!-- cockpit -->
    <circle cx="60" cy="34" r="11" fill="#0a0f1e" stroke="${color}" stroke-width="2"/>
    <circle cx="60" cy="34" r="5" fill="${color}" opacity="0.85"/>
    <!-- live upgrade counts pinned to each system -->
    ${badge(23, 44, CANNON, upgrades.cannon)}
    ${badge(60, 84, BOOST, upgrades.booster)}
    ${badge(86, 67, FREIGHT, upgrades.freightPod)}
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

// Single source of truth for the in-game piece silhouettes. These SVGs mirror
// the PixiJS pieces drawn on the board (drawShip / drawColony / drawSpaceport),
// so a colony / spaceport / ship reads identically on the map, in the sidebar,
// on the build buttons, and in the costs reference.
const PIECE_INK = "#0a0f1e";

/** An upright isometric block (three shaded faces), base-centre (tx,ty). */
function isoBoxSvg(tx: number, ty: number, hw: number, h: number): string {
  const dh = hw * 0.5;
  const f = (n: number): string => n.toFixed(1);
  const top = `${f(tx - hw)},${f(ty - h)} ${f(tx)},${f(ty + dh - h)} ${f(tx + hw)},${f(ty - h)} ${f(tx)},${f(ty - dh - h)}`;
  const left = `${f(tx - hw)},${f(ty)} ${f(tx)},${f(ty + dh)} ${f(tx)},${f(ty + dh - h)} ${f(tx - hw)},${f(ty - h)}`;
  const right = `${f(tx)},${f(ty + dh)} ${f(tx + hw)},${f(ty)} ${f(tx + hw)},${f(ty - h)} ${f(tx)},${f(ty + dh - h)}`;
  return `<polygon points="${left}" fill="currentColor" fill-opacity="0.55" stroke="${PIECE_INK}" stroke-width="0.4"/>
    <polygon points="${right}" fill="currentColor" fill-opacity="0.85" stroke="${PIECE_INK}" stroke-width="0.4"/>
    <polygon points="${top}" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.4"/>`;
}

/** A flat isometric hexagonal platform centred at (cx,cy). */
function isoHexSvg(cx: number, cy: number, s: number): string {
  const f = (n: number): string => n.toFixed(1);
  const hex = (yy: number): string => {
    const p: string[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 180) * (60 * i + 30);
      p.push(`${f(cx + s * Math.cos(a))},${f(yy + s * 0.52 * Math.sin(a))}`);
    }
    return p.join(" ");
  };
  const t = s * 0.32;
  return `<polygon points="${hex(cy + t)}" fill="currentColor" fill-opacity="0.55" stroke="${PIECE_INK}" stroke-width="0.4"/>
    <polygon points="${hex(cy)}" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.4"/>`;
}

/** Isometric rocket on a pedestal — matches the board's drawShip. */
function shipIco(kind?: "colonyShip" | "tradeShip"): string {
  const pedestal =
    kind === "tradeShip"
      ? `<ellipse cx="12" cy="21" rx="4.6" ry="1.6" fill="currentColor" fill-opacity="0.6" stroke="${PIECE_INK}" stroke-width="0.4"/><rect x="8" y="17" width="8" height="4" rx="1" fill="currentColor" stroke="${PIECE_INK}" stroke-width="0.4"/>`
      : isoHexSvg(12, 20, 5);
  const detail =
    kind === "tradeShip"
      ? `<rect x="9.5" y="6.5" width="3.6" height="6" fill="${PIECE_INK}" opacity="0.4"/>`
      : kind === "colonyShip"
        ? `<circle cx="11" cy="9.5" r="1.9" fill="${PIECE_INK}" opacity="0.4"/>`
        : "";
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
    ${pedestal}
    <rect x="11" y="11" width="2" height="7" fill="currentColor" fill-opacity="0.55"/>
    <polygon points="5,7 2.6,3.8 6,8" fill="currentColor" fill-opacity="0.7" stroke="${PIECE_INK}" stroke-width="0.4"/>
    <polygon points="5,12.5 2.6,15.7 6,11.5" fill="currentColor" fill-opacity="0.7" stroke="${PIECE_INK}" stroke-width="0.4"/>
    <rect x="4" y="6.6" width="12.5" height="6.4" rx="3.2" stroke="${PIECE_INK}" stroke-width="0.7"/>
    <polygon points="16.5,6.6 20.8,9.8 16.5,13" fill="currentColor" fill-opacity="0.85" stroke="${PIECE_INK}" stroke-width="0.7"/>
    ${detail}
  </svg>`;
}

/** Colony: a hex platform topped with a small cluster of iso towers. */
function colonyIco(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
    ${isoHexSvg(12, 17.5, 7)}
    ${isoBoxSvg(12, 15, 3.4, 9)}
    ${isoBoxSvg(7.6, 17, 2.6, 5.4)}
    ${isoBoxSvg(16.4, 17.4, 2.4, 4.4)}
  </svg>`;
}

/** Spaceport: a wider platform with a denser, taller tower cluster + beacon. */
function spaceportIco(): string {
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor" stroke="none">
    ${isoHexSvg(12, 19, 8.4)}
    ${isoBoxSvg(8, 15.5, 2.6, 7)}
    ${isoBoxSvg(16, 15.8, 2.4, 6)}
    ${isoBoxSvg(12, 16.6, 3, 12)}
    ${isoBoxSvg(6, 18.6, 2.2, 4.4)}
    ${isoBoxSvg(17.5, 18.8, 2.4, 5.2)}
    <circle cx="12" cy="4.4" r="1.6" fill="#ffd23f" stroke="${PIECE_INK}" stroke-width="0.6"/>
  </svg>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}
