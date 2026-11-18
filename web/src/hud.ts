import { World } from "./world";
import { RARITY_NAME, rarityCSS, type Reticle } from "./weapons";

export type Mode = "ready" | "playing" | "paused" | "down";

export interface Blip { x: number; z: number; kind: "hostile" | "pickup"; rarity: number }
export interface FeedItem { text: string; detail: string; age: number }
export interface Holdover { range: number; mils: number }
export interface SlotInfo { short: string; rarity: number; ammo: number }

export interface HUDSnapshot {
  mode: Mode;
  ammo: number;
  magSize: number;
  reloading: boolean;
  health: number;
  kills: number;
  headshots: number;
  longest: number;
  opticName: string;
  fireMode: string;
  reticle: Reticle;
  ads: number;
  scoped: boolean;
  zoom: number;
  pxPerMil: number;
  range: number | null;
  breath: number;
  holding: boolean;
  shadowX: number;
  shadowY: number;
  spread: number;
  hitAge: number;
  hitKill: boolean;
  damageFlash: number;
  damageAngle: number;
  feed: FeedItem[];
  holdovers: Holdover[];
  zeroRange: number;
  windSpeed: number;
  crossWind: number;
  windHold: number;
  crouched: boolean;
  hostiles: number;
  rarity: number;
  slots: (SlotInfo | null)[];
  currentSlot: number;
  pickupPrompt: string | null;
  pickupRarity: number;
  mapX: number;
  mapZ: number;
  mapYaw: number;
  blips: Blip[];
  perf: string | null;
}

const INK = "rgb(242,237,222)";
const ink = (a: number) => `rgba(242,237,222,${a})`;
const DIM = ink(0.55);
const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace';
const font = (size: number, weight = 500) => `${weight} ${size}px ${MONO}`;

export class HUD {
  private g: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  map: HTMLCanvasElement | null = null;
  /** Where the weapon slot bar was last drawn, for tapping it on touch screens. */
  slotBar = { x: 0, top: 0, bottom: 0, sw: 62, gap: 5, n: 0 };

  constructor(private canvas: HTMLCanvasElement) {
    this.g = canvas.getContext("2d")!;
  }

  /** The weapon slot under a screen point, if any. */
  slotAt(x: number, y: number): number | null {
    const b = this.slotBar;
    if (y < b.top - 8 || y > b.bottom + 8 || x < b.x) return null;
    const i = Math.floor((x - b.x) / (b.sw + b.gap));
    return i >= 0 && i < b.n ? i : null;
  }

  resize(w: number, h: number) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = w;
    this.h = h;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.g.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  draw(s: HUDSnapshot) {
    const g = this.g;
    g.clearRect(0, 0, this.w, this.h);
    const cx = this.w / 2, cy = this.h / 2;
    if (s.scoped) {
      this.scope(s);
    } else if (s.mode === "playing") {
      if ((s.reticle === "dot" || s.reticle === "holo") && s.ads > 0.9) {
        g.save();
        g.shadowColor = "rgba(255,26,13,0.9)";
        g.shadowBlur = 6;
        g.fillStyle = "rgb(255,41,26)";
        circle(g, cx, cy, 2);
        g.fill();
        if (s.reticle === "holo") {
          // Holographic: 65 MOA ring around a 1 MOA dot.
          g.strokeStyle = "rgb(255,51,31)";
          g.lineWidth = 1.4;
          circle(g, cx, cy, 29);
          g.stroke();
        }
        g.restore();
      } else if (s.ads < 0.35) {
        g.globalAlpha = 1 - s.ads * 2.5;
        this.crosshair(cx, cy, s.spread);
        g.globalAlpha = 1;
      }
    }
    if (s.hitAge < 0.35) {
      g.globalAlpha = 1 - s.hitAge / 0.35;
      g.strokeStyle = s.hitKill ? "rgb(242,77,51)" : INK;
      g.lineWidth = s.hitKill ? 2.2 : 1.5;
      g.beginPath();
      for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
        g.moveTo(cx + sx * 26 * 0.28, cy + sy * 26 * 0.28);
        g.lineTo(cx + sx * 13, cy + sy * 13);
      }
      g.stroke();
      g.globalAlpha = 1;
    }
    this.damage(s);
    if (s.mode === "playing" || s.mode === "paused") this.status(s);
    if (s.mode === "playing" && s.pickupPrompt) this.pickup(s);
    if (s.perf) {
      g.font = font(11, 600);
      g.fillStyle = INK;
      g.textAlign = "center";
      g.textBaseline = "top";
      g.fillText(s.perf, cx, 12);
    }
  }

  // MARK: Crosshair

  private crosshair(cx: number, cy: number, gap: number) {
    const g = this.g;
    const len = 7;
    g.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      g.moveTo(cx + dx * gap, cy + dy * gap);
      g.lineTo(cx + dx * (gap + len), cy + dy * (gap + len));
    }
    g.strokeStyle = "rgba(0,0,0,0.5)";
    g.lineWidth = 3;
    g.stroke();
    g.strokeStyle = ink(0.9);
    g.lineWidth = 1.2;
    g.stroke();
    g.fillStyle = ink(0.8);
    circle(g, cx, cy, 1);
    g.fill();
  }

  // MARK: Scope picture

  private scope(s: HUDSnapshot) {
    const g = this.g;
    const c = { x: this.w / 2, y: this.h / 2 };
    const R = Math.min(this.w, this.h) * 0.47;
    g.save();
    circle(g, c.x, c.y, R);
    g.clip();
    if (s.reticle === "milDot") this.milReticle(s, c, R);
    else if (s.reticle === "chevron") this.chevron(s, c, R);
    // Scope shadow: the dark edge of the eyebox, sliding as the rifle moves.
    const limit = R * 0.2;
    const ox = Math.max(-limit, Math.min(limit, s.shadowX)), oy = Math.max(-limit, Math.min(limit, s.shadowY));
    const shadow = g.createRadialGradient(c.x + ox, c.y + oy, 0, c.x + ox, c.y + oy, R * 1.03);
    shadow.addColorStop(0, "rgba(0,0,0,0)");
    shadow.addColorStop(0.74, "rgba(0,0,0,0)");
    shadow.addColorStop(0.88, "rgba(0,0,0,0.45)");
    shadow.addColorStop(0.985, "rgba(0,0,0,1)");
    shadow.addColorStop(1, "rgba(0,0,0,1)");
    g.fillStyle = shadow;
    g.fillRect(0, 0, this.w, this.h);
    // A faint cool cast toward the lens edge.
    const tint = g.createRadialGradient(c.x, c.y, 0, c.x, c.y, R);
    tint.addColorStop(0.55, "rgba(51,77,115,0)");
    tint.addColorStop(1, "rgba(51,77,115,0.10)");
    g.fillStyle = tint;
    g.fillRect(0, 0, this.w, this.h);
    g.restore();

    g.beginPath();
    g.rect(0, 0, this.w, this.h);
    g.arc(c.x, c.y, R, 0, Math.PI * 2, true);
    g.fillStyle = "#000";
    g.fill("evenodd");
    g.strokeStyle = "rgb(23,23,23)";
    g.lineWidth = 3;
    circle(g, c.x, c.y, R);
    g.stroke();

    // Readouts to the left of the tube.
    const x = Math.max(16, (this.w / 2 - R) / 2 - 50);
    let y = c.y - 150;
    const line = () => {
      g.fillStyle = ink(0.22);
      g.fillRect(x, y, 64, 1);
      y += 8;
    };
    const text = (t: string, size: number, color: string, weight = 600) => {
      g.font = font(size, weight);
      g.fillStyle = color;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText(t, x, y);
      y += size + 7;
    };
    const row = (name: string, value: string) => {
      g.font = font(9, 600);
      g.fillStyle = DIM;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText(name, x, y + 1);
      g.font = font(11, 500);
      g.fillStyle = INK;
      g.fillText(value, x + 52, y);
      y += 18;
    };
    text(s.opticName, 10, DIM);
    text(`${s.zoom.toFixed(1)}×`, 22, INK, 400);
    line();
    row("RANGE", s.range !== null ? `${s.range.toFixed(0)} m` : "— m");
    row("ZERO", `${s.zeroRange} m  ↑↓`);
    line();
    text("HOLD", 9, DIM);
    for (const h of s.holdovers) row(`${h.range} m`, `${h.mils.toFixed(1)} mil`);
    line();
    row("WIND", `${s.windSpeed.toFixed(1)} m/s`);
    // Hold into the wind: a crosswind toward the right needs the reticle moved left.
    row("CROSS", Math.abs(s.crossWind) < 0.3 ? "—" : (s.crossWind > 0 ? "← " : "→ ") + `${s.windHold.toFixed(1)} mil`);
    line();
    text(s.holding ? "HOLDING" : "BREATH", 9, s.holding ? INK : DIM);
    y -= 8;
    g.fillStyle = ink(0.14);
    g.fillRect(x, y, 64, 2);
    g.fillStyle = s.breath < 0.3 ? "rgb(230,89,64)" : INK;
    g.fillRect(x, y, 64 * s.breath, 2);
  }

  private milReticle(s: HUDSnapshot, c: { x: number; y: number }, R: number) {
    const g = this.g;
    const p = s.pxPerMil;
    const line = "rgba(0,0,0,0.92)";
    const gap = Math.max(3, p * 0.3);
    const postStart = Math.min(R * 0.62, Math.max(R * 0.34, p * 11));
    const fine = new Path2D(), heavy = new Path2D(), ticks = new Path2D();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      fine.moveTo(c.x + dx * gap, c.y + dy * gap);
      fine.lineTo(c.x + dx * R, c.y + dy * R);
      // Heavy posts on the sides and bottom; the top stays open.
      if (dy >= 0 || dx !== 0) {
        heavy.moveTo(c.x + dx * postStart, c.y + dy * postStart);
        heavy.lineTo(c.x + dx * R, c.y + dy * R);
      }
    }
    // Mil hashes: every mil when magnified enough, otherwise every five.
    const every = p >= 5.5 ? 1 : 5;
    g.font = font(9, 500);
    g.fillStyle = line;
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (let i = every; i <= 10; i += every) {
      const d = i * p;
      if (d > postStart - 2) break;
      const half = i % 5 === 0 ? Math.max(5, p * 0.5) : Math.max(2.5, p * 0.25);
      for (const sign of [-1, 1]) {
        ticks.moveTo(c.x + sign * d, c.y - half);
        ticks.lineTo(c.x + sign * d, c.y + half);
        ticks.moveTo(c.x - half, c.y + sign * d);
        ticks.lineTo(c.x + half, c.y + sign * d);
      }
      if (p >= 9 && i % 2 === 0) g.fillText(`${i}`, c.x + Math.max(9, p * 0.5) + 8, c.y + d);
    }
    if (p >= 22) {
      for (let i = 0; i < 10; i++) {
        const d = (i + 0.5) * p;
        if (d > postStart - 2) break;
        for (const sign of [-1, 1]) {
          ticks.moveTo(c.x + sign * d + 0.9, c.y);
          ticks.arc(c.x + sign * d, c.y, 0.9, 0, Math.PI * 2);
          ticks.moveTo(c.x + 0.9, c.y + sign * d);
          ticks.arc(c.x, c.y + sign * d, 0.9, 0, Math.PI * 2);
        }
      }
    }
    g.strokeStyle = line;
    g.lineWidth = 1;
    g.stroke(fine);
    g.stroke(ticks);
    g.lineWidth = 4.5;
    g.stroke(heavy);
    g.fillStyle = line;
    circle(g, c.x, c.y, 1.1);
    g.fill();
  }

  private chevron(s: HUDSnapshot, c: { x: number; y: number }, R: number) {
    const g = this.g;
    const p = Math.max(s.pxPerMil, 2);
    const w = Math.max(7, p * 2.4), h = Math.max(9, p * 3.2);
    const chev = new Path2D();
    chev.moveTo(c.x - w, c.y + h);
    chev.lineTo(c.x, c.y);
    chev.lineTo(c.x + w, c.y + h);
    g.lineJoin = "miter";
    g.lineCap = "round";
    g.strokeStyle = "rgba(235,51,20,0.35)";
    g.lineWidth = 6;
    g.stroke(chev);
    g.lineCap = "butt";
    g.strokeStyle = "rgb(235,51,20)";
    g.lineWidth = 2.2;
    g.stroke(chev);

    // Bullet-drop ladder: each rung is as wide as a pair of shoulders at that range.
    const ladder = new Path2D();
    const top = c.y + h + 4;
    let bottom = top;
    g.font = font(9, 600);
    g.fillStyle = "rgba(0,0,0,0.85)";
    g.textAlign = "center";
    g.textBaseline = "middle";
    for (const hold of s.holdovers) {
      if (hold.range < 300) continue;
      const y = c.y + Math.max(hold.mils * p, h + 8 + ((hold.range - 300) / 100) * 9);
      const half = Math.max(3.5, ((0.48 / hold.range) * 1000 * p) / 2);
      ladder.moveTo(c.x - half, y);
      ladder.lineTo(c.x + half, y);
      bottom = Math.max(bottom, y);
      g.fillText(`${hold.range / 100}`, c.x + half + 9, y);
    }
    ladder.moveTo(c.x, top);
    ladder.lineTo(c.x, Math.min(bottom + 26, c.y + R));
    g.strokeStyle = "rgba(0,0,0,0.9)";
    g.lineWidth = 1.3;
    g.stroke(ladder);
  }

  // MARK: Damage

  private damage(s: HUDSnapshot) {
    const g = this.g;
    const hurt = Math.max(s.damageFlash * 0.55, (1 - s.health / 100) * 0.4);
    const cx = this.w / 2, cy = this.h / 2;
    if (hurt > 0.01) {
      const grad = g.createRadialGradient(cx, cy, 180, cx, cy, 760);
      grad.addColorStop(0, "rgba(115,5,0,0)");
      grad.addColorStop(1, `rgba(115,5,0,${hurt})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, this.w, this.h);
    }
    if (s.damageFlash > 0.05) {
      g.save();
      g.translate(cx, cy);
      g.rotate(-s.damageAngle);
      g.fillStyle = `rgba(230,56,36,${s.damageFlash})`;
      roundRect(g, -32, -152, 64, 4, 2);
      g.fill();
      g.restore();
    }
  }

  // MARK: Status

  private pickup(s: HUDSnapshot) {
    const g = this.g;
    const name = s.pickupPrompt!;
    g.font = font(13, 600);
    const textW = Math.max(g.measureText(name).width, 80);
    const w = 12 + 22 + 10 + textW + 12, h = 40;
    const x = this.w / 2 - w / 2, y = this.h / 2 + 150 - h / 2;
    g.fillStyle = "rgba(0,0,0,0.55)";
    g.fillRect(x, y, w, h);
    g.fillStyle = rarityCSS(s.pickupRarity);
    g.fillRect(x, y + h - 2, w, 2);
    g.fillStyle = INK;
    roundRect(g, x + 12, y + 9, 22, 22, 3);
    g.fill();
    g.fillStyle = "#000";
    g.font = font(12, 700);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("E", x + 23, y + 20.5);
    g.textAlign = "left";
    g.textBaseline = "top";
    g.font = font(9, 600);
    g.fillStyle = rarityCSS(s.pickupRarity);
    g.fillText(RARITY_NAME[s.pickupRarity], x + 44, y + 6);
    g.font = font(13, 600);
    g.fillStyle = INK;
    g.fillText(name, x + 44, y + 19);
  }

  private status(s: HUDSnapshot) {
    const g = this.g;
    g.save();
    g.shadowColor = "rgba(0,0,0,0.6)";
    g.shadowBlur = 3;
    g.shadowOffsetY = 1;
    const left = 30, right = this.w - 30, top = 44, bottom = this.h - 24;

    // Top left: tallies.
    let x = left;
    const stats: [string, string][] = [
      ["HOSTILES", `${s.hostiles}`], ["DOWN", `${s.kills}`], ["HEADSHOTS", `${s.headshots}`],
      ["LONGEST", s.longest > 0 ? `${Math.floor(s.longest)} m` : "—"],
    ];
    g.textAlign = "left";
    g.textBaseline = "top";
    for (const [name, value] of stats) {
      g.font = font(9, 600);
      g.fillStyle = DIM;
      g.fillText(name, x, top);
      const w1 = g.measureText(name).width;
      g.font = font(14, 500);
      g.fillStyle = INK;
      g.fillText(value, x, top + 13);
      x += Math.max(w1, g.measureText(value).width) + 18;
    }

    // Top right: feed.
    let fy = top;
    g.textAlign = "right";
    for (const item of s.feed) {
      g.globalAlpha = Math.max(0, Math.min(1, (5 - item.age) / 1.2));
      g.font = font(11, 500);
      g.fillStyle = DIM;
      g.fillText(item.detail, right, fy);
      const dw = g.measureText(item.detail).width;
      g.font = font(11, 600);
      g.fillStyle = INK;
      g.fillText(item.text.toUpperCase(), right - dw - 10, fy);
      fy += 17;
    }
    g.globalAlpha = 1;
    g.restore();

    // Bottom left: minimap and vitals.
    const mapSize = 190;
    const vitalsY = bottom - 3;
    const labelY = vitalsY - 6 - 14;
    const mapY = labelY - 4 - 6 - mapSize;
    this.minimap(s, left, mapY, mapSize);
    g.save();
    g.shadowColor = "rgba(0,0,0,0.6)";
    g.shadowBlur = 3;
    g.shadowOffsetY = 1;
    g.textAlign = "left";
    g.textBaseline = "alphabetic";
    g.font = font(9, 600);
    g.fillStyle = DIM;
    g.fillText("VITALS", left, labelY + 11);
    let vx = left + g.measureText("VITALS").width + 8;
    g.font = font(12, 500);
    g.fillStyle = INK;
    const hp = `${Math.round(s.health)}`;
    g.fillText(hp, vx, labelY + 11);
    vx += g.measureText(hp).width + 8;
    if (s.crouched) {
      g.font = font(9, 600);
      g.fillStyle = DIM;
      g.fillText("CROUCHED", vx, labelY + 11);
    }
    g.fillStyle = ink(0.2);
    g.fillRect(left, vitalsY, 190, 3);
    g.fillStyle = s.health < 35 ? "rgb(230,77,51)" : "rgb(115,204,102)";
    g.fillRect(left, vitalsY, (190 * Math.max(0, s.health)) / 100, 3);

    // Bottom right: ammo and status line.
    g.textAlign = "right";
    g.font = font(9, 600);
    const statusLine = s.reloading ? "RELOADING" : s.ammo === 0 ? "EMPTY · R TO RELOAD" : `${s.opticName} · ${s.fireMode}`;
    g.fillStyle = s.reloading || s.ammo === 0 ? DIM : rarityCSS(s.rarity);
    g.fillText(statusLine, right, bottom);
    const ammoBase = bottom - 16;
    g.font = font(12, 500);
    g.fillStyle = DIM;
    const mag = `/ ${s.magSize}`;
    g.fillText(mag, right, ammoBase);
    const magW = g.measureText(mag).width;
    g.font = font(34, 300);
    g.fillStyle = INK;
    g.fillText(s.reloading ? "--" : String(s.ammo).padStart(2, "0"), right - magW - 6, ammoBase);
    g.restore();

    // Slot bar above the ammo.
    const slotBottom = ammoBase - 34 - 8;
    const n = s.slots.length;
    const sw = 62, gap = 5;
    let sx = right - n * sw - (n - 1) * gap;
    this.slotBar = { x: sx, top: slotBottom - 44, bottom: slotBottom, sw, gap, n };
    for (let i = 0; i < n; i++) {
      const slot = s.slots[i];
      const selected = i === s.currentSlot;
      const sh = selected ? 44 : 36;
      const sy = slotBottom - sh;
      const grad = g.createLinearGradient(0, sy, 0, sy + sh);
      grad.addColorStop(0, "rgba(0,0,0,0.45)");
      grad.addColorStop(1, slot ? rarityCSS(slot.rarity, 0.35) : "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(sx, sy, sw, sh);
      g.strokeStyle = selected ? INK : ink(0.15);
      g.lineWidth = selected ? 1.5 : 1;
      g.strokeRect(sx + 0.5, sy + 0.5, sw - 1, sh - 1);
      g.font = font(8, 600);
      g.fillStyle = DIM;
      g.textAlign = "left";
      g.textBaseline = "top";
      g.fillText(`${i + 1}`, sx + 3, sy + 3);
      if (slot) {
        g.textAlign = "center";
        g.textBaseline = "middle";
        g.font = font(9, 600);
        g.fillStyle = INK;
        g.fillText(slot.short, sx + sw / 2, sy + sh / 2 - 4);
        g.font = font(9, 500);
        g.fillStyle = DIM;
        g.fillText(`${slot.ammo}`, sx + sw / 2, sy + sh / 2 + 8);
      }
      sx += sw + gap;
    }
  }

  /** Rotating radar: the map turns so your heading is always up. */
  private minimap(s: HUDSnapshot, x0: number, y0: number, size: number) {
    const g = this.g;
    const range = 85;
    const r = size / 2;
    const c = { x: x0 + r, y: y0 + r };
    g.save();
    g.beginPath();
    g.arc(c.x, c.y, r, 0, Math.PI * 2);
    g.fillStyle = "rgb(20,23,18)";
    g.fill();
    g.clip();
    const ppm = r / range;
    g.save();
    g.translate(c.x, c.y);
    g.rotate(s.mapYaw);
    g.scale(ppm, ppm);
    g.translate(-s.mapX, -s.mapZ);
    if (this.map) {
      const h = World.mapHalfSize;
      g.globalAlpha = 0.85;
      g.drawImage(this.map, -h, -h, 2 * h, 2 * h);
      g.globalAlpha = 1;
    }
    // Grid every 50 m, so distance reads at a glance.
    g.beginPath();
    for (let i = -200; i <= 200; i += 50) {
      g.moveTo(i, -200); g.lineTo(i, 200);
      g.moveTo(-200, i); g.lineTo(200, i);
    }
    g.strokeStyle = "rgba(255,255,255,0.08)";
    g.lineWidth = 1 / ppm;
    g.stroke();
    for (const b of s.blips) {
      if (b.kind === "hostile") {
        const d = 3.2 / ppm;
        circle(g, b.x, b.z, d);
        g.fillStyle = "rgb(242,46,31)";
        g.fill();
        g.strokeStyle = "rgba(0,0,0,0.6)";
        g.stroke();
      } else {
        const d = 2.4 / ppm;
        g.fillStyle = rarityCSS(b.rarity);
        g.fillRect(b.x - d, b.z - d, 2 * d, 2 * d);
      }
    }
    g.restore();
    // North marker on the rim.
    g.font = font(10, 700);
    g.fillStyle = INK;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText("N", c.x + Math.sin(s.mapYaw) * (r - 11), c.y - Math.cos(s.mapYaw) * (r - 11));
    // You: an arrow pointing up.
    g.beginPath();
    g.moveTo(c.x, c.y - 8);
    g.lineTo(c.x + 5.5, c.y + 6);
    g.lineTo(c.x, c.y + 3);
    g.lineTo(c.x - 5.5, c.y + 6);
    g.closePath();
    g.fillStyle = "#fff";
    g.fill();
    g.strokeStyle = "rgba(0,0,0,0.6)";
    g.lineWidth = 1;
    g.stroke();
    g.restore();
    g.beginPath();
    g.arc(c.x, c.y, r, 0, Math.PI * 2);
    g.strokeStyle = "rgba(0,0,0,0.7)";
    g.lineWidth = 3;
    g.stroke();
    g.beginPath();
    g.arc(c.x, c.y, r - 1.5, 0, Math.PI * 2);
    g.strokeStyle = ink(0.35);
    g.lineWidth = 1;
    g.stroke();
  }
}

function circle(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

// MARK: Cards (HTML)

const CONTROLS: [string, string][] = [
  ["W A S D", "Move"], ["Shift", "Sprint · hold breath when aiming"],
  ["Space / C", "Jump / crouch"], ["Left click", "Fire"],
  ["Right click or Q", "Aim through the optic"], ["Scroll or + / −", "Scope magnification"],
  ["1 – 5 / Scroll", "Switch weapon slot"], ["E", "Pick up · swap the gun in hand"],
  ["R", "Reload"], ["↑ / ↓", "Scope zero 100–600 m"],
  ["G / P", "Graphics quality · performance stats"], ["Esc", "Release the cursor"],
];

const TOUCH_CONTROLS: [string, string][] = [
  ["Left side", "Drag to move · push all the way up to sprint"],
  ["Right side", "Drag to look"], ["FIRE", "Hold to shoot · drag it to aim while firing"],
  ["AIM", "Look through the optic (tap again to lower)"], ["HOLD BREATH", "Steady the scope while aiming"],
  ["＋ / −", "Scope magnification"], ["ZERO ▲ / ▼", "Scope zero 100–600 m"],
  ["SWAP / slots", "Next gun, or tap a slot"], ["PICK UP", "Take the gun at your feet"],
  ["GFX", "Graphics quality"], ["❚❚", "Pause"],
];

export function renderCard(el: HTMLElement, s: { mode: Mode; kills: number; headshots: number; longest: number }, touch = false) {
  const verb = touch ? "Tap" : "Click";
  let title = "", sub: string | null = null, prompt = "", controls = true;
  switch (s.mode) {
    case "ready":
      title = "RIDGELINE"; sub = "Long-range overwatch above a hostile outpost"; prompt = `${verb} to deploy`; break;
    case "paused":
      title = "PAUSED"; prompt = `${verb} to resume`; break;
    case "down":
      title = "YOU ARE DOWN";
      sub = `${s.kills} hostiles down · ${s.headshots} headshots · longest ${Math.floor(s.longest)} m`;
      prompt = `${verb} to redeploy`; controls = false; break;
    case "playing":
      el.classList.add("hidden");
      return;
  }
  const rows = controls
    ? `<hr>${(touch ? TOUCH_CONTROLS : CONTROLS).map(([k, a]) => `<div class="row"><div class="key">${k}</div><div class="act">${a}</div></div>`).join("")}`
    : "";
  el.innerHTML = `<div class="panel"><h1>${title}</h1>${sub ? `<div class="sub">${sub}</div>` : ""}${rows}<hr><div class="prompt">${prompt.toUpperCase()}</div></div>`;
  el.classList.remove("hidden");
}
