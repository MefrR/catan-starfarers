/**
 * Aurora backdrop for the main-menu screens: drifting nebula ribbons rendered
 * by a small ORIGINAL WebGL2 fragment shader (layered value-noise fbm bands in
 * the game's blue→violet→teal palette) over a sparse twinkling starfield.
 *
 * Self-managing: mount() inserts a canvas behind the screen's content; the
 * render loop stops itself the moment the canvas leaves the DOM (the menu
 * navigated away), so callers never need to track teardown.
 *
 * Renders at half resolution — it's a soft, blurry background by nature, so
 * the GPU cost stays negligible next to the game board.
 */

const FRAG = `#version 300 es
precision highp float;
out vec4 O;
uniform vec2 R;
uniform float T;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash(i), hash(i + vec2(1, 0)), f.x),
    mix(hash(i + vec2(0, 1)), hash(i + 1.0), f.x),
    f.y
  );
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.07 + 11.3;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * R) / R.y;
  vec3 col = vec3(0.012, 0.016, 0.05); // deep-space base

  // Three aurora ribbons at different heights, drifting at different speeds.
  for (float i = 0.0; i < 3.0; i++) {
    float wave = fbm(vec2(uv.x * 1.4 + T * (0.05 + 0.02 * i), i * 7.0));
    float yy = uv.y + 0.28 - 0.24 * i + 0.2 * wave;
    float band = exp(-abs(yy) * (7.0 - 1.5 * i));
    vec3 tint = mix(vec3(0.18, 0.45, 0.95), vec3(0.62, 0.30, 0.95), i * 0.5);
    tint = mix(tint, vec3(0.20, 0.85, 0.75), 0.25 * (0.5 + 0.5 * sin(T * 0.1 + i * 2.0)));
    col += band * tint * (0.30 + 0.18 * fbm(uv * 3.0 + vec2(T * 0.08, i)));
  }

  // Sparse twinkling stars.
  vec2 cell = floor(gl_FragCoord.xy / 3.0);
  float star = step(0.9985, hash(cell));
  col += star * vec3(0.9) * (0.5 + 0.5 * sin(T * 2.0 + hash(cell) * 60.0));

  // Vignette so the center (where the menu card sits) stays calm.
  col *= 1.0 - 0.45 * dot(uv, uv);
  O = vec4(col, 1.0);
}`;

const VERT = `#version 300 es
in vec4 position;
void main() { gl_Position = position; }`;

export class AuroraBg {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private raf = 0;
  private uTime: WebGLUniformLocation | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private start = performance.now();

  /** Insert the aurora canvas as the first child of `parent` (behind content). */
  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "menu-aurora";
    parent.prepend(this.canvas);
    this.gl = this.canvas.getContext("webgl2");
    if (!this.gl) return; // no WebGL2 — the static CSS background remains
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
        console.warn("aurora shader:", gl.getShaderInfoLog(sh));
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
    // Half-resolution render — soft background, big GPU savings.
    const s = 0.5 * Math.min(window.devicePixelRatio, 2);
    this.canvas.width = Math.max(2, Math.floor(window.innerWidth * s));
    this.canvas.height = Math.max(2, Math.floor(window.innerHeight * s));
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  };

  private frame = (): void => {
    // Self-teardown: the menu replaced its screen — stop rendering for good.
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
