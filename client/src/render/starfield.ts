import { Application, Container, Graphics, type Renderer } from "pixi.js";

interface Star {
  g: Graphics;
  depth: number; // 0..1, parallax factor
  baseAlpha: number;
  twinklePhase: number;
  baseX: number;
  baseY: number; // drifts downward; the rendered y = base + mouse parallax
}

/**
 * Animated parallax starfield with drifting nebula glow.
 * This is the persistent 2.5D backdrop behind the board and UI.
 *
 * The whole field reacts to the mouse with a springy parallax: nearer stars
 * (higher depth) shift more than distant ones, so moving the pointer makes the
 * sky feel deep. The offset follows a damped spring, so it glides and settles
 * rather than tracking the cursor rigidly.
 */
export class Starfield {
  readonly app: Application;
  private stars: Star[] = [];
  private layer = new Container();
  private nebula = new Container();
  private nebulaBase: { x: number; y: number }[] = [];
  private t = 0;
  // Mouse-parallax spring state: target (tx,ty) set by pointer moves, the
  // current offset (x,y) + velocity integrated toward it every frame.
  private par = { tx: 0, ty: 0, x: 0, y: 0, vx: 0, vy: 0 };

  private constructor(app: Application) {
    this.app = app;
  }

  static async create(canvas: HTMLCanvasElement): Promise<Starfield> {
    const app = new Application();
    await app.init({
      canvas,
      resizeTo: window,
      antialias: true,
      backgroundColor: 0x05060f,
      resolution: Math.min(window.devicePixelRatio, 2),
      autoDensity: true,
    });
    const field = new Starfield(app);
    field.build();
    app.ticker.add((ticker) => field.update(ticker.deltaTime));
    // Pointer parallax: offset away from the cursor (so the sky "leans back"),
    // scaled down — the spring in update() smooths the motion.
    window.addEventListener("pointermove", (e) => {
      const cx = window.innerWidth / 2;
      const cy = window.innerHeight / 2;
      field.par.tx = -(e.clientX - cx) * 0.035;
      field.par.ty = -(e.clientY - cy) * 0.035;
    });
    return field;
  }

  private build(): void {
    const { width, height } = this.app.renderer;
    this.app.stage.addChild(this.nebula);
    this.app.stage.addChild(this.layer);

    // Soft nebula clouds for depth.
    const clouds: Array<[number, number, number, number]> = [
      [0x3a2a6b, 0.18, 0.22, 0.32],
      [0x1f4f7a, 0.78, 0.7, 0.4],
      [0x6b2a55, 0.55, 0.35, 0.26],
    ];
    for (const [color, fx, fy, fr] of clouds) {
      const r = Math.max(width, height) * fr;
      const cloud = new Graphics().circle(0, 0, r).fill({ color, alpha: 0.14 });
      cloud.x = width * fx;
      cloud.y = height * fy;
      this.nebula.addChild(cloud);
      this.nebulaBase.push({ x: cloud.x, y: cloud.y });
    }

    const count = Math.floor((width * height) / 2600);
    for (let i = 0; i < count; i++) {
      const depth = Math.random();
      const size = 0.4 + depth * 1.6;
      const baseAlpha = 0.25 + depth * 0.75;
      const tint = depth > 0.7 ? 0xbfd4ff : 0xffffff;
      const g = new Graphics().circle(0, 0, size).fill({ color: tint, alpha: baseAlpha });
      const x = Math.random() * width;
      const y = Math.random() * height;
      g.x = x;
      g.y = y;
      this.layer.addChild(g);
      this.stars.push({ g, depth, baseAlpha, twinklePhase: Math.random() * Math.PI * 2, baseX: x, baseY: y });
    }
  }

  private update(delta: number): void {
    this.t += delta * 0.016;
    const h = (this.app.renderer as Renderer).height;

    // Integrate the parallax spring (semi-implicit, dt clamped for stability).
    const dt = Math.min(0.05, delta * 0.0167);
    const K = 42; // stiffness
    const D = 9; // damping
    this.par.vx += (this.par.tx - this.par.x) * K * dt;
    this.par.vy += (this.par.ty - this.par.y) * K * dt;
    const decay = Math.exp(-D * dt);
    this.par.vx *= decay;
    this.par.vy *= decay;
    this.par.x += this.par.vx * dt;
    this.par.y += this.par.vy * dt;

    for (const s of this.stars) {
      // Gentle downward drift, faster for nearer (high-depth) stars.
      s.baseY += (0.05 + s.depth * 0.25) * delta;
      if (s.baseY > h) s.baseY = 0;
      // Parallax: nearer stars follow the mouse offset more.
      s.g.x = s.baseX + this.par.x * s.depth;
      s.g.y = s.baseY + this.par.y * s.depth;
      s.g.alpha = s.baseAlpha * (0.7 + 0.3 * Math.sin(this.t * 1.5 + s.twinklePhase));
    }
    this.nebula.children.forEach((c, i) => {
      c.alpha = 0.12 + 0.04 * Math.sin(this.t * 0.2 + i);
      // Clouds are the farthest layer — they barely move.
      const base = this.nebulaBase[i];
      if (base) {
        c.x = base.x + this.par.x * 0.15;
        c.y = base.y + this.par.y * 0.15;
      }
    });
  }
}
