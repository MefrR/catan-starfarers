/**
 * Menu backdrop: a black void crossed by falling neon comet streaks (blue /
 * teal / green / violet) — thin diagonal light trails with bright heads,
 * drifting at different speeds. Rendered by a small ORIGINAL WebGL2 fragment
 * shader (no three.js, no copied shader code).
 *
 * Lifecycle: the canvas is appended to <body> (above the board canvas, below
 * the #app screens) and persists across ALL menu screens — landing, the
 * single-player setup, and the multiplayer lobby — until destroy() is called
 * when a game mounts. A safety check also stops the loop if the canvas ever
 * leaves the DOM.
 *
 * Renders at half resolution — it's a soft glow background; the cost is tiny.
 */

const FRAG = `#version 300 es
precision highp float;
out vec4 O;
uniform vec2 R;
uniform float T;

float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * R) / R.y;
  // All comets travel along one shared diagonal (down-and-leftward streaks,
  // like a meteor shower crossing the screen).
  vec2 dir = normalize(vec2(-0.78, -0.62));
  vec2 ort = vec2(-dir.y, dir.x);
  float along = dot(uv, dir);
  float ortho = dot(uv, ort);

  vec3 col = vec3(0.004, 0.005, 0.011); // near-black space base

  const float N = 26.0;
  for (float i = 0.0; i < N; i++) {
    float seed = i + 1.0;
    // Each comet keeps its own lane, speed, cycle length and personality.
    float lane = (h1(seed * 1.31) - 0.5) * 2.1;
    float speed = 0.10 + h1(seed * 2.71) * 0.22;
    float period = 2.4 + h1(seed * 3.93) * 1.8;
    float head = mod(T * speed + h1(seed * 5.17) * period, period) - period * 0.5;
    float dx = along - head;       // <0 behind the head (the tail side)
    float dy = ortho - lane;

    // Tail: exponential falloff behind the head; razor-thin across the path.
    float tailLen = 4.5 + h1(seed * 7.73) * 6.0;
    float tail = dx < 0.0 ? exp(dx * tailLen) : 0.0;
    float thin = exp(-dy * dy * 9000.0);
    // Head: a small hot point with a tight halo (fine streaks, not orbs).
    float d2 = dx * dx + dy * dy;
    float headGlow = exp(-d2 * 16000.0) * 1.5 + exp(-d2 * 1400.0) * 0.16;

    // Palette: deep blue -> teal/green, with the occasional violet drifter.
    vec3 tint = mix(vec3(0.22, 0.42, 1.0), vec3(0.2, 0.95, 0.62), h1(seed * 9.37));
    tint = mix(tint, vec3(0.58, 0.38, 1.0), step(0.86, h1(seed * 11.13)) * 0.85);

    float size = 0.35 + h1(seed * 13.7) * 0.85; // faint far comets, bold near ones
    col += (tail * thin * 0.85 + headGlow) * tint * size;
  }

  // Gentle vignette keeps the center calm for the menu card.
  col *= 1.0 - 0.3 * dot(uv, uv);
  O = vec4(col, 1.0);
}`;

const VERT = `#version 300 es
in vec4 position;
void main() { gl_Position = position; }`;

export class CometField {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private raf = 0;
  private uTime: WebGLUniformLocation | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private start = performance.now();

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "menu-backdrop";
    document.body.appendChild(this.canvas);
    this.gl = this.canvas.getContext("webgl2");
    if (!this.gl) return; // no WebGL2 — the dark CSS background remains
    if (!this.setup()) {
      this.gl = null;
      return;
    }
    this.resize();
    window.addEventListener("resize", this.resize);
    this.raf = requestAnimationFrame(this.frame);
  }

  private setup(): boolean {
    const gl = this.gl!;
    const mk = (type: number, src: string): WebGLShader | null => {
      const sh = gl.createShader(type);
      if (!sh) return null;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        console.warn("comet shader:", gl.getShaderInfoLog(sh));
        gl.deleteShader(sh);
        return null;
      }
      return sh;
    };
    const vs = mk(gl.VERTEX_SHADER, VERT);
    const fs = mk(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) return false;
    const prog = gl.createProgram();
    if (!prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, 1, -1, -1, 1, 1, 1, -1]), gl.STATIC_DRAW);
    const pos = gl.getAttribLocation(prog, "position");
    gl.enableVertexAttribArray(pos);
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 0, 0);
    this.uTime = gl.getUniformLocation(prog, "T");
    this.uRes = gl.getUniformLocation(prog, "R");
    return true;
  }

  private resize = (): void => {
    const s = 0.5 * Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(2, Math.floor(window.innerWidth * s));
    this.canvas.height = Math.max(2, Math.floor(window.innerHeight * s));
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  };

  private frame = (): void => {
    if (!this.canvas.isConnected) {
      this.destroy();
      return;
    }
    const gl = this.gl;
    if (gl) {
      gl.uniform1f(this.uTime, (performance.now() - this.start) / 1000);
      gl.uniform2f(this.uRes, this.canvas.width, this.canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    this.raf = requestAnimationFrame(this.frame);
  };

  destroy(): void {
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.canvas.remove();
    this.gl = null;
  }
}
