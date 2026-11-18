import { RATE, renderAll } from "./gunsynth";
import { pick, rand } from "./util";

/**
 * Procedurally synthesized sound effects (WebAudio). Gunshots come from GunSynth (stereo, three takes
 * each); everything else is synthesized here. All voices run through a bus and a fast compressor
 * acting as a limiter, so stacked full-auto reports stay loud without clipping.
 */
export class GameAudio {
  readonly ctx: AudioContext;
  private bus: GainNode;
  private buffers = new Map<string, AudioBuffer>();
  private gunBuffers = new Map<string, AudioBuffer[]>();
  private active: AudioBufferSourceNode[] = [];

  constructor() {
    this.ctx = new AudioContext({ latencyHint: "interactive" });
    const limiter = this.ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 2;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.001;
    limiter.release.value = 0.12;
    this.bus = this.ctx.createGain();
    this.bus.gain.value = 0.9;
    this.bus.connect(limiter).connect(this.ctx.destination);
  }

  /** Browsers start audio suspended until a user gesture. */
  resume() {
    if (this.ctx.state !== "running") void this.ctx.resume();
  }

  /** Builds every sound. Gunshots are the slow part (well under a second). */
  build() {
    this.buildSounds();
    for (const take of renderAll(3)) {
      const b = this.ctx.createBuffer(2, take.left.length, RATE);
      b.copyToChannel(take.left as Float32Array<ArrayBuffer>, 0);
      b.copyToChannel(take.right as Float32Array<ArrayBuffer>, 1);
      const list = this.gunBuffers.get(take.name) ?? [];
      list.push(b);
      this.gunBuffers.set(take.name, list);
    }
  }

  play(name: string, volume = 1, delay = 0, pan = 0) {
    if (volume <= 0.004 || this.ctx.state !== "running") return;
    const takes = this.gunBuffers.get(name);
    const buffer = takes ? pick(takes) : this.buffers.get(name);
    if (!buffer) return;
    // Small level variation keeps repeated shots from sounding pasted.
    const level = Math.min(1, takes ? volume * rand(0.9, 1) : volume);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const gain = this.ctx.createGain();
    gain.gain.value = level;
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    src.connect(gain).connect(panner).connect(this.bus);
    src.start(this.ctx.currentTime + Math.max(0, delay));
    src.onended = () => {
      const i = this.active.indexOf(src);
      if (i >= 0) this.active.splice(i, 1);
      panner.disconnect();
    };
    this.active.push(src);
    // Gun tails run 1.5–3 s; cap the overlapping voices like the native build's player pools.
    if (this.active.length > 44) {
      const old = this.active.shift()!;
      try { old.stop(); } catch { /* already stopped */ }
    }
  }

  // MARK: Synthesis

  private make(name: string, seconds: number, sample: (t: number, i: number) => number) {
    const count = Math.floor(seconds * RATE);
    const out = new Float32Array(count);
    let peak = 0.0001;
    for (let i = 0; i < count; i++) {
      const v = sample(i / RATE, i);
      out[i] = v;
      peak = Math.max(peak, Math.abs(v));
    }
    const gain = 0.9 / peak;
    const fade = Math.min(count, 400);
    for (let i = 0; i < count; i++) {
      let v = out[i] * gain;
      if (i > count - fade) v *= (count - i) / fade;
      out[i] = v;
    }
    const b = this.ctx.createBuffer(1, count, RATE);
    b.copyToChannel(out, 0);
    this.buffers.set(name, b);
  }

  private buildSounds() {
    const noise = () => Math.random() * 2 - 1;
    const { sin, exp, PI, max } = Math;
    let lp = 0, lp2 = 0;
    this.make("impact", 0.22, (t) => {
      lp += (noise() - lp) * 0.2;
      return lp * exp(-t * 30) + sin(2 * PI * 140 * t) * exp(-t * 40) * 0.6;
    });
    lp = 0;
    this.make("hit_flesh", 0.18, (t) => {
      lp += (noise() - lp) * 0.07;
      return lp * exp(-t * 28) * 2 + sin(2 * PI * 90 * t) * exp(-t * 35);
    });
    let phase = 0;
    lp = 0;
    this.make("whiz", 0.28, (t) => {
      const f = 2600 - 6500 * t;
      phase += (2 * PI * max(f, 500)) / RATE;
      lp += (noise() - lp) * 0.4;
      const env = sin(PI * Math.min(t / 0.28, 1));
      return (sin(phase) * 0.35 + lp * 0.5) * env * env;
    });
    this.make("click", 0.06, (t) => (sin(2 * PI * 3100 * t) + noise() * 0.5) * exp(-t * 140));
    this.make("bolt", 0.5, (t) => {
      const tick = (at: number, f: number) => {
        const d = t - at;
        return d > 0 ? (sin(2 * PI * f * d) + noise() * 0.6) * exp(-d * 70) : 0;
      };
      const slide = t > 0.08 && t < 0.3 ? noise() * 0.12 : 0;
      return tick(0.02, 1800) + tick(0.16, 1300) * 0.8 + tick(0.33, 2100) + slide;
    });
    this.make("reload", 1.5, (t) => {
      const tick = (at: number, f: number, g: number) => {
        const d = t - at;
        return d > 0 ? (sin(2 * PI * f * d) + noise() * 0.7) * exp(-d * 55) * g : 0;
      };
      return tick(0.05, 900, 0.8) + tick(0.55, 700, 1) + tick(0.7, 1500, 0.6) + tick(1.2, 1900, 1) + tick(1.32, 1200, 0.7);
    });
    lp = 0;
    this.make("step", 0.14, (t) => {
      lp += (noise() - lp) * 0.12;
      return lp * exp(-t * 38);
    });
    lp = 0;
    this.make("hurt", 0.3, (t) => {
      lp += (noise() - lp) * 0.04;
      return lp * exp(-t * 14) * 2 + sin(2 * PI * 60 * t) * exp(-t * 16);
    });
    this.make("confirm", 0.09, (t) => sin(2 * PI * 1250 * t) * exp(-t * 60));
    // Pump: slide back, slide forward.
    this.make("pump", 0.4, (t) => {
      const clack = (at: number, f: number) => {
        const d = t - at;
        return d > 0 ? (sin(2 * PI * f * d) + noise() * 0.8) * exp(-d * 60) : 0;
      };
      const slide = (t > 0.02 && t < 0.14) || (t > 0.2 && t < 0.3) ? noise() * 0.15 : 0;
      return clack(0, 900) * 0.7 + clack(0.14, 1300) + clack(0.31, 1700) + slide;
    });
    this.make("shell", 0.18, (t) => {
      const d1 = t, d2 = t - 0.07;
      const a = (sin(2 * PI * 1100 * d1) + noise() * 0.6) * exp(-d1 * 80);
      const b = d2 > 0 ? (sin(2 * PI * 1600 * d2) + noise() * 0.4) * exp(-d2 * 90) : 0;
      return a * 0.6 + b;
    });
    this.make("pickup", 0.35, (t) => {
      const tick = (at: number, f: number) => {
        const d = t - at;
        return d > 0 ? (sin(2 * PI * f * d) + noise() * 0.5) * exp(-d * 75) : 0;
      };
      return tick(0, 700) * 0.6 + tick(0.12, 1500) + tick(0.2, 2200) * 0.7;
    });
    this.make("draw", 0.3, (t) => {
      const rustle = t < 0.18 ? noise() * 0.12 * sin((PI * t) / 0.18) : 0;
      const d = t - 0.2;
      return rustle + (d > 0 ? (sin(2 * PI * 1900 * d) + noise() * 0.5) * exp(-d * 90) : 0);
    });
    // A body hitting the ground: heavy, soft, with gear rattle.
    lp = 0; lp2 = 0;
    this.make("thud", 0.45, (t) => {
      const n = noise();
      lp += (n - lp) * 0.03;
      lp2 += (n - lp2) * 0.3;
      const gear = t > 0.04 ? lp2 * exp(-(t - 0.04) * 30) * 0.25 : 0;
      return lp * exp(-t * 12) * 3 + sin(2 * PI * 55 * t) * exp(-t * 18) * 1.4 + gear;
    });
  }
}
