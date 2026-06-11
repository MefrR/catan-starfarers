/**
 * Tiny synthesized SFX engine — every sound is generated live with the Web
 * Audio API (oscillators + filtered noise), so the game ships zero audio
 * assets. Volumes are deliberately gentle: the goal is tactile feedback, not
 * a slot machine.
 *
 * Browsers block audio until a user gesture, so the AudioContext is created
 * lazily on the first pointer/key input and resumed if the tab suspended it.
 */

export type SfxName =
  | "dice" // rolling clatter
  | "shake" // mothership ball rattle
  | "build" // piece lands with a soft thunk
  | "encounter" // dramatic two-note sting
  | "steal" // whoosh
  | "trade" // coin blip pair
  | "turn" // gentle "your turn" chime
  | "medal" // sparkle arpeggio (conquest medal / friendship marker)
  | "win"; // fanfare

class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private _muted = false;

  constructor() {
    try {
      this._muted = localStorage.getItem("sf_sound") === "0";
    } catch {
      /* keep default */
    }
    const unlock = (): void => {
      this.ensureCtx();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  get muted(): boolean {
    return this._muted;
  }

  setMuted(m: boolean): void {
    this._muted = m;
    try {
      localStorage.setItem("sf_sound", m ? "0" : "1");
    } catch {
      /* ignore */
    }
  }

  private ensureCtx(): AudioContext | null {
    if (!this.ctx) {
      try {
        this.ctx = new AudioContext();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.45;
        this.master.connect(this.ctx.destination);
      } catch {
        return null; // no audio support — stay silent
      }
    }
    if (this.ctx.state === "suspended") void this.ctx.resume();
    return this.ctx;
  }

  /** One enveloped oscillator note. Times are in seconds relative to now. */
  private tone(
    freq: number,
    o: { at?: number; dur?: number; vol?: number; type?: OscillatorType; glideTo?: number } = {},
  ): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const dur = o.dur ?? 0.18;
    const osc = ctx.createOscillator();
    osc.type = o.type ?? "sine";
    osc.frequency.setValueAtTime(freq, t0);
    if (o.glideTo) osc.frequency.exponentialRampToValueAtTime(o.glideTo, t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.vol ?? 0.25, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
  }

  /** One enveloped band-passed noise burst (clicks, clatters, whooshes). */
  private noise(o: {
    at?: number;
    dur?: number;
    vol?: number;
    freq?: number;
    q?: number;
    sweepTo?: number;
  }): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + (o.at ?? 0);
    const dur = o.dur ?? 0.06;
    const len = Math.max(1, Math.ceil(ctx.sampleRate * (dur + 0.05)));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const f = ctx.createBiquadFilter();
    f.type = "bandpass";
    f.frequency.setValueAtTime(o.freq ?? 1800, t0);
    if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + dur);
    f.Q.value = o.q ?? 1.2;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(o.vol ?? 0.2, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(this.master!);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  play(name: SfxName): void {
    if (this._muted) return;
    const ctx = this.ensureCtx();
    if (!ctx || !this.master) return;
    switch (name) {
      case "dice": {
        // A handful of bony clicks scattered over ~0.3s, then a settle thump.
        for (let i = 0; i < 5; i++) {
          this.noise({ at: i * 0.055 + Math.random() * 0.02, dur: 0.035, freq: 2400 + Math.random() * 1200, vol: 0.16 });
        }
        this.noise({ at: 0.32, dur: 0.07, freq: 700, q: 0.8, vol: 0.2 });
        break;
      }
      case "shake": {
        // Rapid rattle — balls bouncing in the mothership cup.
        for (let i = 0; i < 9; i++) {
          this.noise({ at: i * 0.05 + Math.random() * 0.018, dur: 0.03, freq: 3000 + Math.random() * 1800, q: 2, vol: 0.12 });
        }
        this.noise({ at: 0.52, dur: 0.08, freq: 900, q: 0.9, vol: 0.18 });
        break;
      }
      case "build": {
        // Soft landing thunk with a faint metallic tick.
        this.tone(170, { dur: 0.16, vol: 0.3, type: "sine", glideTo: 110 });
        this.noise({ at: 0.005, dur: 0.03, freq: 2600, vol: 0.08 });
        break;
      }
      case "encounter": {
        // Two-note minor sting — something is out there.
        this.tone(220, { dur: 0.4, vol: 0.16, type: "sawtooth" });
        this.tone(261.6, { at: 0.16, dur: 0.55, vol: 0.16, type: "sawtooth" });
        this.tone(110, { at: 0.16, dur: 0.6, vol: 0.12, type: "triangle" });
        break;
      }
      case "steal": {
        // Quick rising whoosh.
        this.noise({ dur: 0.28, freq: 400, sweepTo: 2600, q: 1.6, vol: 0.22 });
        break;
      }
      case "trade": {
        // Two coin blips.
        this.tone(880, { dur: 0.07, vol: 0.16, type: "triangle" });
        this.tone(1318.5, { at: 0.08, dur: 0.09, vol: 0.16, type: "triangle" });
        break;
      }
      case "turn": {
        // Gentle ascending chime — it's you.
        this.tone(523.25, { dur: 0.16, vol: 0.18, type: "triangle" });
        this.tone(784, { at: 0.12, dur: 0.28, vol: 0.18, type: "triangle" });
        break;
      }
      case "medal": {
        // Sparkle arpeggio for a VP gain.
        this.tone(1046.5, { dur: 0.09, vol: 0.14, type: "triangle" });
        this.tone(1318.5, { at: 0.07, dur: 0.09, vol: 0.14, type: "triangle" });
        this.tone(1568, { at: 0.14, dur: 0.18, vol: 0.16, type: "triangle" });
        break;
      }
      case "win": {
        // Little fanfare: rising arpeggio into a held chord.
        const seq = [261.6, 329.6, 392, 523.25];
        seq.forEach((f, i) => this.tone(f, { at: i * 0.12, dur: 0.16, vol: 0.16, type: "square" }));
        this.tone(523.25, { at: 0.5, dur: 0.7, vol: 0.14, type: "sawtooth" });
        this.tone(659.3, { at: 0.5, dur: 0.7, vol: 0.12, type: "sawtooth" });
        this.tone(784, { at: 0.5, dur: 0.7, vol: 0.12, type: "sawtooth" });
        break;
      }
    }
  }
}

export const sfx = new Sfx();
