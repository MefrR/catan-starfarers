import { Application, Circle, Container, type FederatedPointerEvent, Graphics, Text, TextStyle } from "pixi.js";
import {
  PLANET_RESOURCE,
  type GameState,
  type PlanetColor,
  type PlayerColor,
  type Resource,
} from "@starfarers/shared";

const PLANET_FILL: Record<PlanetColor, number> = {
  red: 0xd8453a,
  orange: 0xe08a2e,
  blue: 0x3d7fd6,
  green: 0x3fae6b,
  multicolor: 0x9a6fd0,
};

const OWNER_FILL: Record<PlayerColor, number> = {
  yellow: 0xf4d23a,
  red: 0xd8453a,
  blue: 0x3d7fd6,
  black: 0x2a2d3a,
  green: 0x3fbf6e,
  white: 0xdfe6f0,
};

/** Per-civ outpost colour + display name (mirrors the printed OUTPOSTS art). */
const CIV_STYLE: Record<string, { color: number; name: string; ability: string }> = {
  greenFolk: { color: 0x57e389, name: "The Green Folk", ability: "Bountiful harvests — extra resources from your planets' production" },
  scientists: { color: 0x6fb3ff, name: "The Scientists", ability: "Advanced tech — permanent boosters & cannons (more speed & combat)" },
  diplomats: { color: 0xffd23f, name: "The Diplomats", ability: "Influence — raises your 7-discard limit & lets you buy fame" },
  merchants: { color: 0xc98bff, name: "The Merchants", ability: "Master traders — better exchange rates with the supply" },
  travelers: { color: 0xff8a5d, name: "The Travelers", ability: "Wandering allies you meet only during encounters" },
};

const RESOURCE_NAME: Record<Resource, string> = {
  ore: "Ore",
  fuel: "Fuel",
  carbon: "Carbon",
  food: "Food",
  goods: "Goods",
};

const OWNER_NAME: Record<PlayerColor, string> = {
  yellow: "Yellow",
  red: "Red",
  blue: "Blue",
  black: "Black",
  green: "Green",
  white: "White",
};

/** Shift a hex colour toward white (f>0) or black (f<0); f in [-1,1]. */
function tint(color: number, f: number): number {
  const clamp = (v: number): number => Math.max(0, Math.min(255, Math.round(v)));
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  const mix = (c: number): number => (f >= 0 ? c + (255 - c) * f : c * (1 + f));
  return (clamp(mix(r)) << 16) | (clamp(mix(g)) << 8) | clamp(mix(b));
}

/**
 * Renders the authoritative GameState as a 2.5D hex board on top of the
 * starfield. Re-render is wholesale (clear + redraw) on every state update —
 * cheap for this board size and keeps the renderer stateless.
 */
export class BoardRenderer {
  private root = new Container();
  private app: Application;

  /** Click callbacks wired by the HUD for flight/build board selection. */
  onIntersectionClick: ((id: string) => void) | null = null;
  onShipClick: ((id: string) => void) | null = null;

  /** The local human's seat id (set by main.ts) for "(yours)" tooltips. */
  humanId: string | null = null;

  private highlightIds = new Set<string>();
  private selectedShipId: string | null = null;
  // Continuously pulsing/glowing build-site markers (live on the FX overlay so
  // they survive wholesale re-renders and animate every frame).
  private highlightG: Graphics | null = null;
  private highlightTick: (() => void) | null = null;

  // Persistent FX overlay (build pulses) — survives wholesale re-renders.
  private fx = new Container();

  // Z4: ambient board life — breathing planet halos, tiny orbiting motes and
  // pulsing pirate/ice tokens. Rebuilt each render (the items live inside the
  // wholesale-redrawn layers); one persistent ticker animates whatever the
  // current render registered. Deterministic phases (from position), no RNG.
  private ambientItems: {
    g: Graphics;
    kind: "halo" | "mote" | "special" | "spin" | "pulse";
    x: number;
    y: number;
    rad: number;
    phase: number;
    speed: number;
  }[] = [];
  private prevPieces = new Set<string>();
  private piecesInit = false;
  // Q2: last-known board-space position of each ship, to animate moves.
  private prevShipPos = new Map<string, { x: number; y: number; color: number }>();
  private shipPosInit = false;

  // User view transform (zoom + pan) layered on top of the fit transform.
  private zoom = 1;
  private panX = 0;
  private panY = 0;
  private static readonly MIN_ZOOM = 0.5;
  private static readonly MAX_ZOOM = 6;
  // How far past the board's edges the view may pan before it's clamped — empty
  // "overscroll" so the map can never be dragged off into the void where players
  // would get lost. Horizontally ~15cm; vertically a roomier ~20cm so tall maps
  // can be scrolled well up/down. (96 CSS px/in ÷ 2.54 cm/in × cm.)
  private static readonly PAN_MARGIN = Math.round((96 / 2.54) * 15);
  private static readonly PAN_MARGIN_Y = Math.round((96 / 2.54) * 20);
  // Board content bounds in ORIENTED board-space (set each render) — drives pan clamping.
  private contentBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };

  /** #1: board presentation orientation. "landscape" rotates board-space 90° so
   *  the tall map runs horizontally (most monitors); "portrait" is the original.
   *  Toggle from the side tools; persisted. Default landscape. Only positions are
   *  rotated — labels/numbers stay upright. */
  orientation: "landscape" | "portrait" =
    (typeof localStorage !== "undefined" && localStorage.getItem("sf_orient") === "portrait")
      ? "portrait" : "landscape";
  private get land(): boolean { return this.orientation === "landscape"; }
  /** Raw board-space → oriented board-space (90° rotation when landscape). */
  private ori(x: number, y: number): { x: number; y: number } {
    return this.land ? { x: -y, y: x } : { x, y };
  }
  /** Inverse of ori(): oriented board-space → raw board-space. */
  private oriInv(x: number, y: number): { x: number; y: number } {
    return this.land ? { x: y, y: -x } : { x, y };
  }
  // Auto-recenter: a double-tap, or 10s of no interaction, glides back to the
  // fitted middle so a lost/zoomed-in view always returns to the whole map.
  private idleTimer = 0;
  private recenterAnim = 0;
  private lastTapTime = 0;
  private lastTapPos = { x: 0, y: 0 };
  // The zoom level the board geometry was last *drawn* at. Zoom is baked into the
  // draw scale (so text and strokes stay crisp); between a zoom gesture and the
  // crisp re-render, the container is scaled by zoom/renderedZoom for instant
  // feedback. A short debounce then redraws everything sharp at the new zoom.
  private renderedZoom = 1;
  private rerenderTimer = 0;

  // Floating DOM tooltip describing whatever the pointer is over.
  private tooltipEl: HTMLDivElement;
  private mouse = { x: 0, y: 0 };
  // Touch has no hover/"pointerout", so tooltips are tap-to-show, placed away
  // from the finger, and auto-dismissed by a timer so they can never get stuck.
  private tipTouch = false;
  private tipTimer = 0;

  constructor(app: Application) {
    this.app = app;
    app.stage.addChild(this.root);
    // The FX overlay (move comets, build pulses) lives on the stage with its own
    // zoom+pan transform (fit-space coords × zoom), independent of the board's
    // baked-zoom geometry, so animations land correctly at any zoom level.
    app.stage.addChild(this.fx);
    window.addEventListener("resize", () => this.syncSize());
    this.tooltipEl = document.createElement("div");
    this.tooltipEl.className = "map-tooltip";
    document.body.appendChild(this.tooltipEl);
    window.addEventListener("pointermove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.tooltipEl.classList.contains("show")) this.positionTooltip();
    });
    // Any tap/click that isn't on the board canvas (e.g. a HUD button with a
    // colony site behind it) immediately clears a lingering map tooltip.
    window.addEventListener("pointerdown", (e) => {
      if (e.target !== this.app.canvas) this.hideTip();
    }, true);
    this.installViewControls();

    // Z4: the single ambient ticker. Skipped entirely for reduced-motion users
    // (the board simply stays static — gameplay is identical).
    if (!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.app.ticker.add(() => {
        if (this.ambientItems.length === 0) return;
        const t = performance.now();
        for (const it of this.ambientItems) {
          if (it.kind === "halo") {
            // Breathe the glow halo: its draw alpha is the base; g.alpha scales it.
            it.g.alpha = 0.72 + 0.32 * Math.sin(t * 0.0011 * it.speed + it.phase);
          } else if (it.kind === "special") {
            it.g.alpha = 0.86 + 0.14 * Math.sin(t * 0.0019 + it.phase);
          } else if (it.kind === "spin") {
            // AA6: outpost energy ring — a slow, stately rotation.
            it.g.rotation = t * 0.00022 * it.speed + it.phase;
          } else if (it.kind === "pulse") {
            // Flight-phase cue: a ship you can still fly breathes a green ring
            // (alpha + scale) so it's obvious it's time to move.
            const p = 0.5 + 0.5 * Math.sin(t * 0.005 * it.speed + it.phase);
            it.g.alpha = 0.3 + 0.6 * p;
            it.g.scale.set(1 + 0.18 * p);
          } else {
            // Mote on a tilted ellipse; it dims while on the far (upper) half.
            const a = t * 0.00042 * it.speed + it.phase;
            const sy = Math.sin(a);
            it.g.position.set(it.x + Math.cos(a) * it.rad * 1.32, it.y + sy * it.rad * 0.42);
            it.g.alpha = sy < 0 ? 0.3 : 0.85;
          }
        }
      });
    }
  }

  private positionTooltip(): void {
    const r = this.tooltipEl.getBoundingClientRect();
    let x: number;
    let y: number;
    if (this.tipTouch) {
      // Touch: centre the tip and lift it well ABOVE the finger so the touch
      // point never covers it. Drop below only if there's no room above.
      x = this.mouse.x - r.width / 2;
      y = this.mouse.y - r.height - 30;
      if (y < 8) y = this.mouse.y + 38;
    } else {
      const pad = 14;
      x = this.mouse.x + pad;
      y = this.mouse.y + pad;
      if (x + r.width > window.innerWidth - 8) x = this.mouse.x - r.width - pad;
      if (y + r.height > window.innerHeight - 8) y = this.mouse.y - r.height - pad;
    }
    x = Math.max(8, Math.min(x, window.innerWidth - r.width - 8));
    y = Math.max(8, Math.min(y, window.innerHeight - r.height - 8));
    this.tooltipEl.style.left = `${x}px`;
    this.tooltipEl.style.top = `${y}px`;
  }

  /** When set, hover/tap tooltips are suppressed entirely (e.g. while the player
   *  is choosing a ship to fly — info popups would distract from picking a path). */
  tooltipsSuppressed = false;

  private showTip(text: string, touch: boolean): void {
    if (this.tooltipsSuppressed) return;
    this.tipTouch = touch;
    this.tooltipEl.innerHTML = text;
    this.tooltipEl.classList.add("show");
    this.positionTooltip();
    window.clearTimeout(this.tipTimer);
    // Always self-dismiss after 2s so a hover popup never lingers on screen.
    this.tipTimer = window.setTimeout(() => this.hideTip(), 2000);
  }

  private hideTip(): void {
    window.clearTimeout(this.tipTimer);
    this.tooltipEl.classList.remove("show");
  }

  /** Make a display object describable: shows `text` on hover (mouse) or tap (touch). */
  private attachTip(obj: Container, hit: Circle, text: string): void {
    obj.eventMode = "static";
    obj.hitArea = hit;
    obj.on("pointerover", (e: FederatedPointerEvent) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      this.showTip(text, e.pointerType === "touch");
    });
    obj.on("pointermove", (e: FederatedPointerEvent) => {
      if (e.pointerType === "touch") {
        this.mouse = { x: e.clientX, y: e.clientY };
        this.positionTooltip();
      }
    });
    obj.on("pointerout", () => this.hideTip());
  }

  private last: GameState | null = null;
  private fit = { scale: 1, ox: 0, oy: 0 };

  /** Board-space (x,y) → on-screen pixel coords, honoring orientation + fit + zoom/pan. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    const o = this.ori(x, y);
    const wx = this.fit.ox + o.x * this.fit.scale;
    const wy = this.fit.oy + o.y * this.fit.scale;
    return { x: wx * this.zoom + this.panX, y: wy * this.zoom + this.panY };
  }

  /** Switch the board between landscape/portrait, persist it, reset the view and
   *  re-render in place. Wired to a side-tools button. */
  setOrientation(o: "landscape" | "portrait"): void {
    if (o === this.orientation) return;
    this.orientation = o;
    try { localStorage.setItem("sf_orient", o); } catch { /* ignore */ }
    this.zoom = 1; this.panX = 0; this.panY = 0;
    if (this.last) this.render(this.last);
    this.onViewChange?.();
  }
  toggleOrientation(): void { this.setOrientation(this.land ? "portrait" : "landscape"); }

  /** On-screen pixel position of an intersection (or null if unknown). */
  screenPosOf(intersectionId: string): { x: number; y: number } | null {
    const inter = this.last?.intersections[intersectionId];
    if (!inter) return null;
    return this.worldToScreen(inter.x, inter.y);
  }

  /** Page-space (viewport) pixel position of an intersection — for anchoring a
   *  floating DOM overlay (e.g. the on-map launch picker) right over the point. */
  pagePosOf(intersectionId: string): { x: number; y: number } | null {
    const p = this.screenPosOf(intersectionId);
    if (!p) return null;
    const rect = (this.app.canvas as HTMLCanvasElement).getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  /** Optional callback fired whenever the view transform changes (pan/zoom), so
   *  an open DOM overlay anchored to the map can reposition itself live. */
  onViewChange: (() => void) | null = null;

  private applyViewTransform(): void {
    // Keep the map from being dragged off into empty space before we commit pan.
    this.clampPan();
    // Geometry is drawn baked at `renderedZoom`; the container only needs to make
    // up the difference to the live zoom (= 1 right after a render). Pan is in
    // screen pixels and is unaffected by this transient scale.
    this.root.scale.set(this.zoom / this.renderedZoom);
    this.root.position.set(this.panX, this.panY);
    // FX uses fit-space coords, so it carries the full zoom (old model).
    this.fx.scale.set(this.zoom);
    this.fx.position.set(this.panX, this.panY);
    this.onViewChange?.();
  }

  /**
   * Constrain pan so the board can never be pushed more than PAN_MARGIN (~5cm)
   * of empty space past any screen edge. When the board is *smaller* than the
   * viewport in an axis (the clamp range inverts), it's snapped to the centre of
   * that axis instead — so at the fitted zoom the map simply stays put.
   */
  private clampPan(): void {
    const b = this.contentBounds;
    if (b.maxX === b.minX || b.maxY === b.minY) return; // bounds not set yet
    // At (or below) the fitted zoom the map is already centered by
    // computeTransform — so just pin pan to zero. No clamp/centre-snap math runs
    // here, which is exactly the "remove the locking" check: the default view is
    // positioned purely by the window-based fit. The clamp below only constrains
    // panning once the player has zoomed IN past the fit.
    if (this.zoom <= 1) {
      this.panX = 0;
      this.panY = 0;
      return;
    }
    const z = this.zoom;
    const f = this.fit;
    // Clamp against the live viewport too (see computeTransform) so the centre
    // snap lands on the visible window, not a stale-large canvas buffer.
    const sw = window.innerWidth || this.app.screen.width;
    const sh = window.innerHeight || this.app.screen.height;
    const M = BoardRenderer.PAN_MARGIN;
    const MY = BoardRenderer.PAN_MARGIN_Y;
    // Board edges on screen (pan excluded — it's the value we're solving for).
    const bx0 = (f.ox + b.minX * f.scale) * z;
    const bx1 = (f.ox + b.maxX * f.scale) * z;
    const by0 = (f.oy + b.minY * f.scale) * z;
    const by1 = (f.oy + b.maxY * f.scale) * z;
    const loX = sw - M - bx1;
    const hiX = M - bx0;
    this.panX = loX > hiX ? (loX + hiX) / 2 : Math.max(loX, Math.min(hiX, this.panX));
    const loY = sh - MY - by1;
    const hiY = MY - by0;
    this.panY = loY > hiY ? (loY + hiY) / 2 : Math.max(loY, Math.min(hiY, this.panY));
  }

  /** Glide the view to a target zoom + pan over `dur` ms, then bake a crisp
   *  re-render at the final zoom. Shared by recenter and region focus. */
  private animateViewTo(zT: number, pxT: number, pyT: number, dur = 380): void {
    if (this.zoom === zT && this.panX === pxT && this.panY === pyT) return; // already there
    cancelAnimationFrame(this.recenterAnim);
    const z0 = this.zoom;
    const px0 = this.panX;
    const py0 = this.panY;
    const t0 = performance.now();
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      const e = ease(t);
      this.zoom = z0 + (zT - z0) * e;
      this.panX = px0 + (pxT - px0) * e;
      this.panY = py0 + (pyT - py0) * e;
      this.applyViewTransform();
      if (t < 1) {
        this.recenterAnim = requestAnimationFrame(step);
      } else {
        this.recenterAnim = 0;
        if (this.last) this.render(this.last); // bake crisp at the final zoom
      }
    };
    this.recenterAnim = requestAnimationFrame(step);
  }

  /**
   * Glide the view back to the fitted middle (zoom 1, centred) over ~380ms.
   * Fired by a double-tap or after 60s of no map interaction so a lost or
   * zoomed-in player is always returned to the whole map.
   */
  private animateRecenter(): void {
    this.animateViewTo(1, 0, 0, 380);
  }

  /**
   * Frame a set of board-space points inside a given on-screen viewport rect
   * (the area NOT covered by HUD panels), zooming in so the region fills it.
   * Used to spotlight the starting colonies during the set-up rounds, which
   * otherwise sit hidden under the bottom action bar on tall maps.
   */
  focusRegion(
    points: { x: number; y: number }[],
    view: { left: number; top: number; right: number; bottom: number },
  ): void {
    if (points.length === 0) return;
    this.cancelInertia();
    this.cancelZoomGlide();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of points) {
      const o = this.ori(p.x, p.y); // points are raw board-space; fit works in oriented space
      if (o.x < minX) minX = o.x;
      if (o.x > maxX) maxX = o.x;
      if (o.y < minY) minY = o.y;
      if (o.y > maxY) maxY = o.y;
    }
    // Breathing room around the region (board units).
    const pad = 0.55;
    const f = this.fit;
    const x0 = f.ox + (minX - pad) * f.scale;
    const x1 = f.ox + (maxX + pad) * f.scale;
    const y0 = f.oy + (minY - pad) * f.scale;
    const y1 = f.oy + (maxY + pad) * f.scale;
    const availW = Math.max(80, view.right - view.left);
    const availH = Math.max(80, view.bottom - view.top);
    // Zoom so the region fills the available window. Must stay > 1: at the
    // fitted zoom clampPan pins the pan to 0 and the framing couldn't move.
    let z = Math.min(availW / Math.max(1, x1 - x0), availH / Math.max(1, y1 - y0));
    z = Math.max(1.06, Math.min(z, BoardRenderer.MAX_ZOOM));
    const cx = (x0 + x1) / 2;
    const cy = (y0 + y1) / 2;
    this.animateViewTo(z, (view.left + view.right) / 2 - cx * z, (view.top + view.bottom) / 2 - cy * z, 520);
    this.resetIdleTimer();
  }

  /** The visible screen viewport expressed in BOARD coordinates — drives the
   *  minimap's view rectangle. */
  visibleBoardRect(): { x0: number; y0: number; x1: number; y1: number } {
    const inv = (sx: number, sy: number): { x: number; y: number } => ({
      x: ((sx - this.panX) / this.zoom - this.fit.ox) / this.fit.scale,
      y: ((sy - this.panY) / this.zoom - this.fit.oy) / this.fit.scale,
    });
    const a0 = inv(0, 0);
    const b0 = inv(window.innerWidth, window.innerHeight);
    // inv() yields ORIENTED board-space; convert back to raw board-space and
    // normalise (the rotation can flip which corner is min/max).
    const a = this.oriInv(a0.x, a0.y);
    const b = this.oriInv(b0.x, b0.y);
    return { x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y), x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y) };
  }

  /** Glide the camera so a BOARD point lands at the screen centre (minimap
   *  click-to-jump). Zooms in a little if currently at the fitted view. */
  centerOnBoardPoint(bx: number, by: number): void {
    const z = Math.max(this.zoom, 1.5);
    const o = this.ori(bx, by);
    const cx = this.fit.ox + o.x * this.fit.scale;
    const cy = this.fit.oy + o.y * this.fit.scale;
    this.animateViewTo(z, window.innerWidth / 2 - cx * z, window.innerHeight / 2 - cy * z, 420);
    this.resetIdleTimer();
  }

  /** User setting: when false, the idle auto-recenter is disabled (double-tap
   *  recenter still works). Toggled from the HUD tools. Defaults OFF (playtest
   *  #43) — the idle zoom-out was disorienting mid-turn. */
  autoRecenterEnabled = false;

  /** (Re)start the 60s idle countdown that auto-recenters the map. No-op when the
   *  player has switched auto-recenter off. */
  private resetIdleTimer(): void {
    window.clearTimeout(this.idleTimer);
    if (!this.autoRecenterEnabled) return;
    this.idleTimer = window.setTimeout(() => this.animateRecenter(), 60000);
  }

  /** Turn the idle auto-recenter on/off (HUD tools toggle). */
  setAutoRecenter(on: boolean): void {
    this.autoRecenterEnabled = on;
    if (on) this.resetIdleTimer();
    else window.clearTimeout(this.idleTimer);
  }

  /**
   * After a zoom gesture settles, redraw the board with the new zoom baked into
   * the draw scale so numbers and outlines are pixel-sharp (instead of a blurry
   * up-scaled bitmap). Debounced so a continuous pinch/wheel doesn't thrash.
   */
  private scheduleCrispRender(): void {
    window.clearTimeout(this.rerenderTimer);
    this.rerenderTimer = window.setTimeout(() => {
      if (this.last && this.renderedZoom !== this.zoom) this.render(this.last);
    }, 130);
  }

  /** Set zoom to an absolute value while keeping the given canvas-space point
   *  fixed under the cursor/fingers (the shared math for wheel + pinch). */
  private applyZoomAt(mx: number, my: number, newZoom: number): void {
    const worldX = (mx - this.panX) / this.zoom;
    const worldY = (my - this.panY) / this.zoom;
    this.zoom = Math.max(BoardRenderer.MIN_ZOOM, Math.min(BoardRenderer.MAX_ZOOM, newZoom));
    this.panX = mx - worldX * this.zoom;
    this.panY = my - worldY * this.zoom;
    this.applyViewTransform();
    this.scheduleCrispRender();
  }

  /** Zoom toward a screen point (canvas-relative math), clamped to limits. */
  private zoomToward(clientX: number, clientY: number, factor: number): void {
    const canvas = this.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    this.applyZoomAt(clientX - rect.left, clientY - rect.top, this.zoom * factor);
  }

  // --- Smooth wheel zoom: the wheel sets a TARGET; a ticker glide eases the live
  // zoom toward it every frame, so steps melt into one continuous motion. Pinch
  // stays direct (the fingers are the animation). ---
  private zoomTarget = 1;
  private zoomAnchor = { x: 0, y: 0 };
  private zoomGlide = 0;

  private glideZoomToward(clientX: number, clientY: number, factor: number): void {
    const canvas = this.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    // Re-anchor on every wheel tick so the glide always pulls toward the cursor.
    this.zoomAnchor = { x: clientX - rect.left, y: clientY - rect.top };
    const base = this.zoomGlide ? this.zoomTarget : this.zoom;
    this.zoomTarget = Math.max(
      BoardRenderer.MIN_ZOOM,
      Math.min(BoardRenderer.MAX_ZOOM, base * factor),
    );
    if (this.zoomGlide) return; // glide already running — it will chase the new target
    let prev = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(50, now - prev);
      prev = now;
      const gap = this.zoomTarget - this.zoom;
      if (Math.abs(gap) < 0.002) {
        this.applyZoomAt(this.zoomAnchor.x, this.zoomAnchor.y, this.zoomTarget);
        this.zoomGlide = 0;
        return;
      }
      // Exponential ease: cover ~63% of the remaining gap every 60ms.
      const k = 1 - Math.exp(-dt / 60);
      this.applyZoomAt(this.zoomAnchor.x, this.zoomAnchor.y, this.zoom + gap * k);
      this.zoomGlide = requestAnimationFrame(step);
    };
    this.zoomGlide = requestAnimationFrame(step);
  }

  private cancelZoomGlide(): void {
    cancelAnimationFrame(this.zoomGlide);
    this.zoomGlide = 0;
  }

  // --- Drag inertia: the map keeps the throw's momentum after release and
  // glides to a stop with friction (cancelled by any new touch/wheel). ---
  private inertiaAnim = 0;
  private dragVel = { x: 0, y: 0, t: 0 };

  private startInertia(): void {
    const speed = Math.hypot(this.dragVel.x, this.dragVel.y);
    if (speed < 0.25 || this.zoom <= 1) return; // too slow / nothing to throw at fit zoom
    let vx = this.dragVel.x;
    let vy = this.dragVel.y;
    let prev = performance.now();
    const step = (now: number): void => {
      const dt = Math.min(50, now - prev);
      prev = now;
      this.panX += vx * dt;
      this.panY += vy * dt;
      const decay = Math.exp(-dt / 320); // friction time-constant
      vx *= decay;
      vy *= decay;
      this.applyViewTransform();
      if (Math.hypot(vx, vy) < 0.02) {
        this.inertiaAnim = 0;
        return;
      }
      this.inertiaAnim = requestAnimationFrame(step);
    };
    this.inertiaAnim = requestAnimationFrame(step);
  }

  private cancelInertia(): void {
    cancelAnimationFrame(this.inertiaAnim);
    this.inertiaAnim = 0;
  }

  /**
   * Pointer-based view controls covering both mouse and touch:
   * - mouse wheel zooms toward the cursor;
   * - one finger / left-drag pans;
   * - two fingers pinch to zoom (toward the pinch midpoint) and pan together.
   * `touch-action: none` stops the browser from hijacking touch gestures
   * (native page scroll/zoom), which would otherwise swallow these events.
   */
  private installViewControls(): void {
    const canvas = this.app.canvas as HTMLCanvasElement;
    canvas.style.touchAction = "none";

    canvas.addEventListener(
      "wheel",
      (e: WheelEvent) => {
        e.preventDefault();
        cancelAnimationFrame(this.recenterAnim);
        this.cancelInertia();
        // Trackpads emit many small deltas, wheels emit chunky ones — scale the
        // factor by the delta so both feel right, then glide smoothly toward it.
        const mag = Math.min(1.35, 1.12 + Math.abs(e.deltaY) * 0.0006);
        this.glideZoomToward(e.clientX, e.clientY, e.deltaY < 0 ? mag : 1 / mag);
        this.resetIdleTimer();
      },
      { passive: false },
    );

    // Track every active pointer so we can tell one-finger pan from a pinch.
    const pts = new Map<number, { x: number; y: number }>();
    let moved = false;
    let pinchDist = 0;
    let pinchMid = { x: 0, y: 0 };

    canvas.addEventListener("pointerdown", (e: PointerEvent) => {
      cancelAnimationFrame(this.recenterAnim); // grabbing cancels an auto-recenter
      this.recenterAnim = 0;
      this.cancelInertia(); // catching the map stops a momentum glide
      this.cancelZoomGlide();
      this.resetIdleTimer();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.dragVel = { x: 0, y: 0, t: performance.now() };
      moved = false;
      if (pts.size === 2) {
        const vs = [...pts.values()];
        const a = vs[0]!;
        const b = vs[1]!;
        pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
    });

    window.addEventListener("pointermove", (e: PointerEvent) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      this.resetIdleTimer(); // active dragging keeps the map put
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pts.size >= 2) {
        // Pinch: zoom by the change in finger distance, and pan by how the
        // midpoint between the two fingers moved.
        const vs = [...pts.values()];
        const a = vs[0]!;
        const b = vs[1]!;
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        this.hideTip();
        moved = true;
        if (pinchDist > 0) {
          this.panX += mid.x - pinchMid.x;
          this.panY += mid.y - pinchMid.y;
          this.zoomToward(mid.x, mid.y, dist / pinchDist);
        }
        pinchDist = dist;
        pinchMid = mid;
        return;
      }

      // Single pointer: drag-pan, with a small threshold so taps still register.
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      if (!moved && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 4) {
        // restore prev so the threshold measures from the press point
        pts.set(e.pointerId, prev);
        return;
      }
      moved = true;
      this.hideTip();
      this.panX += dx;
      this.panY += dy;
      // Track release velocity (px/ms, smoothed) so letting go throws the map.
      const now = performance.now();
      const dt = Math.max(1, now - this.dragVel.t);
      const blend = 0.4;
      this.dragVel = {
        x: this.dragVel.x * (1 - blend) + (dx / dt) * blend,
        y: this.dragVel.y * (1 - blend) + (dy / dt) * blend,
        t: now,
      };
      canvas.style.cursor = "grabbing";
      this.applyViewTransform();
    });

    const endPointer = (e: PointerEvent): void => {
      // A single finger/click lifted without dragging = a tap. Two taps in quick
      // succession at roughly the same spot recenters the map to the middle.
      const wasTap = !moved && pts.size === 1 && e.type === "pointerup";
      const wasDrag = moved && pts.size === 1 && e.type === "pointerup";
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
      if (pts.size === 0) {
        canvas.style.cursor = "";
        // A flick released within ~80ms of the last move keeps its momentum.
        if (wasDrag && performance.now() - this.dragVel.t < 80) this.startInertia();
      }
      if (wasTap) {
        const now = performance.now();
        const near =
          Math.hypot(e.clientX - this.lastTapPos.x, e.clientY - this.lastTapPos.y) < 30;
        if (now - this.lastTapTime < 350 && near) {
          this.lastTapTime = 0;
          this.animateRecenter();
        } else {
          this.lastTapTime = now;
          this.lastTapPos = { x: e.clientX, y: e.clientY };
        }
      }
      this.resetIdleTimer();
    };
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
    // Start the idle countdown immediately so an untouched map self-centres too.
    this.resetIdleTimer();
  }

  /** Reset zoom/pan to the fitted default. */
  resetView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    // Redraw at zoom 1 so geometry is baked sharp (also resets renderedZoom).
    if (this.last) this.render(this.last);
    else this.applyViewTransform();
  }

  /**
   * Recenter & refit the board to the CURRENT window size, discarding any
   * zoom/pan. Re-renders the last state so the fit transform is recomputed for
   * the live `app.screen` dimensions — used at game start (after the canvas has
   * settled to full-window size) so the map is always centered.
   */
  recenter(): void {
    this.syncSize();
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyViewTransform();
    if (this.last) this.render(this.last);
  }

  /**
   * Force the renderer (and so `app.screen`) to the live window size, then
   * re-fit. PixiJS's `resizeTo: window` applies its resize on the *next*
   * animation frame, so right after a window resize `app.screen` is still the
   * old size — recomputing the fit then centers the map for a canvas wider/
   * taller than what's actually visible, leaving it shoved to one side until
   * the window is maximized. Resizing synchronously here keeps the map centered
   * against the real viewport at every size (and on mobile address-bar shifts).
   */
  private syncSize(): void {
    this.ensureSize();
    if (this.last) this.render(this.last);
  }

  /**
   * Match the renderer (and so `app.screen`) to the live window size *without*
   * triggering a render. Called at the very top of `render()` so the fit is
   * always computed against the real viewport — Pixi's `resizeTo: window` only
   * applies on the next animation frame, so `app.screen` is otherwise stale
   * right after any window/layout change, which is what shoved the map to one
   * side until the window was maximized.
   */
  private ensureSize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w > 0 && h > 0 && (this.app.screen.width !== w || this.app.screen.height !== h)) {
      this.app.renderer.resize(w, h);
    }
  }

  /** Highlight a set of intersections (e.g. legal move destinations). */
  setHighlights(ids: string[]): void {
    this.highlightIds = new Set(ids);
    this.ensureHighlightFx();
    if (this.last) this.render(this.last);
  }

  clearHighlights(): void {
    if (this.highlightIds.size === 0 && this.selectedShipId === null) return;
    this.highlightIds.clear();
    this.selectedShipId = null;
    this.ensureHighlightFx();
    if (this.last) this.render(this.last);
  }

  /** Wipe the board (returning to a menu / lobby) so a finished game isn't left
   *  showing behind the next screen. */
  clear(): void {
    this.highlightIds.clear();
    this.selectedShipId = null;
    this.ambientItems.length = 0;
    this.root.removeChildren();
    this.last = null;
  }

  /**
   * Drive a single FX-overlay graphic that continuously pulses + glows a green
   * ring over every highlighted build site (e.g. where a colony/trade ship can
   * land). Runs only while there are highlights; tears itself down otherwise.
   */
  private ensureHighlightFx(): void {
    if (this.highlightIds.size === 0) {
      if (this.highlightTick) {
        this.app.ticker.remove(this.highlightTick);
        this.highlightTick = null;
      }
      if (this.highlightG) {
        this.highlightG.destroy();
        this.highlightG = null;
      }
      return;
    }
    if (this.highlightTick) return; // already animating
    const g = new Graphics();
    this.fx.addChild(g);
    this.highlightG = g;
    const tick = (): void => {
      if (!this.last || this.highlightIds.size === 0) {
        g.clear();
        return;
      }
      const s = this.fit.scale;
      const t = performance.now() / 1000;
      const pulse = 0.5 + 0.5 * Math.sin(t * 3.4); // 0..1 breathing
      g.clear();
      for (const id of this.highlightIds) {
        const inter = this.last.intersections[id];
        if (!inter) continue;
        // Project through the orientation rotation (fit works in ORIENTED space) so
        // the green rings land on the nodes in landscape, not at their unrotated
        // positions. The fx container applies zoom/pan, so stop before those.
        const o = this.ori(inter.x, inter.y);
        const cx = this.fit.ox + o.x * s;
        const cy = this.fit.oy + o.y * s;
        // A compact marker that gently breathes (kept small so it doesn't smother
        // the planet underneath).
        const base = s * 0.085;
        const r = base * (1 + 0.14 * pulse);
        // Soft outer glow that swells with the pulse.
        g.circle(cx, cy, r + s * 0.06 * pulse).fill({
          color: 0x57e389,
          alpha: 0.1 + 0.14 * pulse,
        });
        g.circle(cx, cy, r + s * 0.05).stroke({
          color: 0x57e389,
          width: 2,
          alpha: 0.45 + 0.45 * pulse,
        });
        // Bright core ring.
        g.circle(cx, cy, r)
          .fill({ color: 0x57e389, alpha: 0.24 })
          .stroke({ color: 0xbfffd9, width: 2.5 + 1.5 * pulse, alpha: 0.95 });
      }
    };
    this.app.ticker.add(tick);
    this.highlightTick = tick;
  }

  setSelectedShip(id: string | null): void {
    this.selectedShipId = id;
    if (this.last) this.render(this.last);
  }

  render(state: GameState): void {
    this.last = state;
    // Always fit against the live viewport: Pixi defers its resizeTo:window to
    // the next frame, so without this the map can be laid out for a stale
    // (larger) canvas and end up shoved off to one side.
    this.ensureSize();
    this.root.removeChildren();
    this.ambientItems.length = 0; // Z4: the new render re-registers its own

    const fit = this.computeTransform(state);
    this.fit = fit;
    // Bake the current zoom into the draw scale so text and strokes are drawn at
    // their true on-screen size (crisp), rather than up-scaled by the container.
    // `this.fit` stays unzoomed so worldToScreen / animations keep working.
    this.renderedZoom = this.zoom;
    const scale = fit.scale * this.zoom;
    const ox = fit.ox * this.zoom;
    const oy = fit.oy * this.zoom;
    // Orientation-aware projection: rotate raw board-space (bx,by) 90° when in
    // landscape, then apply the fit. Both axes are needed because a rotation
    // couples x and y. Labels are drawn upright at these positions (the rotation
    // moves positions only, never the text).
    const land = this.land;
    const tx = (bx: number, by: number): number => ox + (land ? -by : bx) * scale;
    const ty = (bx: number, by: number): number => oy + (land ? bx : by) * scale;

    const hexLayer = new Container();
    const linkLayer = new Container();
    const planetLayer = new Container();
    const highlightLayer = new Container();
    const nodeLayer = new Container();
    const buildLayer = new Container();
    const shipLayer = new Container();
    // #49: a top-most interaction layer for legal-target nodes. Pixi hit-tests
    // top-down, so putting a generous invisible hit-circle for each highlighted
    // intersection ABOVE the ships/buildings guarantees a green build/move node
    // always wins the click — even when a ship or colony sits on top of it.
    const targetHitLayer = new Container();
    this.root.addChild(linkLayer, hexLayer, planetLayer, highlightLayer, nodeLayer, buildLayer, shipLayer, targetHitLayer);

    // Flat-top hex outline at a pixel centre.
    const hexRot = land ? Math.PI / 2 : 0; // rotate hexes with the board so they still tile
    const drawHex = (cxp: number, cyp: number, fillColor: number, fillAlpha: number): void => {
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * 60 * i + hexRot;
        pts.push(cxp + scale * Math.cos(a), cyp + scale * Math.sin(a));
      }
      const hex = new Graphics()
        .poly(pts)
        .fill({ color: fillColor, alpha: fillAlpha })
        .stroke({ color: 0x2a3c5e, width: 1.5, alpha: 0.55 });
      hexLayer.addChild(hex);
    };

    // Sector hexes: each PLANET gets its own full hex; outposts/empties one hex.
    // (No mothership token on the board — the mothership is the physical shaker,
    // shown only in the left sidebar.)
    for (const sector of state.sectors) {
      if (sector.kind === "planetarySystem") {
        for (const planet of sector.planets) {
          drawHex(tx(planet.x, planet.y), ty(planet.x, planet.y), 0x101a30, 0.4);
        }
        continue;
      }
      const sqx = 1.5 * sector.q;
      const sqy = Math.sqrt(3) * (sector.r + sector.q / 2);
      const cx = tx(sqx, sqy);
      const cy = ty(sqx, sqy);
      if (sector.kind === "outpost") {
        // Outposts span the full 3-hex slot triangle: (q,r),(q+1,r),(q,r+1).
        const q = sector.q;
        const r = sector.r;
        const tri: [number, number][] = [[q, r], [q + 1, r], [q, r + 1]];
        for (const [hq, hr] of tri) {
          drawHex(tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)), ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)), 0x101a30, 0.4);
        }
        const charted = sector.discovered;
        if (!charted) {
          // Fog map: a disguised outpost looks exactly like an uncharted planetary
          // system — three blank "?" discs (P3). The civ underneath stays secret
          // until a ship reaches the triangle and charts it.
          const fogRad = scale * 0.6;
          for (const [hq, hr] of tri) {
            const dx = tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2));
            const dy = ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2));
            const disc = new Graphics()
              .circle(dx, dy, fogRad)
              .fill({ color: 0x141d33 })
              .stroke({ color: 0x4a6196, width: 2, alpha: 0.9 });
            planetLayer.addChild(disc);
            planetLayer.addChild(this.label("?", dx, dy, fogRad * 0.9, 0xaecaff, true));
            this.attachTip(
              disc,
              new Circle(dx, dy, fogRad),
              `<b>Unexplored sector</b><br>Fly a ship adjacent to chart it`,
            );
          }
          continue;
        }
        // Station sits at the triangle's shared centre corner.
        const ocx = tx(1.5 * q + 0.5, Math.sqrt(3) * (r + q / 2 + 0.5));
        const ocy = ty(1.5 * q + 0.5, Math.sqrt(3) * (r + q / 2 + 0.5));
        const civ = sector.outpostCiv ?? "";
        const style = CIV_STYLE[civ];
        const color = style?.color ?? 0xe8c24a;
        // AA6: the station now spans the whole 3-hex triangle — pass the three
        // hex centres so the lobes land exactly over their hexes.
        const lobePts = tri.map(([hq, hr]) => ({
          x: tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)),
          y: ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)),
        }));
        this.drawOutpost(planetLayer, ocx, ocy, lobePts, scale, color);
        this.drawCivIcon(planetLayer, ocx, ocy, scale * 1.5, civ, color);
        planetLayer.addChild(
          this.label(
            style?.name ?? "Outpost",
            ocx,
            ocy + scale * 0.72,
            10,
            style?.color ?? 0xe8d59a,
          ),
        );
        // Hover description for the outpost civ + its ability.
        const tip = style
          ? `<b>${style.name}</b><br>${style.ability}<br><i>Dock a trade ship for a friendship card &amp; marker (+2 VP)</i>`
          : `<b>Outpost</b><br>Dock a trade ship here`;
        const hot = new Graphics();
        planetLayer.addChild(hot);
        this.attachTip(hot, new Circle(ocx, ocy, scale * 0.55), tip);
        continue;
      }
      if (sector.kind === "emptyCluster") {
        // A discoverable cluster that turns out to be empty space (Q9). It spans
        // the full 3-hex triangle, like a planetary system / outpost.
        const q = sector.q;
        const r = sector.r;
        const tri: [number, number][] = [[q, r], [q + 1, r], [q, r + 1]];
        if (!sector.discovered) {
          // Fog: identical "???" discs to a disguised system/outpost — secret
          // until a ship charts it (and finds nothing). Draw the same hex fill
          // behind the discs as a disguised system/outpost, or the darker void
          // tint would give an empty cluster away before it's charted.
          const fogRad = scale * 0.6;
          for (const [hq, hr] of tri) {
            drawHex(tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)), ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)), 0x101a30, 0.4);
          }
          for (const [hq, hr] of tri) {
            const dx = tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2));
            const dy = ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2));
            const disc = new Graphics()
              .circle(dx, dy, fogRad)
              .fill({ color: 0x141d33 })
              .stroke({ color: 0x4a6196, width: 2, alpha: 0.9 });
            planetLayer.addChild(disc);
            planetLayer.addChild(this.label("?", dx, dy, fogRad * 0.9, 0xaecaff, true));
            this.attachTip(
              disc,
              new Circle(dx, dy, fogRad),
              `<b>Unexplored sector</b><br>Fly a ship adjacent to chart it`,
            );
          }
          continue;
        }
        // Charted (or normal mode): visibly-empty cluster — three faint hexes with
        // an "empty space" tint so the player can read it as a discoverable void.
        for (const [hq, hr] of tri) {
          const dx = tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2));
          const dy = ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2));
          drawHex(dx, dy, 0x0a1326, 0.3);
          const dot = new Graphics().circle(dx, dy, scale * 0.12).fill({ color: 0x2a3c5e, alpha: 0.6 });
          planetLayer.addChild(dot);
          this.attachTip(dot, new Circle(dx, dy, scale * 0.5), `<b>Empty space</b><br>No planets to colonise here`);
        }
        continue;
      }
      drawHex(cx, cy, sector.kind === "empty" ? 0x0a1326 : 0x101a30, sector.kind === "empty" ? 0.22 : 0.4);
    }

    // Travel links between intersections.
    const link = new Graphics();
    const drawn = new Set<string>();
    for (const inter of Object.values(state.intersections)) {
      for (const nId of inter.neighbors) {
        const key = inter.id < nId ? `${inter.id}|${nId}` : `${nId}|${inter.id}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        const n = state.intersections[nId];
        if (!n) continue;
        link.moveTo(tx(inter.x, inter.y), ty(inter.x, inter.y)).lineTo(tx(n.x, n.y), ty(n.x, n.y));
      }
    }
    link.stroke({ color: 0x39507a, width: 1, alpha: 0.5 });
    linkLayer.addChild(link);

    // Planets: coloured discs carrying the resource glyph + a number badge.
    for (const sector of state.sectors) {
      for (const planet of sector.planets) {
        const px = tx(planet.x, planet.y);
        const py = ty(planet.x, planet.y);
        const rad = scale * 0.6;
        // Fog map: an unexplored planet hides its resource colour entirely — it
        // reads as a blank "uncharted" disc with just an outline until a ship
        // reveals it (and the whole system) on arrival.
        const fill = planet.explored ? PLANET_FILL[planet.color] : 0x141d33;
        // Z4: deterministic per-planet phase/speed (from its position) so the
        // ambient motion is stable across re-renders — no RNG, no popping.
        const phase = (px * 0.013 + py * 0.029) % (Math.PI * 2);
        const speed = 0.75 + ((Math.abs(px * 7 + py * 13) % 100) / 100) * 0.6;
        if (planet.explored) {
          // Soft glow halo so planets read against the starfield — Z4 makes it
          // breathe gently (the ticker scales this Graphics' alpha).
          const halo = new Graphics().circle(px, py, rad * 1.25).fill({ color: fill, alpha: 0.18 });
          planetLayer.addChild(halo);
          this.ambientItems.push({ g: halo, kind: "halo", x: px, y: py, rad, phase, speed });
        }
        const disc = new Graphics()
          .circle(px, py, rad)
          .fill({ color: fill })
          .stroke({
            color: planet.explored ? 0x05060f : 0x4a6196,
            width: 2,
            alpha: planet.explored ? 0.7 : 0.9,
          });
        // A lighter top arc gives the disc a spherical sheen.
        if (planet.explored) {
          disc
            .circle(px - rad * 0.28, py - rad * 0.3, rad * 0.5)
            .fill({ color: 0xffffff, alpha: 0.12 });
        }
        planetLayer.addChild(disc);

        // Hover description for this planet / special token.
        let tip: string;
        if (!planet.explored) {
          // Same wording as every other uncharted sector so the fog gives no hint
          // whether this is a planet, an outpost, or empty space.
          tip = `<b>Unexplored sector</b><br>Fly a ship adjacent to chart it`;
        } else if (planet.special === "pirateBase") {
          tip = `<b>Pirate Base</b><br>Beat it with ${planet.specialValue}+ cannons to win a fame medal (+1 VP)`;
        } else if (planet.special === "icePlanet") {
          tip = `<b>Ice Planet</b><br>Terraform with ≥ ${planet.specialValue} freight pods for a fame medal (+1 VP)`;
        } else {
          const res = PLANET_RESOURCE[planet.color];
          // R5: the production number already shows as a chip on the disc, so the
          // tooltip just names what the planet produces (no redundant number).
          tip = `<b>${RESOURCE_NAME[res]} planet</b><br>Produces ${RESOURCE_NAME[res]}`;
        }
        this.attachTip(disc, new Circle(px, py, rad), tip);

        // Resource glyph (PDF-style): ore=hexagon, carbon=subdivided triangle, etc.
        if (planet.explored) {
          this.drawResourceGlyph(planetLayer, PLANET_RESOURCE[planet.color], px, py, rad * 0.62);
          // Z4: a tiny mote orbiting the planet on a tilted ellipse — dims on
          // the far half. Skipped on pirate/ice tokens to keep them readable.
          if (planet.special === "none") {
            const mote = new Graphics()
              .circle(0, 0, Math.max(1.4, rad * 0.08))
              .fill({ color: 0xdfe9ff, alpha: 0.85 });
            mote.position.set(px + rad * 1.32, py);
            planetLayer.addChild(mote);
            this.ambientItems.push({ g: mote, kind: "mote", x: px, y: py, rad, phase: phase * 1.7 + 1, speed });
          }
        } else {
          // Face-down planet: a featureless disc with a "?". Uses the exact same
          // "?" colour as a disguised outpost so the two are indistinguishable
          // under the fog (P6a).
          planetLayer.addChild(this.label("?", px, py, rad * 0.9, 0xaecaff, true));
        }

        // Pirate base / ice planet token overlay with its threshold — hidden
        // under the fog until the planet is charted (P3).
        if (planet.explored && planet.special !== "none") {
          const isPirate = planet.special === "pirateBase";
          // #11: keep the token translucent (~20%) so the resource planet hidden
          // beneath it stays visible until the token is cleared, as on the board.
          const token = new Graphics()
            .circle(px, py, rad * 0.92)
            .fill({ color: isPirate ? 0x2a0a0a : 0x0a2a33, alpha: 0.2 })
            .stroke({ color: isPirate ? 0xff5a4d : 0x7fe0ff, width: 2 });
          planetLayer.addChild(token);
          // Z4: the threat token smolders — a slow menacing alpha pulse.
          this.ambientItems.push({ g: token, kind: "special", x: px, y: py, rad, phase, speed });
          planetLayer.addChild(
            this.label(isPirate ? "☠" : "❄", px, py - rad * 0.12, rad * 0.8, isPirate ? 0xff7a6d : 0xbdefff, true),
          );
          if (planet.specialValue != null) {
            planetLayer.addChild(
              this.label(String(planet.specialValue), px, py + rad * 0.45, rad * 0.5, 0xeaf0ff, true),
            );
          }
        }

        // Number badge: dark chip pinned to the planet's lower edge. Shown for
        // special (pirate/ice) planets too (#11) so the production number under
        // the translucent token is visible before it's cleared.
        if (planet.explored && planet.number != null) {
          const hot = planet.number === 6 || planet.number === 8;
          const bx = px;
          // Production number sits at the TOP of the planet (above centre).
          const by = py - rad * 0.86;
          // 2 also produces on 11, and 3 also on 12 — show the pair on the token.
          const numText =
            planet.number === 2 ? "2/11" : planet.number === 3 ? "3/12" : String(planet.number);
          const wide = numText.length > 2;
          const br = rad * (wide ? 0.66 : 0.52);
          planetLayer.addChild(
            new Graphics()
              .circle(bx, by, br)
              .fill({ color: 0x0a0f1e, alpha: 0.92 })
              .stroke({ color: hot ? 0xff5a4d : 0x8aa0c8, width: 1.5, alpha: 0.9 }),
          );
          planetLayer.addChild(
            this.label(numText, bx, by, br * (wide ? 0.82 : 1.05), hot ? 0xff7a6d : 0xeaf0ff, true),
          );
        }
      }
    }

    // Intersections: small nodes; colony sites (>=2 adjacent planets) highlighted.
    // Fog gating: a colony site / docking point only reveals its role once the
    // underlying sector is charted — otherwise it draws as a plain travel node so
    // uncharted systems, outposts and empty space look identical (no hint leak).
    const exploredPlanets = new Set<string>();
    const homePlanets = new Set<string>();
    for (const s of state.sectors) for (const p of s.planets) {
      if (p.explored) exploredPlanets.add(p.id);
      if (s.home) homePlanets.add(p.id);
    }
    const sectorById = new Map(state.sectors.map((s) => [s.id, s]));
    // #61: the blue colony-site rings on the Home Planets are only useful during
    // the set-up placement; once set-up is over they just clutter the home row,
    // so they revert to plain travel nodes there (kept everywhere else).
    const afterSetup = state.phaseState.phase !== "setup";
    for (const inter of Object.values(state.intersections)) {
      const ix = tx(inter.x, inter.y);
      const iy = ty(inter.x, inter.y);
      const dockSector = inter.dockingPointOf ? sectorById.get(inter.dockingPointOf) : undefined;
      // Charted once either adjacent planet is revealed (colony) / the outpost
      // sector is discovered (dock). In non-fog games everything is charted, so
      // behaviour is unchanged.
      const onHomeOnly =
        inter.adjacentPlanets.length > 0 && inter.adjacentPlanets.every((id) => homePlanets.has(id));
      const isColonySite =
        inter.adjacentPlanets.length === 2 &&
        inter.adjacentPlanets.some((id) => exploredPlanets.has(id)) &&
        !(onHomeOnly && afterSetup);
      const isDock = !!dockSector && dockSector.discovered;

      // Legal-target rings (move destinations / colony picks) are drawn as a
      // continuously pulsing/glowing marker on the FX overlay — see
      // ensureHighlightFx(). Nothing static is painted here.

      const node = new Graphics().circle(ix, iy, isColonySite ? scale * 0.06 : scale * 0.035);
      node.fill({
        color: isColonySite ? 0x8fd0ff : isDock ? 0xe8d59a : 0x6b7da0,
        alpha: isColonySite || isDock ? 0.9 : 0.5,
      });
      // Interactive hit area (generous) so the HUD can drive board selection.
      // Pad with a constant ~0.6cm so finger taps near (not dead-on) the point
      // still register on touch screens, even when the board is zoomed out.
      node.eventMode = "static";
      node.cursor = "pointer";
      node.hitArea = new Circle(ix, iy, scale * 0.16 + 22);
      const id = inter.id;
      node.on("pointertap", () => this.onIntersectionClick?.(id));
      // Hover description (colony sites / docking points are the meaningful ones).
      if (isColonySite || isDock) {
        const civStyle = dockSector?.outpostCiv ? CIV_STYLE[dockSector.outpostCiv] : undefined;
        const tip = isColonySite
          ? `<b>Colony site</b><br>Land a colony ship here to settle (+1 VP).<br>It sits between two planets and collects from both.`
          : civStyle
            ? `<b>${civStyle.name} — docking point</b><br>${civStyle.ability}<br><i>Dock a trade ship to build a trade station (+1 VP) &amp; earn its friendship card</i>`
            : `<b>Docking point</b><br>Land a trade ship here to build a trade station (+1 VP) and earn a friendship card.`;
        // Route through showTip so the 👁 hover-info toggle (tooltipsSuppressed)
        // and the auto-dismiss timer apply here too — this path used to bypass
        // both and kept showing "Colony site" with hover info switched off.
        node.on("pointerover", () => this.showTip(tip, false));
        node.on("pointerout", () => this.tooltipEl.classList.remove("show"));
      }
      nodeLayer.addChild(node);
    }

    // Buildings: colonies (square) and spaceports (larger ringed square) by owner.
    const ownerColor = new Map<string, PlayerColor>(state.players.map((p) => [p.id, p.color]));
    for (const b of state.buildings) {
      const inter = state.intersections[b.intersectionId];
      if (!inter) continue;
      const bx = tx(inter.x, inter.y);
      const by = ty(inter.x, inter.y);
      const pc = ownerColor.get(b.owner) ?? "yellow";
      const color = OWNER_FILL[pc];
      // Q1: colony & spaceport icons enlarged ~200% so they read clearly.
      const s = b.kind === "spaceport" ? scale * 0.36 : scale * 0.26;
      const g = new Graphics();
      if (b.kind === "spaceport") this.drawSpaceport(g, bx, by, s, color);
      else this.drawColony(g, bx, by, s, color);
      buildLayer.addChild(g);

      const mine = b.owner === this.humanId;
      const name = b.kind === "spaceport" ? "Spaceport" : "Colony";
      const vp = b.kind === "spaceport" ? 2 : 1;
      const extra =
        b.kind === "colony"
          ? "<br><i>Upgrade to a spaceport to build & launch ships here</i>"
          : "<br><i>Build colony / trade ships from here</i>";
      const tip = `<b>${OWNER_NAME[pc]} ${name}</b>${mine ? " <i>(yours)</i>" : ""}<br>Worth ${vp} VP${extra}`;
      const hot = new Graphics();
      buildLayer.addChild(hot);
      this.attachTip(hot, new Circle(bx, by, s * 1.4), tip);
      // The tooltip overlay sits above the node layer; forward taps so clicking a
      // building still drives intersection selection (e.g. colony→spaceport upgrade).
      hot.cursor = "pointer";
      const bid = b.intersectionId;
      hot.on("pointertap", () => this.onIntersectionClick?.(bid));
    }

    // The three (orientation-rotated) lobe hex-centres of an outpost — the same
    // points drawOutpost paints its docking rings on. Shared by the station pips
    // and the docked-ship placement so both land exactly on the painted docks.
    const outpostLobesFor = (q: number, r: number): { x: number; y: number }[] =>
      ([[q, r], [q + 1, r], [q, r + 1]] as [number, number][]).map(([hq, hr]) => ({
        x: tx(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)),
        y: ty(1.5 * hq, Math.sqrt(3) * (hr + hq / 2)),
      }));

    // Trade stations: owner-coloured pips arranged around each outpost centre.
    for (const sector of state.sectors) {
      if (sector.kind !== "outpost") continue;
      const ocx = tx(1.5 * sector.q + 0.5, Math.sqrt(3) * (sector.r + sector.q / 2 + 0.5));
      const ocy = ty(1.5 * sector.q + 0.5, Math.sqrt(3) * (sector.r + sector.q / 2 + 0.5));
      const dockPos = this.dockNodePositions(ocx, ocy, scale, outpostLobesFor(sector.q, sector.r));
      for (const ts of state.tradeStations.filter((t) => t.outpostId === sector.id)) {
        const pos = dockPos[ts.dock % dockPos.length]!;
        const sx = pos.x;
        const sy = pos.y;
        // Q3: established-player markers inside an outpost drawn ~300% bigger so
        // it's obvious who is docked there.
        buildLayer.addChild(
          new Graphics()
            .circle(sx, sy, scale * 0.16)
            .fill({ color: OWNER_FILL[ownerColor.get(ts.owner) ?? "yellow"] })
            .stroke({ color: 0xffffff, width: 2.5 }),
        );
      }
    }

    // Ships: clickable rocket tokens at their intersections.
    // Flight cue: on my turn, after shaking, with no encounter pending, my ships
    // that still have movement left breathe a green ring so it's clearly time to
    // fly. (Only the active human — spectators/AI turns don't pulse.)
    const ps = state.phaseState;
    const myFlight =
      ps.phase === "flight" && !!ps.shake && !ps.encounter &&
      state.players[ps.activePlayerIndex]?.id === this.humanId;
    const flightSpeed = ps.shake?.speed ?? 0;

    for (const ship of state.ships) {
      const inter = state.intersections[ship.intersectionId];
      if (!inter) continue;
      let sx = tx(inter.x, inter.y);
      let sy = ty(inter.x, inter.y);
      // P8-7 fix: a ship parked on an outpost docking point sits on a docking
      // *node*, not the hub centre — it takes the next free dock (one past the
      // stations already established there), matching the painted nodes.
      if (inter.dockingPointOf) {
        const op = sectorById.get(inter.dockingPointOf);
        // Centre the dock ring on the OUTPOST hub (sx/sy is the ship's own node,
        // which IS the hub centre), using the outpost's real lobes.
        const dockPos = op
          ? this.dockNodePositions(sx, sy, scale, outpostLobesFor(op.q, op.r))
          : [];
        const taken = state.tradeStations.filter((t) => t.outpostId === inter.dockingPointOf).length;
        const node = dockPos.length ? dockPos[taken % dockPos.length]! : { x: sx, y: sy };
        sx = node.x;
        sy = node.y;
      }
      const pc = ownerColor.get(ship.owner) ?? "yellow";
      // #54: a ship damaged in an encounter (frozen for the turn) keeps its
      // OWNER colour (so it's never confused with the red player's ships) and is
      // marked instead with a distinct cyan "frozen" ring — a colour no player
      // can pick.
      const FROZEN_CYAN = 0x49e0ff;
      const damaged = ship.id === state.phaseState.frozenShipId;
      // P8-7: ships parked on an outpost docking point are drawn larger so
      // players can clearly see who is established inside the outpost.
      const onDock = !!inter.dockingPointOf;
      const color = OWNER_FILL[pc];
      // Q1: ships in general a bit larger; Q3: ships docked inside an outpost
      // drawn bigger so the occupant is unmistakable. Travelling ships are
      // doubled (0.2 → 0.4) so colony/trade ships read clearly on the map.
      const r = scale * (onDock ? 0.55 : 0.4);
      const selected = ship.id === this.selectedShipId;
      const g = new Graphics();
      if (selected) g.circle(sx, sy, r * 1.5).stroke({ color: 0x57e389, width: 3, alpha: 0.95 });
      if (damaged) g.circle(sx, sy, r * 1.5).stroke({ color: FROZEN_CYAN, width: 3, alpha: 0.95 });
      this.drawShip(g, ship.kind, sx, sy, r, color);
      g.eventMode = "static";
      // #55: a damaged (frozen) ship can't move, so clicking it must do NOTHING
      // (previously it spawned green move-nodes everywhere and only errored on a
      // move attempt). It keeps its hover tooltip but no click/select.
      g.cursor = damaged ? "default" : "pointer";
      g.hitArea = new Circle(sx, sy, r * 1.4 + 22);
      const id = ship.id;
      if (!damaged) g.on("pointertap", () => this.onShipClick?.(id));
      shipLayer.addChild(g);

      // Flight cue: breathe a green ring around my ships that can still move,
      // so it's obvious it's time to fly. Not the selected ship (it has its own
      // ring) or a frozen/damaged one.
      if (
        myFlight && ship.owner === this.humanId && !damaged && !selected &&
        ship.id !== ps.frozenShipId && ship.distanceMoved < flightSpeed
      ) {
        const ring = new Graphics().circle(0, 0, r * 1.45).stroke({ color: 0x7cffb0, width: 3, alpha: 0.9 });
        ring.position.set(sx, sy);
        shipLayer.addChild(ring);
        this.ambientItems.push({ g: ring, kind: "pulse", x: sx, y: sy, rad: r, phase: (sx * 0.03 + sy * 0.05) % 6.28, speed: 1 });
      }

      const mine = ship.owner === this.humanId;
      const owner = OWNER_NAME[pc];
      const kindName = ship.kind === "colonyShip" ? "Colony Ship" : "Trade Ship";
      const purpose =
        ship.kind === "colonyShip"
          ? "Fly it to an empty colony site, then establish a colony (+1 VP)"
          : "Fly it to an outpost docking point, then establish a trade station (+1 VP &amp; a friendship card)";
      const tip = damaged
        ? `<b>${owner} ${kindName}</b>${mine ? " <i>(yours)</i>" : ""}<br><b style="color:#ff6b60">Damaged — cannot move this turn</b>`
        : `<b>${owner} ${kindName}</b>${mine ? " <i>(yours)</i>" : ""}<br>${purpose}`;
      const hot = new Graphics();
      shipLayer.addChild(hot);
      this.attachTip(hot, new Circle(sx, sy, r * 1.4), tip);
      // The tooltip overlay sits above the ship graphic; forward taps so clicking
      // a ship still drives ship selection (move / establish flows).
      hot.cursor = "pointer";
      hot.on("pointertap", () => this.onShipClick?.(id));
    }

    // #49: top-priority click targets for every highlighted legal node. Invisible
    // but interactive, with a generous radius (constant pad so it stays tappable
    // when zoomed out), drawn last so it out-ranks any ship/colony sitting on the
    // same intersection.
    for (const id of this.highlightIds) {
      const inter = state.intersections[id];
      if (!inter) continue;
      const hx = tx(inter.x, inter.y);
      const hy = ty(inter.x, inter.y);
      const hit = new Graphics().circle(hx, hy, scale * 0.16 + 26).fill({ color: 0x000000, alpha: 0.001 });
      hit.eventMode = "static";
      hit.cursor = "pointer";
      hit.hitArea = new Circle(hx, hy, scale * 0.16 + 26);
      hit.on("pointertap", () => this.onIntersectionClick?.(id));
      targetHitLayer.addChild(hit);
    }

    // Sync the view transform: zoom is now baked into the geometry above, so the
    // container scale resets to 1 (renderedZoom === zoom) and only pan applies.
    this.applyViewTransform();
    this.detectBuilds(state, ownerColor);
    this.detectMoves(state, ownerColor);
  }

  /**
   * Q2: diff ship positions vs. the previous render and animate a glowing comet +
   * fading trail from the old position to the new one, so it's clear which ship
   * moved (works for human AND AI moves, regardless of the multi-step path).
   */
  private detectMoves(state: GameState, ownerColor: Map<string, PlayerColor>): void {
    const now = new Map<string, { x: number; y: number; color: number }>();
    for (const s of state.ships) {
      const inter = state.intersections[s.intersectionId];
      if (!inter) continue;
      const color = OWNER_FILL[ownerColor.get(s.owner) ?? "yellow"];
      now.set(s.id, { x: inter.x, y: inter.y, color });
    }
    if (this.shipPosInit) {
      for (const [id, p] of now) {
        const prev = this.prevShipPos.get(id);
        if (prev && (Math.abs(prev.x - p.x) > 1e-6 || Math.abs(prev.y - p.y) > 1e-6)) {
          this.spawnMoveTrail(prev.x, prev.y, p.x, p.y, p.color);
        }
      }
    }
    this.prevShipPos = now;
    this.shipPosInit = true;
  }

  /** Glowing comet that arcs along a curved, fading trail from (fx,fy)→(tx,ty),
   *  board-space. The path is a quadratic bezier lifted perpendicular to the
   *  flight line, with an eased head, a tapering multi-segment tail, and a soft
   *  pulsing glow — so moves read as graceful orbits rather than straight slides. */
  private spawnMoveTrail(fx: number, fy: number, tx: number, ty: number, color: number): void {
    const trail = new Graphics();
    const comet = new Graphics();
    this.fx.addChild(trail, comet);
    const start = performance.now();
    const dur = 820;
    const toScreen = (x: number, y: number): { x: number; y: number } => ({
      x: this.fit.ox + x * this.fit.scale,
      y: this.fit.oy + y * this.fit.scale,
    });
    const a = toScreen(fx, fy);
    const b = toScreen(tx, ty);
    const s = this.fit.scale;
    // Control point: midpoint lifted perpendicular to the path (~18% of length).
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const lift = Math.min(len * 0.18, s * 0.9);
    const cp = {
      x: (a.x + b.x) / 2 + (-(b.y - a.y) / len) * lift,
      y: (a.y + b.y) / 2 + ((b.x - a.x) / len) * lift,
    };
    const along = (u: number): { x: number; y: number } => {
      const v = 1 - u;
      return {
        x: v * v * a.x + 2 * v * u * cp.x + u * u * b.x,
        y: v * v * a.y + 2 * v * u * cp.y + u * u * b.y,
      };
    };
    // Smooth ease-in-out so the ship accelerates away and brakes on arrival.
    const ease = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    const tick = (): void => {
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        this.app.ticker.remove(tick);
        trail.destroy();
        comet.destroy();
        return;
      }
      const e = ease(t);
      const head = along(e);
      // Tapering tail: a few segments behind the head, thinner + fainter rearward.
      trail.clear();
      const SEGS = 7;
      for (let i = 0; i < SEGS; i++) {
        const u0 = Math.max(0, e - 0.32 + (0.32 * i) / SEGS);
        const u1 = Math.max(0, e - 0.32 + (0.32 * (i + 1)) / SEGS);
        if (u1 <= u0) continue;
        const p0 = along(u0);
        const p1 = along(u1);
        const f = (i + 1) / SEGS; // 0 rear → 1 at the head
        trail
          .moveTo(p0.x, p0.y)
          .lineTo(p1.x, p1.y)
          .stroke({ color, width: Math.max(1.2, s * 0.1 * f), alpha: 0.55 * f * (1 - t * 0.6) });
      }
      // Comet head with a soft pulsing halo.
      const pulse = 1 + 0.18 * Math.sin(t * Math.PI * 6);
      comet.clear();
      comet.circle(head.x, head.y, s * 0.3 * pulse).fill({ color, alpha: 0.12 });
      comet.circle(head.x, head.y, s * 0.12).fill({ color, alpha: 0.95 });
      comet.circle(head.x, head.y, s * 0.2 * pulse).stroke({ color: 0xffffff, width: 2, alpha: 0.55 * (1 - t) });
    };
    this.app.ticker.add(tick);
  }

  /** Diff pieces vs. last render; pulse a ring at anything newly built. */
  private detectBuilds(state: GameState, ownerColor: Map<string, PlayerColor>): void {
    const now = new Map<string, { x: number; y: number; color: number }>();
    const add = (key: string, x: number, y: number, owner: string): void => {
      now.set(key, { x, y, color: OWNER_FILL[ownerColor.get(owner) ?? "yellow"] });
    };
    for (const b of state.buildings) {
      const inter = state.intersections[b.intersectionId];
      if (inter) add(`b:${b.kind}@${b.intersectionId}`, inter.x, inter.y, b.owner);
    }
    for (const s of state.ships) {
      const inter = state.intersections[s.intersectionId];
      if (inter) add(`s:${s.id}`, inter.x, inter.y, s.owner);
    }
    for (const sector of state.sectors) {
      if (sector.kind !== "outpost") continue;
      const ox = 1.5 * sector.q;
      const oy = Math.sqrt(3) * (sector.r + sector.q / 2);
      for (const ts of state.tradeStations.filter((t) => t.outpostId === sector.id)) {
        add(`t:${ts.owner}@${ts.outpostId}#${ts.dock}`, ox, oy, ts.owner);
      }
    }

    if (this.piecesInit) {
      for (const [key, p] of now) {
        if (!this.prevPieces.has(key)) this.spawnBuildFx(p.x, p.y, p.color);
      }
    }
    this.prevPieces = new Set(now.keys());
    this.piecesInit = true;
  }

  /** AA1: when production dice land, every planet whose number pays on this
   *  roll pulses once — a gold ring ripple + soft flash over the disc, so the
   *  table can see at a glance where this turn's resources came from. */
  pulseRolledNumber(rolled: number): void {
    const state = this.last;
    if (!state || rolled === 7) return;
    for (const sector of state.sectors) {
      for (const planet of sector.planets) {
        if (!planet.explored || planet.special !== "none" || planet.number == null) continue;
        // 2 also pays on 11 and 3 on 12 (the printed two-number chips).
        const pays =
          planet.number === rolled ||
          (planet.number === 2 && rolled === 11) ||
          (planet.number === 3 && rolled === 12);
        if (pays) this.spawnNumberPulse(planet.x, planet.y);
      }
    }
  }

  private spawnNumberPulse(bx: number, by: number): void {
    const cx = this.fit.ox + bx * this.fit.scale;
    const cy = this.fit.oy + by * this.fit.scale;
    const s = this.fit.scale;
    const g = new Graphics();
    this.fx.addChild(g);
    const start = performance.now();
    const dur = 900;
    const tick = (): void => {
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        this.app.ticker.remove(tick);
        g.destroy();
        return;
      }
      const e = 1 - Math.pow(1 - t, 3);
      g.clear();
      g.circle(cx, cy, s * (0.64 + e * 0.5))
        .stroke({ color: 0xffd23f, width: 4 * (1 - t) + 1, alpha: 0.9 * (1 - t) });
      g.circle(cx, cy, s * 0.62).fill({ color: 0xffd23f, alpha: 0.2 * (1 - t) });
    };
    this.app.ticker.add(tick);
  }

  /** Expanding owner-coloured rings + sparkle burst at a board position
   *  (fit-space): a double ripple plus a handful of radiating sparks, so a new
   *  piece lands with a satisfying pop instead of a single thin ring. */
  private spawnBuildFx(bx: number, by: number, color: number): void {
    const cx = this.fit.ox + bx * this.fit.scale;
    const cy = this.fit.oy + by * this.fit.scale;
    const s = this.fit.scale;
    const ring = new Graphics();
    this.fx.addChild(ring);
    const start = performance.now();
    const dur = 950;
    // Deterministic spark fan (no Math.random — same burst every time, by design).
    const SPARKS = 8;
    const tick = (): void => {
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        this.app.ticker.remove(tick);
        ring.destroy();
        return;
      }
      const e = 1 - Math.pow(1 - t, 3); // ease-out cubic
      ring.clear();
      // Primary ripple.
      ring
        .circle(cx, cy, s * (0.12 + e * 0.55))
        .stroke({ color, width: 5 * (1 - t) + 1, alpha: 1 - t });
      // Trailing second ripple, slightly delayed.
      const t2 = Math.max(0, t - 0.18) / 0.82;
      const e2 = 1 - Math.pow(1 - t2, 3);
      if (t2 > 0) {
        ring
          .circle(cx, cy, s * (0.1 + e2 * 0.85))
          .stroke({ color: 0xffffff, width: 2.5 * (1 - t2), alpha: 0.65 * (1 - t2) });
      }
      // Radiating sparks that fly out and fade.
      for (let i = 0; i < SPARKS; i++) {
        const ang = (Math.PI * 2 * i) / SPARKS + 0.4;
        const d = s * (0.2 + e * 0.75);
        const px = cx + Math.cos(ang) * d;
        const py = cy + Math.sin(ang) * d;
        ring.circle(px, py, Math.max(1, s * 0.045 * (1 - t))).fill({ color, alpha: 0.8 * (1 - t) });
      }
      // Soft centre glow.
      ring.circle(cx, cy, s * 0.2).fill({ color, alpha: 0.45 * (1 - t) });
    };
    this.app.ticker.add(tick);
  }

  /**
   * Full-colour resource glyph centred at (x,y), sized to radius r — the
   * redesigned sci-fi set, matching the HUD card glyphs 1:1 (the SVG designs
   * are literally coordinate-ported here):
   *   ore = molten asteroid · fuel = energy cell · carbon = molecule lattice
   *   food = hydroponic sprout · goods = sealed cargo case
   */
  private drawResourceGlyph(layer: Container, res: Resource, x: number, y: number, r: number): void {
    const ink = 0x0a0f1e;
    const g = new Graphics();
    // Port helpers from the 24x24 SVG space: per-glyph scale k + centre line cy.
    const port = (k: number, cy: number) => ({
      X: (px: number): number => x + (px - 12) * k,
      Y: (py: number): number => y + (py - cy) * k,
      P: (pts: number[]): number[] => pts.map((v, i) => (i % 2 === 0 ? x + (v - 12) * k : y + (v - cy) * k)),
      k,
    });
    switch (res) {
      case "carbon": {
        // Graphene molecule: three fused hexagon rings + bright atom nodes.
        const { X, Y, P, k } = port(r / 6.5, 10.3);
        g.poly(P([12, 4, 15.1, 5.8, 15.1, 9.4, 12, 11.2, 8.9, 9.4, 8.9, 5.8]))
          .fill({ color: 0x57b6f0, alpha: 0.2 })
          .stroke({ color: 0x57b6f0, width: Math.max(1, k * 1.1) });
        g.poly(P([8.9, 9.4, 12, 11.2, 12, 14.8, 8.9, 16.6, 5.8, 14.8, 5.8, 11.2]))
          .fill({ color: 0x2f7fd6, alpha: 0.16 })
          .stroke({ color: 0x3f97e4, width: Math.max(1, k * 1.1) });
        g.poly(P([15.1, 9.4, 18.2, 11.2, 18.2, 14.8, 15.1, 16.6, 12, 14.8, 12, 11.2]))
          .fill({ color: 0x2f7fd6, alpha: 0.16 })
          .stroke({ color: 0x3f97e4, width: Math.max(1, k * 1.1) });
        g.circle(X(12), Y(11.2), k * 1.5).fill({ color: 0xdff4ff });
        for (const [nx, ny] of [[8.9, 9.4], [15.1, 9.4], [12, 14.8]]) {
          g.circle(X(nx!), Y(ny!), k * 1.1).fill({ color: 0xbfe9ff });
        }
        for (const [nx, ny] of [[12, 4], [5.8, 14.8], [18.2, 14.8]]) {
          g.circle(X(nx!), Y(ny!), k * 0.8).fill({ color: 0x8fd2ff });
        }
        break;
      }
      case "fuel": {
        // Energy cell: capsule with a dark window of glowing propellant + bolt.
        const { X, Y, P, k } = port(r / 8.5, 10.8);
        g.rect(X(10.9), Y(2.2), k * 2.2, k * 1.8).fill({ color: 0xa06c14 }).stroke({ color: ink, width: 0.8 });
        g.roundRect(X(9.2), Y(3.8), k * 5.6, k * 2.6, k).fill({ color: 0xf6c659 }).stroke({ color: ink, width: 1 });
        g.roundRect(X(7.8), Y(6.2), k * 8.4, k * 13.2, k * 2.6).fill({ color: 0xb97e1f }).stroke({ color: ink, width: 1.2 });
        g.roundRect(X(9.5), Y(8), k * 5, k * 9.6, k * 1.8).fill({ color: 0x241806 }).stroke({ color: ink, width: 0.8 });
        g.roundRect(X(9.5), Y(11.8), k * 5, k * 5.8, k * 1.8).fill({ color: 0xffc34d });
        g.circle(X(11), Y(13.6), k * 0.6).fill({ color: 0xffe7ab });
        g.circle(X(13), Y(15.6), k * 0.5).fill({ color: 0xffe7ab });
        g.poly(P([12.7, 8.7, 10.9, 11.6, 12.2, 11.6, 11.3, 14, 13.8, 10.7, 12.4, 10.7])).fill({ color: 0xffe7ab });
        break;
      }
      case "food": {
        // Hydroponic sprout: glass dome arc, twin leaves, soil basin.
        const { X, Y, P, k } = port(r / 8, 13.3);
        g.moveTo(X(4.8), Y(14)).arc(X(12), Y(14), k * 7.2, Math.PI, 0).stroke({ color: 0x8fd66f, width: Math.max(1, k * 0.9), alpha: 0.8 });
        this.strokeLine(g, X(12), Y(16.2), X(12), Y(8.4), Math.max(1.2, k * 1.6), 0x3f8f30, 1);
        g.moveTo(X(12), Y(12.4))
          .bezierCurveTo(X(9.2), Y(12), X(7.4), Y(10), X(7.6), Y(7.4))
          .bezierCurveTo(X(10.4), Y(7.8), X(11.9), Y(9.8), X(12), Y(12.4))
          .closePath()
          .fill({ color: 0x57c244 })
          .stroke({ color: ink, width: 0.8 });
        g.moveTo(X(12), Y(10))
          .bezierCurveTo(X(14.8), Y(9.6), X(16.5), Y(7.7), X(16.4), Y(5.2))
          .bezierCurveTo(X(13.6), Y(5.6), X(12.1), Y(7.5), X(12), Y(10))
          .closePath()
          .fill({ color: 0x7ad862 })
          .stroke({ color: ink, width: 0.8 });
        g.ellipse(X(12), Y(16.2), k * 5.2, k * 1.2).fill({ color: 0x5a3d22 }).stroke({ color: ink, width: 0.8 });
        g.poly(P([6.8, 16.4, 17.2, 16.4, 15.6, 20.6, 13.6, 21.4, 10.4, 21.4, 8.4, 20.6])).fill({ color: 0x2f7325 }).stroke({ color: ink, width: 1 });
        break;
      }
      case "ore": {
        // Molten asteroid: faceted rock split by glowing magma fissures.
        const { X, Y, P, k } = port(r / 8, 11.8);
        g.poly(P([4, 13, 7, 5.6, 14, 4, 20.4, 9.6, 18.6, 17.6, 9, 19.6])).fill({ color: 0xa32a28 }).stroke({ color: ink, width: 1.2 });
        g.poly(P([7, 5.6, 14, 4, 12.6, 9.2, 8.2, 10])).fill({ color: 0xd6504c, alpha: 0.9 });
        g.poly(P([9, 19.6, 18.6, 17.6, 17.2, 13.4, 10.4, 14.6])).fill({ color: 0x6e1a19, alpha: 0.8 });
        const crack = [[6.6, 12.6], [10.2, 11.2], [12.6, 13.6], [16.2, 12], [18, 14.2]] as const;
        for (let i = 0; i < crack.length - 1; i++) {
          this.strokeLine(g, X(crack[i]![0]), Y(crack[i]![1]), X(crack[i + 1]![0]), Y(crack[i + 1]![1]), Math.max(1.2, k * 1.3), 0xffb054, 1);
        }
        this.strokeLine(g, X(10.2), Y(11.2), X(9.6), Y(15.6), Math.max(1, k), 0xff7d3e, 1);
        g.circle(X(16.2), Y(12), k * 0.9).fill({ color: 0xffd28a });
        g.circle(X(6.6), Y(12.6), k * 0.7).fill({ color: 0xffd28a, alpha: 0.8 });
        break;
      }
      case "goods": {
        // Sealed cargo case: straps, carry handle and a glowing diamond seal.
        const { X, Y, P, k } = port(r / 7.5, 11);
        g.moveTo(X(9.5), Y(7)).arc(X(12), Y(6.4), k * 2.5, Math.PI, 0).stroke({ color: 0xe3b341, width: Math.max(1.2, k * 1.4) });
        g.roundRect(X(4.4), Y(7), k * 15.2, k * 11.6, k * 2).fill({ color: 0x7b4fc4 }).stroke({ color: ink, width: 1.2 });
        g.roundRect(X(4.4), Y(7), k * 15.2, k * 3.2, k * 2).fill({ color: 0x9a73e0, alpha: 0.85 });
        g.rect(X(7.4), Y(7), k * 2, k * 11.6).fill({ color: 0xe3b341 }).stroke({ color: ink, width: 0.7 });
        g.rect(X(14.6), Y(7), k * 2, k * 11.6).fill({ color: 0xe3b341 }).stroke({ color: ink, width: 0.7 });
        g.circle(X(12), Y(13), k * 2.6).fill({ color: 0xffd96a, alpha: 0.25 });
        g.poly(P([12, 10.8, 14, 13, 12, 15.2, 10, 13])).fill({ color: 0xffd96a }).stroke({ color: ink, width: 0.8 });
        break;
      }
    }
    layer.addChild(g);
  }


  /** Colony: a wide glass-dome habitat (matches the redesigned HUD icon) —
   *  landing pad, owner-colored dome with glass highlight arcs, airlock. */
  private drawColony(g: Graphics, cx: number, cy: number, s: number, color: number): void {
    s *= 1.3; // owner request: colony building 30% larger
    const ink = 0x0a0f1e;
    const dark = tint(color, -0.3) >>> 0;
    const lite = tint(color, 0.55);
    const k = s / 7;
    const X = (px: number): number => cx + (px - 12) * k;
    const Y = (py: number): number => cy + (py - 14.5) * k;
    // Pad.
    g.ellipse(X(12), Y(18.6), k * 9.4, k * 2.4).fill({ color: dark }).stroke({ color: ink, width: 1 });
    // Dome.
    g.moveTo(X(4.4), Y(18.4)).arc(X(12), Y(18.4), k * 7.6, Math.PI, 0).closePath()
      .fill({ color }).stroke({ color: ink, width: 1.2 });
    // Glass highlight arcs.
    g.moveTo(X(6.4), Y(18.2)).arc(X(12), Y(18.2), k * 5.6, Math.PI, 0)
      .stroke({ color: lite, width: Math.max(1, k * 0.9), alpha: 0.9 });
    g.moveTo(X(8.6), Y(18)).arc(X(12), Y(18), k * 3.5, Math.PI, 0)
      .stroke({ color: lite, width: Math.max(0.8, k * 0.6), alpha: 0.55 });
    // Door.
    g.roundRect(X(10.6), Y(13.4), k * 2.8, k * 5, k * 0.7).fill({ color: ink, alpha: 0.4 });
    // Airlock module.
    g.roundRect(X(18.6), Y(16.2), k * 3.6, k * 2.4, k * 1.2).fill({ color: lite }).stroke({ color: ink, width: 0.8 });
  }

  /** Spaceport: a tall control tower piercing a glowing landing ring with a
   *  beacon on top (matches the redesigned HUD icon). */
  private drawSpaceport(g: Graphics, cx: number, cy: number, s: number, color: number): void {
    const ink = 0x0a0f1e;
    const dark = tint(color, -0.3) >>> 0;
    const k = s / 6.5;
    const X = (px: number): number => cx + (px - 12) * k;
    const Y = (py: number): number => cy + (py - 12) * k;
    // Pad.
    g.ellipse(X(12), Y(19.4), k * 8.6, k * 2).fill({ color: dark }).stroke({ color: ink, width: 1 });
    // Landing ring — back half behind the tower (dim), front half over it.
    g.ellipse(X(12), Y(10.6), k * 8, k * 2.6).stroke({ color: 0x6fd0ff, width: Math.max(1, k * 0.9), alpha: 0.45 });
    // Tower.
    g.poly([X(10.2), Y(19.4), X(11), Y(7.4), X(13), Y(7.4), X(13.8), Y(19.4)])
      .fill({ color }).stroke({ color: ink, width: 1.2 });
    // Front half of the ring (bright), drawn over the tower.
    g.moveTo(X(4), Y(10.6)).arc(X(12), Y(10.6), k * 8, Math.PI, 0, true)
      .stroke({ color: 0x6fd0ff, width: Math.max(1.2, k * 1.1) });
    // Control cap + beacon.
    g.roundRect(X(9.4), Y(5), k * 5.2, k * 3, k * 1.5).fill({ color }).stroke({ color: ink, width: 1.2 });
    g.circle(X(12), Y(3.4), k * 1.3).fill({ color: 0xffd23f }).stroke({ color: ink, width: 0.8 });
  }

  /**
   * Ship pieces, matching the redesigned HUD icons exactly:
   *   colony ship = a VERTICAL settler rocket carrying a green habitat dome;
   *   trade ship  = a HORIZONTAL freighter stacked with gold cargo crates.
   * Body in the owner color; the dome/crates keep their identity colors.
   */
  private drawShip(
    g: Graphics,
    kind: "colonyShip" | "tradeShip",
    sx: number,
    sy: number,
    r: number,
    color: number,
  ): void {
    // Map ships read too big; shrunk in two passes. Final factors fold the
    // earlier reduction (0.8 desktop / 0.7 mobile) with a further 30% cut.
    r *= window.innerWidth < 1000 ? 0.49 : 0.56;
    const ink = 0x0a0f1e;
    const dark = tint(color, -0.28) >>> 0;
    if (kind === "colonyShip") {
      const k = r / 5.4;
      const X = (px: number): number => sx + (px - 12) * k;
      const Y = (py: number): number => sy + (py - 12) * k;
      // Habitat dome nose (green — the colony-ship identity).
      g.moveTo(X(7.6), Y(10.4)).arc(X(12), Y(10.4), k * 4.4, Math.PI, 0).closePath()
        .fill({ color: 0x57e389 }).stroke({ color: ink, width: 1.1 });
      g.moveTo(X(9.2), Y(9.8)).arc(X(12), Y(9.8), k * 2.7, Math.PI, 0)
        .stroke({ color: ink, width: 0.8, alpha: 0.45 });
      // Body.
      g.roundRect(X(7.6), Y(10.4), k * 8.8, k * 7.2, k * 1.4).fill({ color }).stroke({ color: ink, width: 1.1 });
      g.circle(X(12), Y(13.6), k * 1.5).fill({ color: ink, alpha: 0.45 });
      // Legs.
      g.poly([X(7.6), Y(14.4), X(4.6), Y(19), X(7.6), Y(17.6)]).fill({ color: dark }).stroke({ color: ink, width: 0.8 });
      g.poly([X(16.4), Y(14.4), X(19.4), Y(19), X(16.4), Y(17.6)]).fill({ color: dark }).stroke({ color: ink, width: 0.8 });
      // Flame.
      g.poly([X(10), Y(17.6), X(12), Y(21.6), X(14), Y(17.6)]).fill({ color: 0xffd23f }).stroke({ color: ink, width: 0.8 });
      return;
    }
    // Trade freighter.
    const k = r / 4.6;
    const X = (px: number): number => sx + (px - 12) * k;
    const Y = (py: number): number => sy + (py - 11.4) * k;
    // Cargo crates (gold — the trade-ship identity).
    g.roundRect(X(5.2), Y(6.4), k * 3.2, k * 3.2, k * 0.6).fill({ color: 0xffd23f }).stroke({ color: ink, width: 0.8 });
    g.roundRect(X(9), Y(6.4), k * 3.2, k * 3.2, k * 0.6).fill({ color: 0xffb13f }).stroke({ color: ink, width: 0.8 });
    g.roundRect(X(12.8), Y(6.4), k * 3.2, k * 3.2, k * 0.6).fill({ color: 0xffd23f }).stroke({ color: ink, width: 0.8 });
    // Hull.
    g.poly([X(3.5), Y(10), X(17.5), Y(10), X(21.5), Y(12.6), X(17.5), Y(16.4), X(3.5), Y(16.4), X(2.6), Y(13.2)])
      .fill({ color }).stroke({ color: ink, width: 1.2 });
    g.circle(X(18), Y(12.9), k * 1.2).fill({ color: ink, alpha: 0.45 });
    // Engine block.
    g.roundRect(X(1), Y(11.4), k * 2.4, k * 3, k * 0.8).fill({ color: 0x6fd0ff }).stroke({ color: ink, width: 0.8 });
  }

  /**
   * Draw a straight line segment as a self-closing filled quad. Using a stroked
   * `moveTo().lineTo()` inside a Graphics that also draws `.circle()`/`.poly()`
   * shapes triggers a Pixi v8 path-accumulation bug where later shapes connect
   * back to the world origin [0,0] (rendering as stray beams across the board).
   * A filled poly closes its own subpath, so it never leaks into later shapes.
   */
  private strokeLine(
    g: Graphics,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    color: number,
    alpha = 1,
  ): void {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const px = (-dy / len) * (width / 2);
    const py = (dx / len) * (width / 2);
    g.poly([
      x1 + px, y1 + py,
      x2 + px, y2 + py,
      x2 - px, y2 - py,
      x1 - px, y1 - py,
    ]).fill({ color, alpha });
  }

  /**
   * The six docking-node angles around an outpost hub, in dock-index order
   * (i=0..2 lobes, each with a -0.42 then +0.42 offset node). Shared by
   * `drawOutpost` (painted nodes), trade-station pips, and docked ships so all
   * three land on exactly the same spots — otherwise stations render "next to"
   * the painted docks instead of on them.
   */
  /**
   * World-space positions of the six docking rings for an outpost hub at
   * (cx,cy). EXACTLY mirrors the rings drawn by `drawOutpost`: three lobes one
   * board-unit (= `scale` px) from the hub at 0/120/240°, each carrying two
   * rings offset ±0.62 rad along the lobe arc. Trade-station pips and docked
   * ships use this so they land on the painted rings, not near the hub.
   */
  private dockNodePositions(
    cx: number,
    cy: number,
    scale: number,
    lobes: { x: number; y: number }[],
  ): { x: number; y: number }[] {
    // Mirror drawOutpost EXACTLY: each ring sits on the outer arc of a lobe, off
    // the line from the hub to that lobe by ±0.62 rad, at lobeR*0.55. The lobes
    // are the real (orientation-rotated) hex centres — using assumed 0/120/240°
    // angles instead made the pips/ships drift off the painted docks (badly in
    // landscape).
    const ringOut = scale * 0.58 * 0.55; // lobeR * 0.55
    const pts: { x: number; y: number }[] = [];
    for (const l of lobes) {
      const away = Math.atan2(l.y - cy, l.x - cx);
      for (const off of [-0.62, 0.62]) {
        const a = away + off;
        pts.push({ x: l.x + Math.cos(a) * ringOut, y: l.y + Math.sin(a) * ringOut });
      }
    }
    return pts;
  }

  /**
   * Alien outpost station: a dark navy tri-lobe hub with six docking nodes and
   * teal connector struts, echoing the printed outpost tokens. The civ emblem is
   * layered on top by `drawCivIcon`.
   */
  /**
   * AA6: the outpost station, redrawn at full size in the spirit of the
   * printed boards — a dark tri-lobe plate spanning the whole 3-hex triangle,
   * cyan circuit lines radiating from the hub, twin glowing docking rings on
   * every lobe, and a slowly rotating energy ring around the central emblem
   * (original vector work; the printed art is referenced for feel only).
   */
  private drawOutpost(
    layer: Container,
    cx: number,
    cy: number,
    lobes: { x: number; y: number }[],
    scale: number,
    color: number,
  ): void {
    const navy = 0x16223c;
    const navyHi = 0x223456;
    const edge = 0x080f1f;
    const teal = 0x3fd0d6;
    const node = tint(color, 0.35);
    const station = new Graphics();

    // Solid body: the triangle plate between the three hex centres + a big
    // rounded lobe over each hex — the trefoil silhouette of the printed board.
    const lobeR = scale * 0.58;
    if (lobes.length === 3) {
      station.poly(lobes.flatMap((l) => [l.x, l.y]));
    }
    for (const l of lobes) station.circle(l.x, l.y, lobeR);
    station.circle(cx, cy, scale * 0.52);
    station.fill({ color: navy }).stroke({ color: edge, width: 3 });
    // Soft top sheen on each lobe so the plate reads as moulded, not flat.
    for (const l of lobes) {
      station.circle(l.x - lobeR * 0.18, l.y - lobeR * 0.2, lobeR * 0.74).fill({ color: navyHi, alpha: 0.35 });
      station.circle(l.x, l.y, lobeR * 0.92).stroke({ color: navyHi, width: 1.2, alpha: 0.5 });
    }

    // Cyan circuit lines: hub → each lobe, with a midway pulse node.
    for (const l of lobes) {
      this.strokeLine(station, cx, cy, l.x, l.y, scale * 0.035, teal, 0.7);
      station.circle((cx + l.x) / 2, (cy + l.y) / 2, scale * 0.05).fill({ color: teal, alpha: 0.9 });
    }

    // Twin docking rings per lobe, sitting on the outer arc (away from the hub).
    for (const l of lobes) {
      const away = Math.atan2(l.y - cy, l.x - cx);
      for (const off of [-0.62, 0.62]) {
        const a = away + off;
        const nx = l.x + Math.cos(a) * lobeR * 0.55;
        const ny = l.y + Math.sin(a) * lobeR * 0.55;
        station.circle(nx, ny, scale * 0.15).fill({ color: edge }).stroke({ color: node, width: 2 });
        station.circle(nx, ny, scale * 0.07).fill({ color: node });
      }
    }
    layer.addChild(station);

    // Center emblem pad: a breathing civ-colour glow under the icon…
    const pad = new Graphics().circle(cx, cy, scale * 0.5).fill({ color, alpha: 0.16 });
    layer.addChild(pad);
    const phase = (cx * 0.011 + cy * 0.023) % (Math.PI * 2);
    this.ambientItems.push({ g: pad, kind: "halo", x: cx, y: cy, rad: scale * 0.5, phase, speed: 0.9 });

    // …and the rotating energy ring: four glowing arc segments drawn around
    // the Graphics' own origin so the ambient ticker can spin it in place.
    const ring = new Graphics();
    const ringR = scale * 0.46;
    for (let i = 0; i < 4; i++) {
      const a0 = (Math.PI / 2) * i + 0.18;
      const a1 = a0 + Math.PI / 2 - 0.36;
      ring.moveTo(Math.cos(a0) * ringR, Math.sin(a0) * ringR).arc(0, 0, ringR, a0, a1);
    }
    ring.stroke({ color: tint(color, 0.2), width: 2.2, alpha: 0.85 });
    ring.position.set(cx, cy);
    layer.addChild(ring);
    this.ambientItems.push({ g: ring, kind: "spin", x: cx, y: cy, rad: ringR, phase, speed: 1 });
  }

  /**
   * The civ emblem layered on the outpost hub, matching the printed tokens:
   * greenFolk = green molecule, scientists = silver arrow-ship, merchants = gold
   * dice, diplomats = red mech-claw.
   */
  private drawCivIcon(layer: Container, cx: number, cy: number, scale: number, civ: string, _color: number): void {
    const g = new Graphics();
    const s = scale * 0.24;
    const ink = 0x0a0f1e;
    switch (civ) {
      case "greenFolk": {
        // Molecule: central sphere bonded to three satellites.
        const core = 0x3fae3a;
        const sat = 0x7fe06a;
        for (let i = 0; i < 3; i++) {
          const a = (-Math.PI / 2) + (Math.PI * 2 * i) / 3;
          const ox = cx + Math.cos(a) * s * 0.78;
          const oy = cy + Math.sin(a) * s * 0.78;
          this.strokeLine(g, cx, cy, ox, oy, s * 0.22, 0x2f7325);
        }
        for (let i = 0; i < 3; i++) {
          const a = (-Math.PI / 2) + (Math.PI * 2 * i) / 3;
          const ox = cx + Math.cos(a) * s * 0.78;
          const oy = cy + Math.sin(a) * s * 0.78;
          g.circle(ox, oy, s * 0.3).fill({ color: sat }).stroke({ color: ink, width: 1 });
          g.circle(ox - s * 0.08, oy - s * 0.08, s * 0.1).fill({ color: 0xeafff0, alpha: 0.8 });
        }
        g.circle(cx, cy, s * 0.5).fill({ color: core }).stroke({ color: ink, width: 1.2 });
        g.circle(cx - s * 0.14, cy - s * 0.14, s * 0.16).fill({ color: 0xeafff0, alpha: 0.85 });
        break;
      }
      case "scientists": {
        // Sleek silver arrow-ship pointing up, swept wings.
        const silver = 0xd8e2f0;
        const steel = 0x8fa4c4;
        const glass = 0x4fb6ff;
        // Wings.
        g.poly([cx, cy + s * 0.1, cx - s * 1.0, cy + s * 0.7, cx - s * 0.25, cy + s * 0.2])
          .fill({ color: steel }).stroke({ color: ink, width: 1 });
        g.poly([cx, cy + s * 0.1, cx + s * 1.0, cy + s * 0.7, cx + s * 0.25, cy + s * 0.2])
          .fill({ color: steel }).stroke({ color: ink, width: 1 });
        // Fuselage (arrowhead).
        g.poly([cx, cy - s, cx + s * 0.42, cy + s * 0.7, cx, cy + s * 0.42, cx - s * 0.42, cy + s * 0.7])
          .fill({ color: silver }).stroke({ color: ink, width: 1.2 });
        // Cockpit.
        g.circle(cx, cy - s * 0.05, s * 0.22).fill({ color: glass }).stroke({ color: ink, width: 1 });
        break;
      }
      case "merchants": {
        // Two gold dice.
        const gold = 0xe9b83a;
        const goldD = 0xb07f12;
        const pip = 0x3a2705;
        const die = (dx: number, dy: number, d: number): void => {
          g.roundRect(dx - d, dy - d, d * 2, d * 2, d * 0.35).fill({ color: gold }).stroke({ color: ink, width: 1 });
          g.roundRect(dx - d, dy + d * 0.3, d * 2, d * 0.7, d * 0.3).fill({ color: goldD, alpha: 0.5 });
          for (const [px, py] of [[-0.45, -0.45], [0.45, 0.45], [0, 0]] as const) {
            g.circle(dx + px * d, dy + py * d, d * 0.16).fill({ color: pip });
          }
        };
        die(cx - s * 0.4, cy + s * 0.2, s * 0.55);
        die(cx + s * 0.5, cy - s * 0.25, s * 0.45);
        break;
      }
      case "diplomats": {
        // Red mechanical claw/gauntlet.
        const red = 0xd23a33;
        const redD = 0x8c1f1c;
        // Palm.
        g.roundRect(cx - s * 0.55, cy - s * 0.1, s * 1.1, s * 0.9, s * 0.25)
          .fill({ color: red }).stroke({ color: ink, width: 1.2 });
        // Fingers.
        for (const fx of [-0.42, -0.14, 0.14, 0.42]) {
          g.roundRect(cx + fx * s - s * 0.1, cy - s * 0.85, s * 0.2, s * 0.85, s * 0.1)
            .fill({ color: red }).stroke({ color: ink, width: 1 });
          g.circle(cx + fx * s, cy - s * 0.85, s * 0.12).fill({ color: redD });
        }
        // Thumb.
        g.roundRect(cx - s * 0.85, cy + s * 0.1, s * 0.35, s * 0.2, s * 0.08)
          .fill({ color: red }).stroke({ color: ink, width: 1 });
        // Knuckle joints.
        g.rect(cx - s * 0.55, cy + s * 0.05, s * 1.1, s * 0.12).fill({ color: redD, alpha: 0.7 });
        break;
      }
      default: {
        // Travelers / generic: four-point star.
        g.poly([cx, cy - s, cx + s * 0.3, cy - s * 0.3, cx + s, cy, cx + s * 0.3, cy + s * 0.3,
                cx, cy + s, cx - s * 0.3, cy + s * 0.3, cx - s, cy, cx - s * 0.3, cy - s * 0.3])
          .fill({ color: tint(_color, 0.7) }).stroke({ color: ink, width: 1.2 });
      }
    }
    layer.addChild(g);
  }

  /** Fit the board's bounding box into the viewport with padding. */
  private computeTransform(state: GameState): { scale: number; ox: number; oy: number } {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const inter of Object.values(state.intersections)) {
      const o = this.ori(inter.x, inter.y);
      xs.push(o.x);
      ys.push(o.y);
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.contentBounds = { minX, maxX, minY, maxY };
    // Fit against the LIVE viewport, never app.screen. Pixi's resizeTo:window
    // defers its resize a frame, so app.screen (and the autoDensity inline canvas
    // size, which overrides our 100vw CSS) can lag stale-large after a resize —
    // centering for that stale width drops the map into the right side of the
    // actually-visible window. window.innerWidth is always current.
    const w = window.innerWidth || this.app.screen.width;
    const h = window.innerHeight || this.app.screen.height;
    const pad = 80;
    const sx = (w - pad * 2) / (maxX - minX || 1);
    const sy = (h - pad * 2) / (maxY - minY || 1);
    const scale = Math.min(sx, sy);
    const ox = (w - (maxX + minX) * scale) / 2;
    const oy = (h - (maxY + minY) * scale) / 2;
    return { scale, ox, oy };
  }

  private label(
    text: string,
    x: number,
    y: number,
    size: number,
    color: number,
    bold = false,
  ): Text {
    const style = new TextStyle({
      fontFamily: "Inter, system-ui, sans-serif",
      fontSize: Math.max(8, size),
      fontWeight: bold ? "700" : "500",
      fill: color,
      align: "center",
    });
    const t = new Text({ text, style });
    t.anchor.set(0.5);
    t.x = x;
    t.y = y;
    return t;
  }

  destroy(): void {
    this.root.destroy({ children: true });
  }
}
