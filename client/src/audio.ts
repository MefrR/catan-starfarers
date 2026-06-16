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
  | "build" // generic piece thunk (fallback)
  | "buildBooster" // rocket thrust igniting
  | "buildCannon" // metallic clank + boom
  | "buildPod" // hydraulic container clunk
  | "buildShip" // ascending launch swoosh
  | "buildColony" // warm settling chord
  | "buildPort" // grand chime fanfare
  | "buildStation" // docking coins
  | "encounter" // dramatic two-note sting
  | "steal" // whoosh
  | "trade" // coin blip pair
  | "turn" // gentle "your turn" chime
  | "medal" // sparkle arpeggio (conquest medal / friendship marker)
  | "tick" // countdown click (final seconds of the turn timer)
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

  /** Shared AudioContext for the ambient music engine (null = no audio). */
  context(): AudioContext | null {
    return this.ensureCtx();
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
      case "buildBooster": {
        // Rocket thrust igniting: a rising rumble + exhaust hiss sweeping up.
        this.tone(65, { dur: 0.5, vol: 0.26, type: "sawtooth", glideTo: 150 });
        this.noise({ dur: 0.5, freq: 220, sweepTo: 1100, q: 0.9, vol: 0.22 });
        this.noise({ at: 0.32, dur: 0.2, freq: 1600, sweepTo: 2600, q: 1.2, vol: 0.1 });
        break;
      }
      case "buildCannon": {
        // Heavy metal: two staggered clanks racked into place, then a boom.
        this.noise({ dur: 0.06, freq: 3400, q: 9, vol: 0.24 });
        this.noise({ at: 0.11, dur: 0.06, freq: 2700, q: 9, vol: 0.2 });
        this.tone(82, { at: 0.2, dur: 0.3, vol: 0.3, type: "sine", glideTo: 55 });
        break;
      }
      case "buildPod": {
        // Hydraulic container clunk: pressure hiss, then the crate sets down.
        this.noise({ dur: 0.16, freq: 900, sweepTo: 350, q: 1.4, vol: 0.16 });
        this.tone(190, { at: 0.14, dur: 0.12, vol: 0.26, type: "square", glideTo: 95 });
        this.noise({ at: 0.24, dur: 0.05, freq: 500, q: 1, vol: 0.18 });
        break;
      }
      case "buildShip": {
        // Launch swoosh: a tone and the wind both sweep upward.
        this.tone(160, { dur: 0.5, vol: 0.16, type: "triangle", glideTo: 660 });
        this.noise({ dur: 0.45, freq: 500, sweepTo: 2400, q: 1.4, vol: 0.18 });
        break;
      }
      case "buildColony": {
        // A warm settling major chord — home, founded.
        this.tone(261.6, { dur: 0.5, vol: 0.14, type: "triangle" });
        this.tone(329.6, { at: 0.07, dur: 0.5, vol: 0.13, type: "triangle" });
        this.tone(392, { at: 0.14, dur: 0.6, vol: 0.13, type: "triangle" });
        break;
      }
      case "buildPort": {
        // Grander: the colony chord crowned with a high bell.
        this.tone(261.6, { dur: 0.55, vol: 0.13, type: "triangle" });
        this.tone(392, { at: 0.06, dur: 0.55, vol: 0.12, type: "triangle" });
        this.tone(523.25, { at: 0.12, dur: 0.6, vol: 0.13, type: "triangle" });
        this.tone(1046.5, { at: 0.24, dur: 0.5, vol: 0.1, type: "sine" });
        break;
      }
      case "buildStation": {
        // Docking clamps + a three-coin trade arpeggio.
        this.noise({ dur: 0.05, freq: 1800, q: 4, vol: 0.14 });
        this.tone(659.3, { at: 0.08, dur: 0.08, vol: 0.13, type: "triangle" });
        this.tone(880, { at: 0.16, dur: 0.08, vol: 0.13, type: "triangle" });
        this.tone(1174.7, { at: 0.24, dur: 0.14, vol: 0.14, type: "triangle" });
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
      case "tick": {
        // Dry clock click — a short high blip so the final seconds feel urgent.
        this.tone(1760, { dur: 0.04, vol: 0.16, type: "square" });
        this.noise({ at: 0, dur: 0.025, freq: 2600, q: 3, vol: 0.1 });
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

/**
 * Generative ambient music: a slow, quiet space pad cycling through four
 * chords (Am9 → Fmaj7 → Cmaj → Gadd6 voicings) — detuned triangle pairs per
 * note through a gentle lowpass, with long attacks/releases so chords melt
 * into each other. Synthesized live, zero assets, deliberately faint.
 * Separate toggle from the SFX (persisted as sf_music).
 */
class Music {
  private master: GainNode | null = null;
  private timer = 0;
  private chordIdx = 0;
  private _enabled = true;
  private running = false;

  // Chord voicings (Hz): airy, mid-low, nothing busy.
  private static CHORDS: number[][] = [
    [110, 164.8, 261.6, 493.9], // A2 E3 C4 B4  (Am9)
    [87.3, 174.6, 220, 329.6], // F2 F3 A3 E4  (Fmaj7)
    [130.8, 196, 329.6, 392], // C3 G3 E4 G4  (C)
    [98, 196, 246.9, 587.3], // G2 G3 B3 D5  (Gadd6)
  ];

  constructor() {
    try {
      this._enabled = localStorage.getItem("sf_music") !== "0";
    } catch {
      /* keep default */
    }
    // Start on the first user gesture (the same autoplay rule as the SFX).
    const unlock = (): void => {
      if (this._enabled) this.start();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  get enabled(): boolean {
    return this._enabled;
  }

  setEnabled(on: boolean): void {
    this._enabled = on;
    try {
      localStorage.setItem("sf_music", on ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (on) this.start();
    else this.stop();
  }

  private start(): void {
    if (this.running) return;
    const ctx = sfx.context();
    if (!ctx) return;
    this.running = true;
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.gain.value = 0;
      this.master.connect(ctx.destination);
    }
    this.master.gain.cancelScheduledValues(ctx.currentTime);
    this.master.gain.linearRampToValueAtTime(0.05, ctx.currentTime + 3);
    const playChord = (): void => {
      const c = sfx.context();
      if (!c || !this.master) return;
      const chord = Music.CHORDS[this.chordIdx % Music.CHORDS.length]!;
      this.chordIdx++;
      const t0 = c.currentTime;
      for (const f of chord) {
        // A detuned pair per note for width; lowpass keeps it soft.
        for (const det of [-2.5, 2.5]) {
          const osc = c.createOscillator();
          osc.type = "triangle";
          osc.frequency.value = f;
          osc.detune.value = det;
          const lp = c.createBiquadFilter();
          lp.type = "lowpass";
          lp.frequency.value = 720;
          const g = c.createGain();
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime(0.16, t0 + 3.2);
          g.gain.setValueAtTime(0.16, t0 + 5.4);
          g.gain.linearRampToValueAtTime(0.0001, t0 + 9.6);
          osc.connect(lp).connect(g).connect(this.master);
          osc.start(t0);
          osc.stop(t0 + 10);
        }
      }
    };
    playChord();
    this.timer = window.setInterval(playChord, 8000);
  }

  private stop(): void {
    this.running = false;
    window.clearInterval(this.timer);
    this.timer = 0;
    const ctx = sfx.context();
    if (ctx && this.master) {
      this.master.gain.cancelScheduledValues(ctx.currentTime);
      this.master.gain.linearRampToValueAtTime(0, ctx.currentTime + 1.2);
    }
  }
}

export const music = new Music();
