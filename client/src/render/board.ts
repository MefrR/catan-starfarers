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
};

/** Per-civ outpost colour + display name (mirrors the printed OUTPOSTS art). */
const CIV_STYLE: Record<string, { color: number; name: string; ability: string }> = {
  greenFolk: { color: 0x57e389, name: "The Green Folk", ability: "Production Increase — extra resources" },
  scientists: { color: 0x6fb3ff, name: "The Scientists", ability: "Improved Upgrades — virtual boosters/cannons" },
  diplomats: { color: 0xffd23f, name: "The Diplomats", ability: "Reduced tribute, fame for sale & relief" },
  merchants: { color: 0xc98bff, name: "The Merchants", ability: "Trade Advantage — better trade ratios" },
  travelers: { color: 0xff8a5d, name: "The Travelers", ability: "Encounter-only allies" },
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

  // Persistent FX overlay (build pulses) — survives wholesale re-renders.
  private fx = new Container();
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
  // would get lost. Horizontally ~5cm; vertically a roomier ~20cm so tall maps
  // can be scrolled well up/down. (96 CSS px/in ÷ 2.54 cm/in × cm.)
  private static readonly PAN_MARGIN = Math.round((96 / 2.54) * 5);
  private static readonly PAN_MARGIN_Y = Math.round((96 / 2.54) * 20);
  // Board content bounds in board-space (set each render) — drives pan clamping.
  private contentBounds = { minX: 0, maxX: 0, minY: 0, maxY: 0 };
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
    window.addEventListener("resize", () => {
      if (this.last) this.render(this.last);
    });
    this.tooltipEl = document.createElement("div");
    this.tooltipEl.className = "map-tooltip";
    document.body.appendChild(this.tooltipEl);
    window.addEventListener("pointermove", (e) => {
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.tooltipEl.classList.contains("show")) this.positionTooltip();
    });
    this.installViewControls();
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

  private showTip(text: string, touch: boolean): void {
    this.tipTouch = touch;
    this.tooltipEl.innerHTML = text;
    this.tooltipEl.classList.add("show");
    this.positionTooltip();
    window.clearTimeout(this.tipTimer);
    if (touch) {
      // Touch fires no "pointerout" — guarantee the tip clears itself.
      this.tipTimer = window.setTimeout(() => this.hideTip(), 2600);
    }
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

  /** Board-space (x,y) → on-screen pixel coords, honoring fit + zoom/pan. */
  worldToScreen(x: number, y: number): { x: number; y: number } {
    const wx = this.fit.ox + x * this.fit.scale;
    const wy = this.fit.oy + y * this.fit.scale;
    return { x: wx * this.zoom + this.panX, y: wy * this.zoom + this.panY };
  }

  /** On-screen pixel position of an intersection (or null if unknown). */
  screenPosOf(intersectionId: string): { x: number; y: number } | null {
    const inter = this.last?.intersections[intersectionId];
    if (!inter) return null;
    return this.worldToScreen(inter.x, inter.y);
  }

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
    const z = this.zoom;
    const f = this.fit;
    const sw = this.app.screen.width;
    const sh = this.app.screen.height;
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

  /**
   * Glide the view back to the fitted middle (zoom 1, centred) over ~380ms.
   * Fired by a double-tap or after 10s of no map interaction so a lost or
   * zoomed-in player is always returned to the whole map.
   */
  private animateRecenter(): void {
    if (this.zoom === 1 && this.panX === 0 && this.panY === 0) return; // already there
    cancelAnimationFrame(this.recenterAnim);
    const z0 = this.zoom;
    const px0 = this.panX;
    const py0 = this.panY;
    const t0 = performance.now();
    const dur = 380;
    const ease = (t: number): number => 1 - Math.pow(1 - t, 3);
    const step = (now: number): void => {
      const t = Math.min(1, (now - t0) / dur);
      const e = ease(t);
      this.zoom = z0 + (1 - z0) * e;
      this.panX = px0 + (0 - px0) * e;
      this.panY = py0 + (0 - py0) * e;
      this.applyViewTransform();
      if (t < 1) {
        this.recenterAnim = requestAnimationFrame(step);
      } else {
        this.recenterAnim = 0;
        if (this.last) this.render(this.last); // bake crisp at zoom 1
      }
    };
    this.recenterAnim = requestAnimationFrame(step);
  }

  /** (Re)start the 10s idle countdown that auto-recenters the map. */
  private resetIdleTimer(): void {
    window.clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => this.animateRecenter(), 10000);
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

  /** Zoom toward a screen point (canvas-relative math), clamped to limits. */
  private zoomToward(clientX: number, clientY: number, factor: number): void {
    const canvas = this.app.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    const worldX = (mx - this.panX) / this.zoom;
    const worldY = (my - this.panY) / this.zoom;
    this.zoom = Math.max(
      BoardRenderer.MIN_ZOOM,
      Math.min(BoardRenderer.MAX_ZOOM, this.zoom * factor),
    );
    this.panX = mx - worldX * this.zoom;
    this.panY = my - worldY * this.zoom;
    this.applyViewTransform();
    this.scheduleCrispRender();
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
        this.zoomToward(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
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
      this.resetIdleTimer();
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
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
      canvas.style.cursor = "grabbing";
      this.applyViewTransform();
    });

    const endPointer = (e: PointerEvent): void => {
      // A single finger/click lifted without dragging = a tap. Two taps in quick
      // succession at roughly the same spot recenters the map to the middle.
      const wasTap = !moved && pts.size === 1 && e.type === "pointerup";
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
      if (pts.size === 0) canvas.style.cursor = "";
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
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyViewTransform();
    if (this.last) this.render(this.last);
  }

  /** Highlight a set of intersections (e.g. legal move destinations). */
  setHighlights(ids: string[]): void {
    this.highlightIds = new Set(ids);
    if (this.last) this.render(this.last);
  }

  clearHighlights(): void {
    if (this.highlightIds.size === 0 && this.selectedShipId === null) return;
    this.highlightIds.clear();
    this.selectedShipId = null;
    if (this.last) this.render(this.last);
  }

  setSelectedShip(id: string | null): void {
    this.selectedShipId = id;
    if (this.last) this.render(this.last);
  }

  render(state: GameState): void {
    this.last = state;
    this.root.removeChildren();

    const fit = this.computeTransform(state);
    this.fit = fit;
    // Bake the current zoom into the draw scale so text and strokes are drawn at
    // their true on-screen size (crisp), rather than up-scaled by the container.
    // `this.fit` stays unzoomed so worldToScreen / animations keep working.
    this.renderedZoom = this.zoom;
    const scale = fit.scale * this.zoom;
    const ox = fit.ox * this.zoom;
    const oy = fit.oy * this.zoom;
    const tx = (x: number): number => ox + x * scale;
    const ty = (y: number): number => oy + y * scale;

    const hexLayer = new Container();
    const linkLayer = new Container();
    const planetLayer = new Container();
    const highlightLayer = new Container();
    const nodeLayer = new Container();
    const buildLayer = new Container();
    const shipLayer = new Container();
    this.root.addChild(linkLayer, hexLayer, planetLayer, highlightLayer, nodeLayer, buildLayer, shipLayer);

    // Flat-top hex outline at a pixel centre.
    const drawHex = (cxp: number, cyp: number, fillColor: number, fillAlpha: number): void => {
      const pts: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * 60 * i;
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
          drawHex(tx(planet.x), ty(planet.y), 0x101a30, 0.4);
        }
        continue;
      }
      const cx = tx(1.5 * sector.q);
      const cy = ty(Math.sqrt(3) * (sector.r + sector.q / 2));
      if (sector.kind === "outpost") {
        // Outposts span the full 3-hex slot triangle: (q,r),(q+1,r),(q,r+1).
        const q = sector.q;
        const r = sector.r;
        const tri: [number, number][] = [[q, r], [q + 1, r], [q, r + 1]];
        for (const [hq, hr] of tri) {
          drawHex(tx(1.5 * hq), ty(Math.sqrt(3) * (hr + hq / 2)), 0x101a30, 0.4);
        }
        const charted = sector.discovered;
        if (!charted) {
          // Fog map: a disguised outpost looks exactly like an uncharted planetary
          // system — three blank "?" discs (P3). The civ underneath stays secret
          // until a ship reaches the triangle and charts it.
          const fogRad = scale * 0.6;
          for (const [hq, hr] of tri) {
            const dx = tx(1.5 * hq);
            const dy = ty(Math.sqrt(3) * (hr + hq / 2));
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
        const ocx = tx(1.5 * q + 0.5);
        const ocy = ty(Math.sqrt(3) * (r + q / 2 + 0.5));
        const civ = sector.outpostCiv ?? "";
        const style = CIV_STYLE[civ];
        const color = style?.color ?? 0xe8c24a;
        this.drawOutpost(planetLayer, ocx, ocy, scale, color);
        this.drawCivIcon(planetLayer, ocx, ocy, scale, civ, color);
        planetLayer.addChild(
          this.label(
            style?.name ?? "Outpost",
            ocx,
            ocy + scale * 0.78,
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
        this.attachTip(hot, new Circle(ocx, ocy, scale * 0.4), tip);
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
          // until a ship charts it (and finds nothing).
          const fogRad = scale * 0.6;
          for (const [hq, hr] of tri) {
            const dx = tx(1.5 * hq);
            const dy = ty(Math.sqrt(3) * (hr + hq / 2));
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
          const dx = tx(1.5 * hq);
          const dy = ty(Math.sqrt(3) * (hr + hq / 2));
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
        link.moveTo(tx(inter.x), ty(inter.y)).lineTo(tx(n.x), ty(n.y));
      }
    }
    link.stroke({ color: 0x39507a, width: 1, alpha: 0.5 });
    linkLayer.addChild(link);

    // Planets: coloured discs carrying the resource glyph + a number badge.
    for (const sector of state.sectors) {
      for (const planet of sector.planets) {
        const px = tx(planet.x);
        const py = ty(planet.y);
        const rad = scale * 0.6;
        // Fog map: an unexplored planet hides its resource colour entirely — it
        // reads as a blank "uncharted" disc with just an outline until a ship
        // reveals it (and the whole system) on arrival.
        const fill = planet.explored ? PLANET_FILL[planet.color] : 0x141d33;
        if (planet.explored) {
          // Soft glow halo so planets read against the starfield.
          planetLayer.addChild(
            new Graphics().circle(px, py, rad * 1.25).fill({ color: fill, alpha: 0.18 }),
          );
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
          tip = `<b>Unexplored planet</b><br>Fly a ship adjacent to reveal it`;
        } else if (planet.special === "pirateBase") {
          tip = `<b>Pirate Base</b><br>Beat it with combat ≥ ${planet.specialValue} to win a fame medal (+1 VP)`;
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
          planetLayer.addChild(
            new Graphics()
              .circle(px, py, rad * 0.92)
              .fill({ color: isPirate ? 0x2a0a0a : 0x0a2a33, alpha: 0.86 })
              .stroke({ color: isPirate ? 0xff5a4d : 0x7fe0ff, width: 2 }),
          );
          planetLayer.addChild(
            this.label(isPirate ? "☠" : "❄", px, py - rad * 0.12, rad * 0.8, isPirate ? 0xff7a6d : 0xbdefff, true),
          );
          if (planet.specialValue != null) {
            planetLayer.addChild(
              this.label(String(planet.specialValue), px, py + rad * 0.45, rad * 0.5, 0xeaf0ff, true),
            );
          }
        }

        // Number badge: dark chip pinned to the planet's lower edge.
        if (planet.explored && planet.special === "none" && planet.number != null) {
          const hot = planet.number === 6 || planet.number === 8;
          const bx = px;
          const by = py + rad * 0.86;
          const br = rad * 0.52;
          planetLayer.addChild(
            new Graphics()
              .circle(bx, by, br)
              .fill({ color: 0x0a0f1e, alpha: 0.92 })
              .stroke({ color: hot ? 0xff5a4d : 0x8aa0c8, width: 1.5, alpha: 0.9 }),
          );
          planetLayer.addChild(
            this.label(String(planet.number), bx, by, br * 1.05, hot ? 0xff7a6d : 0xeaf0ff, true),
          );
        }
      }
    }

    // Intersections: small nodes; colony sites (>=2 adjacent planets) highlighted.
    for (const inter of Object.values(state.intersections)) {
      const ix = tx(inter.x);
      const iy = ty(inter.y);
      const isColonySite = inter.adjacentPlanets.length === 2;
      const isDock = inter.dockingPointOf != null;

      // Highlight ring for legal targets (move destinations / colony picks).
      if (this.highlightIds.has(inter.id)) {
        highlightLayer.addChild(
          new Graphics()
            .circle(ix, iy, scale * 0.13)
            .fill({ color: 0x57e389, alpha: 0.22 })
            .stroke({ color: 0x57e389, width: 2.5, alpha: 0.95 }),
        );
      }

      const node = new Graphics().circle(ix, iy, isColonySite ? scale * 0.06 : scale * 0.035);
      node.fill({
        color: isColonySite ? 0x8fd0ff : isDock ? 0xe8d59a : 0x6b7da0,
        alpha: isColonySite || isDock ? 0.9 : 0.5,
      });
      // Interactive hit area (generous) so the HUD can drive board selection.
      node.eventMode = "static";
      node.cursor = "pointer";
      node.hitArea = new Circle(ix, iy, scale * 0.16);
      const id = inter.id;
      node.on("pointertap", () => this.onIntersectionClick?.(id));
      // Hover description (colony sites / docking points are the meaningful ones).
      if (isColonySite || isDock) {
        const tip = isColonySite
          ? `<b>Colony site</b><br>Land a colony ship here to settle (+1 VP).<br>It sits between two planets and collects from both.`
          : `<b>Docking point</b><br>Land a trade ship here to build a trade station (+1 VP) and earn a friendship card.`;
        node.on("pointerover", () => {
          this.tooltipEl.innerHTML = tip;
          this.tooltipEl.classList.add("show");
          this.positionTooltip();
        });
        node.on("pointerout", () => this.tooltipEl.classList.remove("show"));
      }
      nodeLayer.addChild(node);
    }

    // Buildings: colonies (square) and spaceports (larger ringed square) by owner.
    const ownerColor = new Map<string, PlayerColor>(state.players.map((p) => [p.id, p.color]));
    for (const b of state.buildings) {
      const inter = state.intersections[b.intersectionId];
      if (!inter) continue;
      const bx = tx(inter.x);
      const by = ty(inter.y);
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

    // Trade stations: owner-coloured pips arranged around each outpost centre.
    for (const sector of state.sectors) {
      if (sector.kind !== "outpost") continue;
      const ocx = tx(1.5 * sector.q + 0.5);
      const ocy = ty(Math.sqrt(3) * (sector.r + sector.q / 2 + 0.5));
      for (const ts of state.tradeStations.filter((t) => t.outpostId === sector.id)) {
        const a = (Math.PI * 2 * ts.dock) / 5 - Math.PI / 2;
        const r = scale * 0.42;
        const sx = ocx + Math.cos(a) * r;
        const sy = ocy + Math.sin(a) * r;
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
    for (const ship of state.ships) {
      const inter = state.intersections[ship.intersectionId];
      if (!inter) continue;
      const sx = tx(inter.x);
      const sy = ty(inter.y);
      const pc = ownerColor.get(ship.owner) ?? "yellow";
      // P8-5: a ship damaged in an encounter (frozen for the turn) is drawn red
      // with a warning ring so the player can see why it can't move.
      const damaged = ship.id === state.phaseState.frozenShipId;
      // P8-7: ships parked on an outpost docking point are drawn larger so
      // players can clearly see who is established inside the outpost.
      const onDock = !!inter.dockingPointOf;
      const color = damaged ? 0xff3b30 : OWNER_FILL[pc];
      // Q1: ships in general a bit larger; Q3: ships docked inside an outpost
      // drawn ~300% bigger than a travelling ship so the occupant is unmistakable.
      const r = scale * (onDock ? 0.46 : 0.2);
      const selected = ship.id === this.selectedShipId;
      const g = new Graphics();
      if (selected) g.circle(sx, sy, r * 1.5).stroke({ color: 0x57e389, width: 3, alpha: 0.95 });
      if (damaged) g.circle(sx, sy, r * 1.5).stroke({ color: 0xff3b30, width: 3, alpha: 0.9 });
      this.drawShip(g, ship.kind, sx, sy, r, color);
      g.eventMode = "static";
      g.cursor = "pointer";
      g.hitArea = new Circle(sx, sy, r * 1.4);
      const id = ship.id;
      g.on("pointertap", () => this.onShipClick?.(id));
      shipLayer.addChild(g);

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

  /** Glowing comet that flies along a fading trail from (fx,fy)→(tx,ty), board-space. */
  private spawnMoveTrail(fx: number, fy: number, tx: number, ty: number, color: number): void {
    const trail = new Graphics();
    const comet = new Graphics();
    this.fx.addChild(trail, comet);
    const start = performance.now();
    const dur = 700;
    const toScreen = (x: number, y: number): { x: number; y: number } => ({
      x: this.fit.ox + x * this.fit.scale,
      y: this.fit.oy + y * this.fit.scale,
    });
    const a = toScreen(fx, fy);
    const b = toScreen(tx, ty);
    const s = this.fit.scale;
    const tick = (): void => {
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        this.app.ticker.remove(tick);
        trail.destroy();
        comet.destroy();
        return;
      }
      const e = 1 - (1 - t) * (1 - t); // ease-out
      const hx = a.x + (b.x - a.x) * e;
      const hy = a.y + (b.y - a.y) * e;
      trail.clear();
      trail
        .moveTo(a.x, a.y)
        .lineTo(hx, hy)
        .stroke({ color, width: Math.max(2, s * 0.08), alpha: 0.5 * (1 - t) });
      comet.clear();
      comet.circle(hx, hy, s * 0.12).fill({ color, alpha: 0.9 });
      comet.circle(hx, hy, s * 0.22).stroke({ color: 0xffffff, width: 2, alpha: 0.6 * (1 - t) });
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

  /** Expanding owner-coloured ring + flash at a board position (fit-space). */
  private spawnBuildFx(bx: number, by: number, color: number): void {
    const cx = this.fit.ox + bx * this.fit.scale;
    const cy = this.fit.oy + by * this.fit.scale;
    const s = this.fit.scale;
    const ring = new Graphics();
    this.fx.addChild(ring);
    const start = performance.now();
    const dur = 850;
    const tick = (): void => {
      const t = (performance.now() - start) / dur;
      if (t >= 1) {
        this.app.ticker.remove(tick);
        ring.destroy();
        return;
      }
      const e = 1 - (1 - t) * (1 - t); // ease-out
      ring.clear();
      ring
        .circle(cx, cy, s * (0.12 + e * 0.55))
        .stroke({ color, width: 5 * (1 - t) + 1, alpha: 1 - t });
      ring
        .circle(cx, cy, s * (0.55 + e * 0.5))
        .stroke({ color: 0xffffff, width: 2 * (1 - t), alpha: 0.7 * (1 - t) });
      ring.circle(cx, cy, s * 0.2).fill({ color, alpha: 0.45 * (1 - t) });
    };
    this.app.ticker.add(tick);
  }

  /**
   * Full-colour resource glyph centred at (x,y), sized to radius r. Drawn as
   * crisp original vectors that echo the printed card art: carbon = blue crystal
   * cluster, fuel = gold fuel cylinder, food = green seed-creature, ore = red
   * rock, goods = purple/gold treasure chest.
   */
  private drawResourceGlyph(layer: Container, res: Resource, x: number, y: number, r: number): void {
    const ink = 0x0a0f1e;
    const g = new Graphics();
    switch (res) {
      case "carbon": {
        // Cluster of angular ice-blue crystal shards.
        const lo = 0x2f7fd6;
        const mid = 0x57b6f0;
        const hi = 0xbfe9ff;
        const shard = (
          bx: number,
          by: number,
          w: number,
          h: number,
          lean: number,
        ): void => {
          const tip = [bx + lean, by - h];
          const lft = [bx - w, by];
          const rgt = [bx + w, by];
          // Body (two facets, lit + shaded).
          g.poly([tip[0]!, tip[1]!, rgt[0]!, rgt[1]!, bx + lean * 0.3, by + h * 0.05, lft[0]!, lft[1]!])
            .fill({ color: mid })
            .stroke({ color: ink, width: 1 });
          g.poly([tip[0]!, tip[1]!, bx + lean * 0.3, by + h * 0.05, lft[0]!, lft[1]!]).fill({ color: lo });
          // Highlight edge.
          this.strokeLine(g, tip[0]!, tip[1]!, bx + lean * 0.3, by + h * 0.05, 1, hi, 0.8);
        };
        shard(x - r * 0.42, y + r * 0.7, r * 0.32, r * 1.0, -r * 0.08);
        shard(x + r * 0.42, y + r * 0.78, r * 0.3, r * 0.85, r * 0.1);
        shard(x, y + r * 0.92, r * 0.42, r * 1.5, r * 0.02);
        break;
      }
      case "fuel": {
        // Upright gold fuel cylinder with cap, bands and a sheen strip.
        const body = 0xd99a2b;
        const lite = 0xf6c659;
        const dark = 0xa06c14;
        const w = r * 0.62;
        const top = y - r * 1.02;
        const bot = y + r * 1.02;
        const capH = r * 0.26;
        // Barrel.
        g.rect(x - w, top + capH, w * 2, bot - top - capH * 2)
          .fill({ color: body })
          .stroke({ color: ink, width: 1.2 });
        // Sheen.
        g.rect(x - w * 0.55, top + capH, w * 0.5, bot - top - capH * 2).fill({ color: lite, alpha: 0.55 });
        // Caps (ellipse-like rounded rects).
        g.roundRect(x - w * 1.12, top, w * 2.24, capH * 1.6, capH * 0.7)
          .fill({ color: lite })
          .stroke({ color: ink, width: 1.2 });
        g.roundRect(x - w * 1.12, bot - capH * 1.6, w * 2.24, capH * 1.6, capH * 0.7)
          .fill({ color: dark })
          .stroke({ color: ink, width: 1.2 });
        // Mid bands.
        g.rect(x - w, y - r * 0.18, w * 2, r * 0.16).fill({ color: dark, alpha: 0.85 });
        break;
      }
      case "food": {
        // Round green seed-creature: bumpy sphere + a single eye.
        const skin = 0x4ca63a;
        const shade = 0x2f7325;
        const lite = 0x8fd66f;
        g.circle(x, y, r * 0.95).fill({ color: skin }).stroke({ color: ink, width: 1.2 });
        // Shaded lower-right crescent. Start the subpath explicitly at the arc's
        // first point: a bare arc().fill() begins its path at the world origin
        // [0,0], so the chord fill would fan a green wedge across the board.
        {
          const sa = -Math.PI * 0.15;
          const ea = Math.PI * 0.85;
          const rr = r * 0.95;
          g.moveTo(x + Math.cos(sa) * rr, y + Math.sin(sa) * rr)
            .arc(x, y, rr, sa, ea)
            .closePath()
            .fill({ color: shade, alpha: 0.5 });
        }
        // Surface bumps.
        for (const [bx, by, br] of [
          [-0.35, -0.3, 0.22],
          [0.32, -0.12, 0.18],
          [-0.1, 0.4, 0.2],
          [0.4, 0.35, 0.15],
        ] as const) {
          g.circle(x + bx * r, y + by * r, br * r).fill({ color: lite, alpha: 0.7 });
        }
        // Eye.
        g.circle(x + r * 0.12, y - r * 0.05, r * 0.3).fill({ color: 0xeafff0 }).stroke({ color: ink, width: 1 });
        g.circle(x + r * 0.2, y - r * 0.02, r * 0.14).fill({ color: ink });
        break;
      }
      case "ore": {
        // Angular red ore rock with a bright facet.
        const red = 0xcc3633;
        const dark = 0x8c2120;
        const lite = 0xf0746a;
        g.poly([
          x - r * 0.95, y + r * 0.1,
          x - r * 0.5, y - r * 0.7,
          x + r * 0.25, y - r * 0.85,
          x + r * 0.95, y - r * 0.1,
          x + r * 0.7, y + r * 0.75,
          x - r * 0.45, y + r * 0.8,
        ])
          .fill({ color: red })
          .stroke({ color: ink, width: 1.2 });
        // Lit top facet.
        g.poly([x - r * 0.5, y - r * 0.7, x + r * 0.25, y - r * 0.85, x + r * 0.1, y - r * 0.1, x - r * 0.4, y - r * 0.05])
          .fill({ color: lite, alpha: 0.85 });
        // Shaded base facet.
        g.poly([x - r * 0.45, y + r * 0.8, x + r * 0.7, y + r * 0.75, x + r * 0.55, y + r * 0.2, x - r * 0.3, y + r * 0.25])
          .fill({ color: dark, alpha: 0.7 });
        break;
      }
      case "goods": {
        // Purple treasure chest with gold trim and a lock.
        const body = 0x7b4fc4;
        const dark = 0x4f2e8a;
        const gold = 0xe3b341;
        const w = r * 0.98;
        const h = r * 0.62;
        const lidH = r * 0.5;
        // Chest body.
        g.rect(x - w, y - h * 0.1, w * 2, h * 1.5).fill({ color: body }).stroke({ color: ink, width: 1.2 });
        g.rect(x - w, y - h * 0.1, w * 2, h * 0.4).fill({ color: dark, alpha: 0.5 });
        // Domed lid.
        g.moveTo(x - w, y - h * 0.1)
          .lineTo(x - w, y - h * 0.45)
          .arc(x, y - h * 0.45, w, Math.PI, 0)
          .lineTo(x + w, y - h * 0.1)
          .closePath()
          .fill({ color: body })
          .stroke({ color: ink, width: 1.2 });
        void lidH;
        // Gold trim bands.
        g.rect(x - w, y - h * 0.1, w * 2, r * 0.13).fill({ color: gold }).stroke({ color: ink, width: 0.8 });
        g.rect(x - w * 0.18, y - h * 0.55, w * 0.36, h * 1.9).fill({ color: gold }).stroke({ color: ink, width: 0.8 });
        // Lock.
        g.circle(x, y + h * 0.3, r * 0.16).fill({ color: gold }).stroke({ color: ink, width: 1 });
        break;
      }
    }
    layer.addChild(g);
  }

  /**
   * Draws an upright isometric block (rectangular prism) in the owner colour:
   * three lit/shaded faces so a stack of these reads as the chunky 3D plastic
   * towers from the printed pieces. Base-centre at (tx,ty), footprint half-width
   * `hw`, pixel height `h`.
   */
  private isoTower(
    g: Graphics,
    tx: number,
    ty: number,
    hw: number,
    h: number,
    topC: number,
    leftC: number,
    rightC: number,
  ): void {
    const ink = 0x0a0f1e;
    const dh = hw * 0.5; // iso depth
    // Left face.
    g.poly([tx - hw, ty, tx, ty + dh, tx, ty + dh - h, tx - hw, ty - h])
      .fill({ color: leftC })
      .stroke({ color: ink, width: 0.8 });
    // Right face.
    g.poly([tx, ty + dh, tx + hw, ty, tx + hw, ty - h, tx, ty + dh - h])
      .fill({ color: rightC })
      .stroke({ color: ink, width: 0.8 });
    // Top face (diamond).
    g.poly([tx - hw, ty - h, tx, ty + dh - h, tx + hw, ty - h, tx, ty - dh - h])
      .fill({ color: topC })
      .stroke({ color: ink, width: 0.8 });
  }

  /** Flat isometric hexagonal platform used as the base for colony/spaceport. */
  private isoHexBase(g: Graphics, cx: number, cy: number, s: number, topC: number, sideC: number): void {
    const ink = 0x0a0f1e;
    const thick = s * 0.32;
    const hex = (yy: number): number[] => {
      const p: number[] = [];
      for (let i = 0; i < 6; i++) {
        const a = (Math.PI / 180) * (60 * i + 30);
        p.push(cx + s * Math.cos(a), yy + s * 0.52 * Math.sin(a));
      }
      return p;
    };
    g.poly(hex(cy + thick)).fill({ color: sideC }).stroke({ color: ink, width: 1 });
    g.poly(hex(cy)).fill({ color: topC }).stroke({ color: ink, width: 1 });
  }

  /** Colony: a hex platform topped with a small cluster of red iso towers. */
  private drawColony(g: Graphics, cx: number, cy: number, s: number, color: number): void {
    const topC = tint(color, 0.42);
    const rightC = color;
    const leftC = tint(color, -0.32) >>> 0;
    this.isoHexBase(g, cx, cy + s * 0.45, s, tint(color, 0.18), leftC);
    // Towers, drawn back-to-front for correct overlap.
    this.isoTower(g, cx + s * 0.04, cy + s * 0.18, s * 0.34, s * 1.05, topC, leftC, rightC); // tall centre
    this.isoTower(g, cx - s * 0.42, cy + s * 0.4, s * 0.26, s * 0.6, topC, leftC, rightC);
    this.isoTower(g, cx + s * 0.44, cy + s * 0.46, s * 0.24, s * 0.48, topC, leftC, rightC);
  }

  /** Spaceport: a bigger platform with a denser, taller cluster of towers. */
  private drawSpaceport(g: Graphics, cx: number, cy: number, s: number, color: number): void {
    const topC = tint(color, 0.42);
    const rightC = color;
    const leftC = tint(color, -0.32) >>> 0;
    this.isoHexBase(g, cx, cy + s * 0.55, s * 1.18, tint(color, 0.18), leftC);
    // Back row.
    this.isoTower(g, cx - s * 0.36, cy + s * 0.1, s * 0.28, s * 0.9, topC, leftC, rightC);
    this.isoTower(g, cx + s * 0.36, cy + s * 0.14, s * 0.26, s * 0.78, topC, leftC, rightC);
    // Tall central spire.
    this.isoTower(g, cx + s * 0.02, cy + s * 0.22, s * 0.32, s * 1.55, topC, leftC, rightC);
    // Front row (shorter, overlaps the back).
    this.isoTower(g, cx - s * 0.5, cy + s * 0.5, s * 0.24, s * 0.55, topC, leftC, rightC);
    this.isoTower(g, cx + s * 0.46, cy + s * 0.54, s * 0.26, s * 0.66, topC, leftC, rightC);
    // Beacon atop the spire.
    g.circle(cx + s * 0.02, cy - s * 1.33 + s * 0.22, s * 0.16).fill({ color: 0xffd23f }).stroke({ color: 0x0a0f1e, width: 1 });
  }

  /**
   * Owner-coloured rocket piece resting on a pedestal — echoes the printed
   * plastic ships (chunky horizontal rocket on a hex/cylinder stand). Drawn into
   * an existing Graphics `g`, centred at (sx,sy), nose pointing right, ~2.4r wide.
   * Colony ships sit on a hex pedestal with a porthole; trade ships on a
   * cylindrical pedestal with a cargo band.
   */
  private drawShip(
    g: Graphics,
    kind: "colonyShip" | "tradeShip",
    sx: number,
    sy: number,
    r: number,
    color: number,
  ): void {
    const ink = 0x0a0f1e;
    const dark = tint(color, -0.28) >>> 0;
    const lite = tint(color, 0.5);
    const rocketY = sy - r * 0.42; // rocket sits above the pedestal
    const bodyR = r * 0.4;
    const noseX = sx + r * 1.05;
    const tailX = sx - r * 0.95;

    // --- Pedestal ---
    if (kind === "colonyShip") {
      this.isoHexBase(g, sx, sy + r * 0.55, r * 0.62, tint(color, 0.18), dark);
    } else {
      // Cylindrical stand.
      g.roundRect(sx - r * 0.5, sy + r * 0.18, r, r * 0.7, r * 0.18).fill({ color }).stroke({ color: ink, width: 1 });
      g.ellipse(sx, sy + r * 0.18, r * 0.5, r * 0.2).fill({ color: tint(color, 0.18) }).stroke({ color: ink, width: 1 });
    }
    // Neck connecting rocket to pedestal.
    g.rect(sx - r * 0.12, rocketY, r * 0.24, r * 0.85).fill({ color: dark }).stroke({ color: ink, width: 0.8 });

    // --- Rocket (horizontal) ---
    // Tail fins.
    g.poly([tailX + r * 0.25, rocketY - bodyR, tailX - r * 0.25, rocketY - bodyR * 2, tailX + r * 0.15, rocketY])
      .fill({ color: dark }).stroke({ color: ink, width: 0.8 });
    g.poly([tailX + r * 0.25, rocketY + bodyR, tailX - r * 0.25, rocketY + bodyR * 2, tailX + r * 0.15, rocketY])
      .fill({ color: dark }).stroke({ color: ink, width: 0.8 });
    // Fuselage.
    g.roundRect(tailX, rocketY - bodyR, noseX - r * 0.35 - tailX, bodyR * 2, bodyR * 0.9)
      .fill({ color }).stroke({ color: ink, width: 1.2 });
    // Nose cone.
    g.poly([noseX, rocketY, sx + r * 0.4, rocketY - bodyR, sx + r * 0.4, rocketY + bodyR])
      .fill({ color: dark }).stroke({ color: ink, width: 1.2 });
    // Sheen along the top of the hull.
    g.roundRect(tailX + r * 0.1, rocketY - bodyR * 0.78, (noseX - r * 0.5) - tailX, bodyR * 0.5, bodyR * 0.3)
      .fill({ color: 0xffffff, alpha: 0.25 });
    // Distinguishing detail.
    if (kind === "colonyShip") {
      g.circle(sx - r * 0.05, rocketY, bodyR * 0.62).fill({ color: lite }).stroke({ color: ink, width: 1 });
    } else {
      g.rect(sx - r * 0.35, rocketY - bodyR, r * 0.5, bodyR * 2).fill({ color: lite }).stroke({ color: ink, width: 1 });
    }
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
   * Alien outpost station: a dark navy tri-lobe hub with six docking nodes and
   * teal connector struts, echoing the printed outpost tokens. The civ emblem is
   * layered on top by `drawCivIcon`.
   */
  private drawOutpost(layer: Container, cx: number, cy: number, scale: number, color: number): void {
    const navy = 0x18253f;
    const navyHi = 0x24365a;
    const edge = 0x0a1222;
    const teal = 0x3fd0d6;
    const node = tint(color, 0.35);
    const station = new Graphics();
    const lobeDist = scale * 0.4;
    const lobeR = scale * 0.34;
    // Three rounded lobes around the hub (trefoil silhouette).
    for (let i = 0; i < 3; i++) {
      const a = (-Math.PI / 2) + (Math.PI * 2 * i) / 3;
      station.circle(cx + Math.cos(a) * lobeDist, cy + Math.sin(a) * lobeDist, lobeR);
    }
    station.circle(cx, cy, scale * 0.32);
    station.fill({ color: navy }).stroke({ color: edge, width: 2 });
    // Hub highlight.
    station.circle(cx, cy, scale * 0.3).fill({ color: navyHi, alpha: 0.5 });

    // Docking nodes: two per lobe on the outer arc, with teal struts to the hub.
    for (let i = 0; i < 3; i++) {
      const base = (-Math.PI / 2) + (Math.PI * 2 * i) / 3;
      for (const off of [-0.42, 0.42]) {
        const a = base + off;
        const nd = lobeDist + lobeR * 0.55;
        const nx = cx + Math.cos(a) * nd;
        const ny = cy + Math.sin(a) * nd;
        this.strokeLine(station, cx, cy, nx, ny, scale * 0.03, teal, 0.85);
        station.circle(nx, ny, scale * 0.1).fill({ color: edge }).stroke({ color: node, width: 1.4 });
        station.circle(nx, ny, scale * 0.045).fill({ color: node });
      }
    }
    layer.addChild(station);
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

  /**
   * Measure how far the persistent HUD panels (left fleet sidebar, right
   * scoreboard) intrude from each side, in canvas pixels. The board is centered
   * within the *visible* region between them rather than the raw window, so the
   * map never looks shifted toward one side behind a panel. Self-adjusts when a
   * panel collapses/shrinks (e.g. on mobile) because it's read every render.
   */
  private playInsets(): { left: number; right: number } {
    const w = this.app.screen.width;
    const ins = { left: 0, right: 0 };
    const measure = (sel: string, side: "left" | "right"): void => {
      const node = document.querySelector(sel) as HTMLElement | null;
      if (!node) return;
      const r = node.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return; // hidden/unmounted
      if (side === "left") ins.left = Math.max(ins.left, r.right);
      else ins.right = Math.max(ins.right, w - r.left);
    };
    measure(".sidebar-left", "left");
    measure(".scoreboard", "right");
    // Never let the panels claim more than 35% of the width each — keeps the
    // map a sensible size on narrow screens where panels are proportionally big.
    ins.left = Math.max(0, Math.min(ins.left, w * 0.35));
    ins.right = Math.max(0, Math.min(ins.right, w * 0.35));
    return ins;
  }

  /** Fit the board's bounding box into the visible play area with padding. */
  private computeTransform(state: GameState): { scale: number; ox: number; oy: number } {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const inter of Object.values(state.intersections)) {
      xs.push(inter.x);
      ys.push(inter.y);
    }
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    this.contentBounds = { minX, maxX, minY, maxY };
    const w = this.app.screen.width;
    const h = this.app.screen.height;
    const pad = 80;
    // Center within the gap between the side panels, not the whole window.
    const ins = this.playInsets();
    const availLeft = ins.left + pad;
    const availRight = w - ins.right - pad;
    const availW = Math.max(1, availRight - availLeft);
    const availH = Math.max(1, h - pad * 2);
    const sx = availW / (maxX - minX || 1);
    const sy = availH / (maxY - minY || 1);
    const scale = Math.min(sx, sy);
    const regionCx = (availLeft + availRight) / 2;
    const ox = regionCx - ((maxX + minX) / 2) * scale;
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
