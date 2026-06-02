import { Application, Container, Graphics, type Renderer } from "pixi.js";

interface Star {
  g: Graphics;
  depth: number; // 0..1, parallax factor
  baseAlpha: number;
  twinklePhase: number;
}

/**
 * Animated parallax starfield with drifting nebula glow.
 * This is the persistent 2.5D backdrop behind the board and UI.
 */
export class Starfield {
  readonly app: Application;
  private stars: Star[] = [];
  private layer = new Container();
  private nebula = new Container();
  private t = 0;

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
    }

    const count = Math.floor((width * height) / 2600);
    for (let i = 0; i < count; i++) {
      const depth = Math.random();
      const size = 0.4 + depth * 1.6;
      const baseAlpha = 0.25 + depth * 0.75;
      const tint = depth > 0.7 ? 0xbfd4ff : 0xffffff;
      const g = new Graphics().circle(0, 0, size).fill({ color: tint, alpha: baseAlpha });
      g.x = Math.random() * width;
      g.y = Math.random() * height;
      this.layer.addChild(g);
      this.stars.push({ g, depth, baseAlpha, twinklePhase: Math.random() * Math.PI * 2 });
    }
  }

  private update(delta: number): void {
    this.t += delta * 0.016;
    const h = (this.app.renderer as Renderer).height;
    for (const s of this.stars) {
      // Gentle downward drift, faster for nearer (high-depth) stars.
      s.g.y += (0.05 + s.depth * 0.25) * delta;
      if (s.g.y > h) s.g.y = 0;
      s.g.alpha = s.baseAlpha * (0.7 + 0.3 * Math.sin(this.t * 1.5 + s.twinklePhase));
    }
    this.nebula.children.forEach((c, i) => {
      c.alpha = 0.12 + 0.04 * Math.sin(this.t * 0.2 + i);
    });
  }
}
