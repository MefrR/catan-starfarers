/**
 * Racing light streaks behind the center-screen shaker overlay.
 *
 * The fragment shader is used VERBATIM from the Hero component snippet the
 * project owner supplied and asked to use exactly (shader by Matthias Hurrle
 * @atzedent — attribution preserved below), with ONE removal at the owner's
 * direction: the smoke-cloud background mix line, so only the racing lights
 * remain ("take the code without the background"). The plumbing (a minimal
 * WebGL2 quad renderer) is ours.
 *
 * The canvas mounts inside the shake overlay's .shake-stars layer and is
 * screen-blended, so the black shader background contributes nothing and the
 * lights race OVER the live board. The render loop stops itself when the
 * overlay (and so the canvas) leaves the DOM.
 */

const FRAG = `#version 300 es
/*********
* made by Matthias Hurrle (@atzedent)
*
*	To explore strange new worlds, to seek out new life
*	and new civilizations, to boldly go where no man has
*	gone before.
*/
precision highp float;
out vec4 O;
uniform vec2 resolution;
uniform float time;
#define FC gl_FragCoord.xy
#define T time
#define R resolution
#define MN min(R.x,R.y)
// Returns a pseudo random number for a given point (white noise)
float rnd(vec2 p) {
  p=fract(p*vec2(12.9898,78.233));
  p+=dot(p,p+34.56);
  return fract(p.x*p.y);
}
// Returns a pseudo random number for a given point (value noise)
float noise(in vec2 p) {
  vec2 i=floor(p), f=fract(p), u=f*f*(3.-2.*f);
  float
  a=rnd(i),
  b=rnd(i+vec2(1,0)),
  c=rnd(i+vec2(0,1)),
  d=rnd(i+1.);
  return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);
}
// Returns a pseudo random number for a given point (fractal noise)
float fbm(vec2 p) {
  float t=.0, a=1.; mat2 m=mat2(1.,-.5,.2,1.2);
  for (int i=0; i<5; i++) {
    t+=a*noise(p);
    p*=2.*m;
    a*=.5;
  }
  return t;
}
float clouds(vec2 p) {
	float d=1., t=.0;
	for (float i=.0; i<3.; i++) {
		float a=d*fbm(i*10.+p.x*.2+.2*(1.+i)*p.y+d+i*i+p);
		t=mix(t,d,a);
		d=a;
		p*=2./(i+1.);
	}
	return t;
}
void main(void) {
	vec2 uv=(FC-.5*R)/MN,st=uv*vec2(2,1);
	vec3 col=vec3(0);
	float bg=clouds(vec2(st.x+T*.5,-st.y));
	uv*=1.-.3*(sin(T*.2)*.5+.5);
	for (float i=1.; i<12.; i++) {
		uv+=.1*cos(i*vec2(.1+.01*i, .8)+i*i+T*.5+.1*uv.x);
		vec2 p=uv;
		float d=length(p);
		col+=.00125/d*(cos(sin(i)*vec3(1,2,3))+1.);
		float b=noise(i+p+bg*1.731);
		col+=.002*b/length(max(p,vec2(b*p.x*.02,p.y)));
		// (background cloud mix removed at the owner's direction — lights only)
	}
	O=vec4(col,1);
}`;

const VERT = `#version 300 es
precision highp float;
in vec4 position;
void main(){gl_Position=position;}`;

export class ShakerStreaks {
  private canvas: HTMLCanvasElement;
  private gl: WebGL2RenderingContext | null;
  private raf = 0;
  private uTime: WebGLUniformLocation | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private start = performance.now();

  constructor(parent: HTMLElement) {
    this.canvas = document.createElement("canvas");
    parent.appendChild(this.canvas);
    this.gl = this.canvas.getContext("webgl2");
    if (!this.gl) return; // no WebGL2 — the shaker just has no streaks
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
        console.warn("streaks shader:", gl.getShaderInfoLog(sh));
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
    this.uTime = gl.getUniformLocation(prog, "time");
    this.uRes = gl.getUniformLocation(prog, "resolution");
    return true;
  }

  private resize = (): void => {
    // Same sizing rule as the original component: max(1, 0.5 * dpr).
    const s = Math.max(1, 0.5 * window.devicePixelRatio);
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
