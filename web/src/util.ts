import * as THREE from "three";

export type V3 = THREE.Vector3;
export const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const rand = (a: number, b: number) => a + (b - a) * Math.random();
export const randInt = (a: number, b: number) => Math.floor(a + (b - a + 1) * Math.random());
export const pick = <T>(arr: readonly T[]): T => arr[Math.floor(Math.random() * arr.length)];
export const smooth = (t: number) => t * t * (3 - 2 * t);

/** Quaternion for a rotation of `angle` radians about `axis`. */
export const quat = (angle: number, x: number, y: number, z: number) =>
  new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z), angle);

/** Seeded linear-congruential generator: placement and textures come out the same every run. */
export class SeededRandom {
  private s: bigint;
  constructor(seed: number | bigint) {
    this.s = BigInt.asUintN(64, BigInt(seed));
  }
  next(): number {
    this.s = BigInt.asUintN(64, this.s * 6364136223846793005n + 1442695040888963407n);
    return Number((this.s >> 40n) & 0xffffffn) / 0xffffff;
  }
  range(a: number, b: number) {
    return a + (b - a) * this.next();
  }
  /** A derived generator for one sub-task, so adding draws there doesn't shift everything after. */
  fork(salt: number): SeededRandom {
    const r = new SeededRandom(0);
    r.s = BigInt.asUintN(64, this.s ^ BigInt.asUintN(64, BigInt(salt) * 0x9e3779b97f4a7c15n));
    return r;
  }
}

/** Soft radial gradient disc, used for glows, flashes and particles. */
export function softDisc(color = "#ffffff", size = 64): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const col = new THREE.Color(color);
  const rgb = `${Math.round(col.r * 255)},${Math.round(col.g * 255)},${Math.round(col.b * 255)}`;
  grad.addColorStop(0, `rgba(${rgb},1)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.35)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);
  return c;
}

export function canvasTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Delayed callbacks driven by the game clock (pauses with the game). */
export class Timers {
  private list: { at: number; fn: () => void }[] = [];
  private now = 0;
  after(seconds: number, fn: () => void) {
    this.list.push({ at: this.now + seconds, fn });
  }
  update(dt: number) {
    this.now += dt;
    if (!this.list.length) return;
    const due = this.list.filter((t) => t.at <= this.now);
    if (!due.length) return;
    this.list = this.list.filter((t) => t.at > this.now);
    for (const t of due) t.fn();
  }
}
