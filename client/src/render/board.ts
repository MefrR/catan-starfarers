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
        this.zoomToward(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      },
      { passive: false },
    );

    // Track every active pointer so we can tell one-finger pan from a pinch.
    const pts = new Map<number, { x: number; y: number }>();
    let moved = false;
    let pinchDist = 0;
    let pinchMid = { x: 0, y: 0 };

    canvas.addEventListener("pointerdown", (e: PointerEvent) => {
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
      pts.delete(e.pointerId);
      if (pts.size < 2) pinchDist = 0;
      if (pts.size === 0) canvas.style.cursor = "";
    };
    window.addEventListener("pointerup", endPointer);
    window.addEventListener("pointercancel", endPointer);
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

  /** PDF-style resource glyph centred at (x,y), sized to radius r. */
  private drawResourceGlyph(layer: Container, res: Resource, x: number, y: number, r: number): void {
    const ink = 0xf4f7ff;
    const g = new Graphics();
    switch (res) {
      case "ore": {
        // Flat-top hexagon.
        const pts: number[] = [];
        for (let i = 0; i < 6; i++) {
          const a = (Math.PI / 180) * (60 * i);
          pts.push(x + r * Math.cos(a), y + r * Math.sin(a));
        }
        g.poly(pts).fill({ color: ink, alpha: 0.92 }).stroke({ color: 0x05060f, width: 1 });
        break;
      }
      case "carbon": {
        // Triangle subdivided into four by midpoint lines.
        const A = { x, y: y - r };
        const B = { x: x - r * 0.92, y: y + r * 0.72 };
        const C = { x: x + r * 0.92, y: y + r * 0.72 };
        const mAB = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
        const mBC = { x: (B.x + C.x) / 2, y: (B.y + C.y) / 2 };
        const mCA = { x: (C.x + A.x) / 2, y: (C.y + A.y) / 2 };
        g.poly([A.x, A.y, B.x, B.y, C.x, C.y])
          .fill({ color: ink, alpha: 0.9 })
          .stroke({ color: 0x05060f, width: 1 });
        g.moveTo(mAB.x, mAB.y)
          .lineTo(mBC.x, mBC.y)
          .lineTo(mCA.x, mCA.y)
          .lineTo(mAB.x, mAB.y)
          .stroke({ color: 0x05060f, width: 1, alpha: 0.8 });
        break;
      }
      case "fuel": {
        // Teardrop: pointed top, round bottom.
        g.moveTo(x, y - r)
          .quadraticCurveTo(x + r * 0.95, y, x, y + r)
          .quadraticCurveTo(x - r * 0.95, y, x, y - r)
          .fill({ color: ink, alpha: 0.92 })
          .stroke({ color: 0x05060f, width: 1 });
        break;
      }
      case "food": {
        // Concentric rings.
        g.circle(x, y, r).stroke({ color: ink, width: Math.max(1.5, r * 0.22) });
        g.circle(x, y, r * 0.45).fill({ color: ink, alpha: 0.92 });
        break;
      }
      case "goods": {
        // Isometric cube/crate.
        const s = r * 0.82;
        const top = [x, y - s, x + s, y - s * 0.5, x, y, x - s, y - s * 0.5];
        g.poly(top).fill({ color: ink, alpha: 0.95 }).stroke({ color: 0x05060f, width: 1 });
        g.poly([x - s, y - s * 0.5, x, y, x, y + s, x - s, y + s * 0.5]).fill({
          color: ink,
          alpha: 0.6,
        });
        g.poly([x + s, y - s * 0.5, x, y, x, y + s, x + s, y + s * 0.5]).fill({
          color: ink,
          alpha: 0.78,
        });
        break;
      }
    }
    layer.addChild(g);
  }

  /** Colony icon: a domed habitat module with a base, in the owner colour. */
  private drawColony(g: Graphics, cx: number, cy: number, s: number, color: number): void {
    const dark = 0x0a0f1e;
    const base = cy + s * 0.7;
    // Dome.
    g.moveTo(cx - s, base)
      .lineTo(cx - s, cy)
      .arc(cx, cy, s, Math.PI, 0)
      .lineTo(cx + s, base)
      .closePath()
      .fill({ color })
      .stroke({ color: 0xffffff, width: 1.5, alpha: 0.9 });
    // Window band.
    g.rect(cx - s * 0.55, cy + s * 0.05, s * 1.1, s * 0.3)
      .fill({ color: tint(color, 0.6) })
      .stroke({ color: dark, width: 0.8 });
    // Antenna mast.
    g.moveTo(cx, cy - s).lineTo(cx, cy - s * 1.5).stroke({ color: 0xffffff, width: 1.4, alpha: 0.9 });
    g.circle(cx, cy - s * 1.5, s * 0.16).fill({ color: tint(color, 0.7) });
  }

  /** Spaceport icon: a colony dome topped with a launch tower & gantry. */
  private drawSpaceport(g: Graphics, cx: number, cy: number, s: number, color: number): void {
    const dark = 0x0a0f1e;
    const base = cy + s * 0.8;
    // Wider habitat base.
    g.moveTo(cx - s, base)
      .lineTo(cx - s, cy + s * 0.1)
      .arc(cx, cy + s * 0.1, s, Math.PI, 0)
      .lineTo(cx + s, base)
      .closePath()
      .fill({ color })
      .stroke({ color: 0xffffff, width: 2.4, alpha: 0.95 });
    // Launch tower.
    const tw = s * 0.34;
    g.rect(cx - tw, cy - s * 1.5, tw * 2, s * 1.5)
      .fill({ color: tint(color, -0.2) >>> 0 })
      .stroke({ color: 0xffffff, width: 1.4, alpha: 0.9 });
    // Tower cross-braces.
    g.moveTo(cx - tw, cy - s).lineTo(cx + tw, cy - s * 0.6)
      .moveTo(cx - tw, cy - s * 0.6).lineTo(cx + tw, cy - s)
      .stroke({ color: dark, width: 1 });
    // Beacon.
    g.circle(cx, cy - s * 1.5, s * 0.2).fill({ color: 0xffd23f }).stroke({ color: dark, width: 1 });
  }

  /**
   * Owner-coloured rocket piece (matches the printed plastic ships). Drawn into
   * an existing Graphics `g` centred at (sx,sy), nose pointing up, height ~2r.
   * Colony ships get a rounded capsule nose; trade ships a pointed nose + a
   * cargo band so the two read apart at a glance.
   */
  private drawShip(
    g: Graphics,
    kind: "colonyShip" | "tradeShip",
    sx: number,
    sy: number,
    r: number,
    color: number,
  ): void {
    const bodyW = r * 0.7; // half-width of the fuselage
    const top = sy - r * 1.15;
    const bottom = sy + r * 0.95;
    const dark = 0x0a0f1e;

    // Exhaust flame beneath the engine.
    g.poly([sx - bodyW * 0.7, bottom, sx, bottom + r * 0.7, sx + bodyW * 0.7, bottom])
      .fill({ color: 0xffb347, alpha: 0.85 });

    // Fins flaring out at the base.
    g.poly([sx - bodyW, bottom - r * 0.1, sx - bodyW * 1.7, bottom + r * 0.25, sx - bodyW, bottom - r * 0.55])
      .fill({ color: tint(color, -0.25) >>> 0 });
    g.poly([sx + bodyW, bottom - r * 0.1, sx + bodyW * 1.7, bottom + r * 0.25, sx + bodyW, bottom - r * 0.55])
      .fill({ color: tint(color, -0.25) >>> 0 });

    // Fuselage: rounded body with a nose that differs by ship kind.
    const noseTip = kind === "colonyShip" ? top + r * 0.18 : top;
    g.moveTo(sx - bodyW, bottom - r * 0.1)
      .lineTo(sx - bodyW, sy - r * 0.35)
      .quadraticCurveTo(sx - bodyW, noseTip, sx, top)
      .quadraticCurveTo(sx + bodyW, noseTip, sx + bodyW, sy - r * 0.35)
      .lineTo(sx + bodyW, bottom - r * 0.1)
      .closePath()
      .fill({ color })
      .stroke({ color: dark, width: 1.5 });

    // Sheen down the left of the hull.
    g.poly([sx - bodyW * 0.55, sy - r * 0.2, sx - bodyW * 0.2, sy - r * 0.2, sx - bodyW * 0.2, sy + r * 0.4, sx - bodyW * 0.55, sy + r * 0.4])
      .fill({ color: 0xffffff, alpha: 0.22 });

    // Porthole (colony) or cargo band (trade) to tell them apart.
    if (kind === "colonyShip") {
      g.circle(sx, sy - r * 0.15, bodyW * 0.42)
        .fill({ color: tint(color, 0.6) })
        .stroke({ color: dark, width: 1 });
    } else {
      g.rect(sx - bodyW, sy + r * 0.0, bodyW * 2, r * 0.34)
        .fill({ color: tint(color, 0.5) })
        .stroke({ color: dark, width: 1 });
    }
  }

  /** Alien outpost in its civ colour: lattice ring with five docking points. */
  private drawOutpost(layer: Container, cx: number, cy: number, scale: number, color: number): void {
    const station = new Graphics()
      .circle(cx, cy, scale * 0.3)
      .fill({ color, alpha: 0.16 })
      .stroke({ color, width: 2, alpha: 0.85 });
    station.circle(cx, cy, scale * 0.16).fill({ color, alpha: 0.92 });
    // Radial docking arms.
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      const r0 = scale * 0.16;
      const r1 = scale * 0.3;
      const dx = Math.cos(a);
      const dy = Math.sin(a);
      station.moveTo(cx + dx * r0, cy + dy * r0).lineTo(cx + dx * r1, cy + dy * r1);
    }
    station.stroke({ color, width: 1.5, alpha: 0.7 });
    // Bright docking-point dots (lighter tint of the civ colour).
    for (let i = 0; i < 5; i++) {
      const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
      const r1 = scale * 0.33;
      station.circle(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1, scale * 0.04).fill({
        color: tint(color, 0.55),
      });
    }
    layer.addChild(station);
  }

  /** A distinct civ emblem drawn on top of the outpost station core. */
  private drawCivIcon(layer: Container, cx: number, cy: number, scale: number, civ: string, color: number): void {
    const g = new Graphics();
    const s = scale * 0.13;
    const ink = 0x0a0f1e;
    const light = tint(color, 0.7);
    switch (civ) {
      case "greenFolk": {
        // Leaf / sprout.
        g.moveTo(cx, cy + s)
          .quadraticCurveTo(cx - s, cy, cx, cy - s)
          .quadraticCurveTo(cx + s, cy, cx, cy + s)
          .fill({ color: light })
          .stroke({ color: ink, width: 1.5 });
        g.moveTo(cx, cy + s * 0.6).lineTo(cx, cy - s * 0.6).stroke({ color: ink, width: 1.2 });
        break;
      }
      case "scientists": {
        // Atom: nucleus + two orbital rings.
        g.circle(cx, cy, s * 0.35).fill({ color: light }).stroke({ color: ink, width: 1.2 });
        g.ellipse(cx, cy, s, s * 0.42).stroke({ color: ink, width: 1.4 });
        g.ellipse(cx, cy, s * 0.42, s).stroke({ color: ink, width: 1.4 });
        break;
      }
      case "diplomats": {
        // Dove / peace: simple bird chevron over a dot.
        g.moveTo(cx - s, cy).quadraticCurveTo(cx, cy - s * 0.9, cx, cy)
          .quadraticCurveTo(cx, cy - s * 0.9, cx + s, cy)
          .stroke({ color: ink, width: 1.6 });
        g.circle(cx, cy + s * 0.4, s * 0.28).fill({ color: light }).stroke({ color: ink, width: 1 });
        break;
      }
      case "merchants": {
        // Coin with a value mark.
        g.circle(cx, cy, s * 0.85).fill({ color: light }).stroke({ color: ink, width: 1.5 });
        g.moveTo(cx, cy - s * 0.5).lineTo(cx, cy + s * 0.5).stroke({ color: ink, width: 1.6 });
        g.moveTo(cx - s * 0.3, cy - s * 0.2).quadraticCurveTo(cx + s * 0.4, cy - s * 0.4, cx + s * 0.3, cy)
          .stroke({ color: ink, width: 1.2 });
        break;
      }
      default: {
        // Travelers / generic: four-point star.
        g.poly([cx, cy - s, cx + s * 0.3, cy - s * 0.3, cx + s, cy, cx + s * 0.3, cy + s * 0.3,
                cx, cy + s, cx - s * 0.3, cy + s * 0.3, cx - s, cy, cx - s * 0.3, cy - s * 0.3])
          .fill({ color: light }).stroke({ color: ink, width: 1.2 });
      }
    }
    layer.addChild(g);
  }

  /** Fit the board's bounding box into the viewport with padding. */
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
    const w = this.app.screen.width;
    const h = this.app.screen.height;
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
