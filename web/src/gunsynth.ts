/**
 * Physically-motivated gunshot synthesis (port of the macOS GunSynth), rendered once at load.
 *
 * A real outdoor report is several overlapping events, each modelled here: the supersonic N-wave
 * and muzzle transient, the band-limited muzzle blast, the falling-pitch "boom", the mechanical
 * action, then slap-back echoes and a long low-passed rolling tail with decorrelated stereo.
 */
export const RATE = 44100;

interface Voice {
  length: number;
  nwave: number;
  nwaveDuration: number;
  transient: number;
  blastCutoff: number;
  blastDecay: number;
  boomStart: number;
  boomEnd: number;
  boomDecay: number;
  boom: number;
  drive: number;
  mechDelay: number;
  mech: number;
  mechPitch: number;
  tail: number;
  tailLength: number;
  tailCutoff: number;
  echoes: number;
}

const base: Voice = {
  length: 2, nwave: 0, nwaveDuration: 0.0005, transient: 0.6, blastCutoff: 2500, blastDecay: 0.025,
  boomStart: 130, boomEnd: 50, boomDecay: 0.05, boom: 1, drive: 3, mechDelay: 0.03, mech: 0, mechPitch: 1,
  tail: 0.4, tailLength: 1.8, tailCutoff: 1400, echoes: 0.35,
};

const voices: Record<string, Partial<Voice>> = {
  shot_pistol: {
    length: 1.5, transient: 0.9, blastCutoff: 2800, blastDecay: 0.016, boomStart: 170, boomEnd: 75, boomDecay: 0.03,
    boom: 0.75, drive: 3.2, mechDelay: 0.02, mech: 0.16, mechPitch: 1.15, tail: 0.3, tailLength: 1.2, tailCutoff: 1700, echoes: 0.3,
  },
  // Suppressed: the can strips the blast, leaving a cough, the bolt's clatter and a little tail.
  shot_smg: {
    length: 0.7, transient: 0.12, blastCutoff: 850, blastDecay: 0.02, boomStart: 140, boomEnd: 65, boomDecay: 0.022,
    boom: 0.8, drive: 1.8, mechDelay: 0.006, mech: 0.5, mechPitch: 0.9, tail: 0.08, tailLength: 0.45, tailCutoff: 900, echoes: 0.12,
  },
  shot_ar: {
    length: 2.0, nwave: 1.1, transient: 1, blastCutoff: 3400, blastDecay: 0.028, boomStart: 125, boomEnd: 48, boomDecay: 0.045,
    boom: 1.1, drive: 4, mechDelay: 0.028, mech: 0.13, mechPitch: 1, tail: 0.42, tailLength: 1.9, tailCutoff: 1500, echoes: 0.38,
  },
  shot_shotgun: {
    length: 2.4, transient: 0.55, blastCutoff: 1600, blastDecay: 0.055, boomStart: 95, boomEnd: 36, boomDecay: 0.1,
    boom: 1.7, drive: 5, tail: 0.5, tailLength: 2.2, tailCutoff: 1100, echoes: 0.42,
  },
  // Marksman rifle, full-power cartridge.
  shot: {
    length: 2.4, nwave: 1.3, transient: 1, blastCutoff: 2900, blastDecay: 0.036, boomStart: 105, boomEnd: 42, boomDecay: 0.065,
    boom: 1.4, drive: 4.5, mechDelay: 0.032, mech: 0.09, mechPitch: 0.85, tail: 0.5, tailLength: 2.3, tailCutoff: 1300, echoes: 0.42,
  },
  // Bolt-action magnum: the biggest crack and the longest roll across the valley.
  shot_heavy: {
    length: 3.0, nwave: 1.5, nwaveDuration: 0.0008, transient: 1, blastCutoff: 2500, blastDecay: 0.05, boomStart: 85, boomEnd: 34,
    boomDecay: 0.09, boom: 1.8, drive: 5, tail: 0.6, tailLength: 2.9, tailCutoff: 1100, echoes: 0.45,
  },
  // Someone else's rifle 40–120 m away: highs soaked up by the air, more of the valley in it.
  shot_mid: {
    length: 2.0, nwave: 0.5, transient: 0.3, blastCutoff: 1500, blastDecay: 0.03, boomStart: 110, boomEnd: 50, boomDecay: 0.05,
    boom: 0.9, drive: 2.5, tail: 0.7, tailLength: 1.9, tailCutoff: 1000, echoes: 0.5,
  },
  // Far away: a dull thump followed by the rolling echo, which carries further than the shot.
  shot_far: {
    length: 2.2, transient: 0, blastCutoff: 650, blastDecay: 0.035, boomStart: 90, boomEnd: 45, boomDecay: 0.06,
    boom: 0.8, drive: 1.6, tail: 1.0, tailLength: 2.1, tailCutoff: 650, echoes: 0.6,
  },
};

export const GUN_SOUNDS = Object.keys(voices);

/** xorshift32 noise in [-1, 1). */
class Noise {
  s: number;
  constructor(seed: number) {
    this.s = seed >>> 0 || 1;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s >>> 0;
    return (s | 0) / 2147483648;
  }
  range(a: number, b: number) {
    return a + (b - a) * (this.next() * 0.5 + 0.5);
  }
}

/** RBJ biquad. */
class Biquad {
  b0 = 1; b1 = 0; b2 = 0; a1 = 0; a2 = 0;
  x1 = 0; x2 = 0; y1 = 0; y2 = 0;
  static lowpass(f: number, q = 0.707) { return new Biquad(f, q, 0); }
  static highpass(f: number, q = 0.707) { return new Biquad(f, q, 1); }
  constructor(f: number, q: number, kind: number) {
    const w = (2 * Math.PI * Math.min(f, RATE * 0.45)) / RATE;
    const alpha = Math.sin(w) / (2 * q), c = Math.cos(w);
    const a0 = 1 + alpha;
    if (kind === 0) { this.b0 = (1 - c) / 2; this.b1 = 1 - c; this.b2 = (1 - c) / 2; }
    else if (kind === 1) { this.b0 = (1 + c) / 2; this.b1 = -(1 + c); this.b2 = (1 + c) / 2; }
    else { this.b0 = alpha; this.b1 = 0; this.b2 = -alpha; }
    this.b0 /= a0; this.b1 /= a0; this.b2 /= a0;
    this.a1 = (-2 * c) / a0; this.a2 = (1 - alpha) / a0;
  }
  run(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

export interface Take {
  name: string;
  left: Float32Array;
  right: Float32Array;
}

/** Every gun sound, `variants` takes each. */
export function renderAll(variants: number): Take[] {
  const out: Take[] = [];
  for (const name of GUN_SOUNDS) {
    let stable = 5381;
    for (const ch of name) stable = (Math.imul(stable, 33) + ch.charCodeAt(0)) >>> 0;
    for (let k = 0; k < variants; k++) {
      const v: Voice = { ...base, ...voices[name] };
      const [left, right] = render(v, (Math.imul(k + 1, 0x9e3779b9) + stable) >>> 0);
      out.push({ name, left, right });
    }
  }
  return out;
}

function render(v: Voice, seed: number): [Float32Array, Float32Array] {
  const rng = new Noise(seed | 1);
  // Each take differs a little, like real rounds do.
  v.blastCutoff *= rng.range(0.9, 1.1);
  v.blastDecay *= rng.range(0.9, 1.12);
  v.boomStart *= rng.range(0.94, 1.06);
  v.boomDecay *= rng.range(0.9, 1.1);
  v.mechDelay *= rng.range(0.92, 1.08);

  const n = Math.floor(v.length * RATE);
  // 1. Dry report (mono): transient, N-wave, blast, boom.
  const dry = new Float32Array(n);
  const hpT = Biquad.highpass(1800, 0.6);
  const lpB = Biquad.lowpass(v.blastCutoff, 0.9);
  const lpB2 = Biquad.lowpass(v.blastCutoff * 1.4, 0.6);
  const lpChest = Biquad.lowpass(180, 0.8);
  let phase = 0;
  const dryLength = Math.min(n, Math.floor(0.45 * RATE));
  for (let i = 0; i < dryLength; i++) {
    const t = i / RATE;
    const attack = 1 - Math.exp(-t / 0.00035);
    let x = 0;
    x += hpT.run(rng.next()) * v.transient * 2.2 * attack * Math.exp(-t / 0.0035);
    if (t < v.nwaveDuration) x += v.nwave * 3 * (1 - (2 * t) / v.nwaveDuration);
    const blastNoise = lpB2.run(lpB.run(rng.next()));
    x += blastNoise * 4.2 * attack * (Math.exp(-t / v.blastDecay) + 0.18 * Math.exp(-t / (v.blastDecay * 3.2)));
    const f = v.boomEnd + (v.boomStart - v.boomEnd) * Math.exp(-t / 0.025);
    phase += (2 * Math.PI * f) / RATE;
    const boomEnv = (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / v.boomDecay);
    x += (Math.sin(phase) * 0.9 + lpChest.run(rng.next()) * 5) * v.boom * boomEnv;
    dry[i] = x;
  }
  // Soft clip, as the recording chain of a real gunshot does.
  let peak = 1e-6;
  for (let i = 0; i < dryLength; i++) peak = Math.max(peak, Math.abs(dry[i]));
  const norm = Math.tanh(v.drive);
  for (let i = 0; i < dryLength; i++) dry[i] = Math.tanh((dry[i] / peak) * v.drive) / norm;

  // 2. Per channel: mechanics, echoes, rolling tail.
  const channel = (side: number, r: Noise): Float32Array => {
    const out = new Float32Array(dry);
    if (v.mech > 0) {
      const start = Math.floor(v.mechDelay * RATE);
      const partials: [number, number][] = [[2150, 0.018], [3420, 0.012], [5230, 0.008], [1280, 0.03]];
      const click = Biquad.highpass(3000);
      const end = Math.min(n, start + Math.floor(0.12 * RATE));
      for (let i = start; i < end; i++) {
        const t = (i - start) / RATE;
        let m = 0;
        for (const [f, d] of partials) m += Math.sin(2 * Math.PI * f * v.mechPitch * t + side) * Math.exp(-t / d);
        m += click.run(r.next()) * 2.5 * Math.exp(-t / 0.002);
        // Second event: the carrier slamming home.
        const t2 = t - 0.045;
        if (t2 > 0) for (const [f, d] of partials) m += 0.7 * Math.sin(2 * Math.PI * f * 0.93 * v.mechPitch * t2) * Math.exp(-t2 / d);
        out[i] += m * v.mech * 0.35;
      }
    }
    // Slap-back echoes off the ground and hills: delayed, duller copies.
    const taps: [number, number, number][] = [
      [0.011 + 0.004 * side, 0.32, 5000],
      [0.085 + 0.02 * r.next(), 0.55, 2200],
      [0.19 + 0.04 * r.next(), 0.42, 1500],
      [0.36 + 0.06 * r.next(), 0.32, 1000],
      [0.62 + 0.1 * r.next(), 0.22, 750],
      [0.95 + 0.15 * r.next(), 0.14, 600],
    ];
    for (const [delay, gain, cut] of taps) {
      const lp = Biquad.lowpass((cut * v.tailCutoff) / 1400, 0.6);
      const d = Math.floor(delay * RATE);
      const g = gain * v.echoes * r.range(0.8, 1.2);
      for (let i = 0; i < dryLength && i + d < n; i++) out[i + d] += lp.run(dry[i]) * g;
    }
    // Rolling tail: low rumble that swells briefly and then rolls off unevenly.
    const lp1 = Biquad.lowpass(v.tailCutoff, 0.7), lp2 = Biquad.lowpass(v.tailCutoff * 0.8, 0.7);
    const hp = Biquad.highpass(70);
    const rate1 = r.range(2.5, 5), rate2 = r.range(0.7, 1.6), ph1 = r.range(0, 6.28), ph2 = r.range(0, 6.28);
    const tau = v.tailLength / 4;
    for (let i = Math.floor(0.02 * RATE); i < n; i++) {
      const t = i / RATE - 0.02;
      const swell = 1 - Math.exp(-t / 0.06);
      const roll = 0.55 + 0.3 * Math.sin(2 * Math.PI * rate1 * t + ph1) + 0.15 * Math.sin(2 * Math.PI * rate2 * t + ph2);
      out[i] += hp.run(lp2.run(lp1.run(r.next()))) * v.tail * 3.2 * swell * Math.exp(-t / tau) * roll;
    }
    // Clean up: no DC, gentle fade to silence.
    const dc = Biquad.highpass(28);
    const fade = Math.floor(0.25 * RATE);
    for (let i = 0; i < n; i++) {
      out[i] = dc.run(out[i]);
      if (i > n - fade) out[i] *= (n - i) / fade;
    }
    return out;
  };
  const left = channel(-0.4, new Noise(rng.s ^ 0xa5a5));
  const right = channel(0.4, new Noise(rng.s ^ 0x5a5a1234));
  let p = 1e-6;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(left[i]), Math.abs(right[i]));
  const g = 0.97 / p;
  for (let i = 0; i < n; i++) { left[i] *= g; right[i] *= g; }
  return [left, right];
}
