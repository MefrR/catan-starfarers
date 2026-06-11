/**
 * Menu backdrop: falling neon comet streaks over a black void.
 *
 * The fragment shader is used VERBATIM from the React/three.js snippet the
 * project owner supplied and asked to use exactly (the "AnoAI" component) —
 * only the plumbing around it (a minimal raw-WebGL1 quad renderer with our
 * menu lifecycle) is ours. Sized at CSS pixels (dpr 1), like the original.
 *
 * Lifecycle: the canvas is appended to <body> (above the board canvas, below
 * the #app screens) and persists across ALL menu screens — landing, the
 * single-player setup, and the multiplayer lobby — until destroy() is called
 * when a game mounts. A safety check also stops the loop if the canvas ever
 * leaves the DOM.
 */

const FRAG = `#version 300 es
precision highp float;
out vec4 fragColor;

uniform float iTime;
uniform vec2 iResolution;

#define NUM_OCTAVES 3

float rand(vec2 n) {
  return fract(sin(dot(n, vec2(12.9898, 4.1414))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 ip = floor(p);
  vec2 u = fract(p);
  u = u*u*(3.0-2.0*u);

  float res = mix(
    mix(rand(ip), rand(ip + vec2(1.0, 0.0)), u.x),
    mix(rand(ip + vec2(0.0, 1.0)), rand(ip + vec2(1.0, 1.0)), u.x), u.y);
  return res * res;
}

float fbm(vec2 x) {
  float v = 0.0;
  float a = 0.3;
  vec2 shift = vec2(100);
  mat2 rot = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int i = 0; i < NUM_OCTAVES; ++i) {
    v += a * noise(x);
    x = rot * x * 2.0 + shift;
    a *= 0.4;
  }
  return v;
}

void main() {
  vec2 shake = vec2(sin(iTime * 1.2) * 0.005, cos(iTime * 2.1) * 0.005);
  vec2 p = ((gl_FragCoord.xy + shake * iResolution.xy) - iResolution.xy * 0.5) / iResolution.y * mat2(6.0, -4.0, 4.0, 6.0);
  vec2 v;
  vec4 o = vec4(0.0);

  float f = 2.0 + fbm(p + vec2(iTime * 5.0, 0.0)) * 0.5;

  for (float i = 0.0; i < 35.0; i++) {
    v = p + cos(i * i + (iTime + p.x * 0.08) * 0.025 + i * vec2(13.0, 11.0)) * 3.5 + vec2(sin(iTime * 3.0 + i) * 0.003, cos(iTime * 3.5 - i) * 0.003);
    float tailNoise = fbm(v + vec2(iTime * 0.5, i)) * 0.3 * (1.0 - (i / 35.0));
    vec4 auroraColors = vec4(
      0.1 + 0.3 * sin(i * 0.2 + iTime * 0.4),
      0.3 + 0.5 * cos(i * 0.3 + iTime * 0.5),
      0.7 + 0.3 * sin(i * 0.4 + iTime * 0.3),
      1.0
    );
    vec4 currentContribution = auroraColors * exp(sin(i * i + iTime * 0.8)) / length(max(v, vec2(v.x * f * 0.015, v.y * 1.5)));
    float thinnessFactor = smoothstep(0.0, 1.0, i / 35.0) * 0.6;
    o += currentContribution * (1.0 + tailNoise * 0.8) * thinnessFactor;
  }

  o = tanh(pow(o / 100.0, vec4(1.6)));
  fragColor = o * 1.5;
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
    this.uTime = gl.getUniformLocation(prog, "iTime");
    this.uRes = gl.getUniformLocation(prog, "iResolution");
    return true;
  }

  private resize = (): void => {
    // CSS-pixel sizing (dpr 1), matching the original component's setSize.
    this.canvas.width = Math.max(2, window.innerWidth);
    this.canvas.height = Math.max(2, window.innerHeight);
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
