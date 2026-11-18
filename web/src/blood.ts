import * as THREE from "three";
import type { World } from "./world";
import { Particles } from "./particles";
import { canvasTexture, pick, rand, SeededRandom } from "./util";

/**
 * Blood effects: droplet spray at the wound, spatter decals on whatever lies behind the target,
 * wound marks that ride on the body, and a pool that spreads under the dead.
 */
export class BloodFX {
  private decals: THREE.Mesh[] = [];
  private readonly maxDecals = 70;
  private growing: { mesh: THREE.Mesh; t: number; duration: number }[] = [];
  private fading: { mesh: THREE.Mesh; t: number }[] = [];
  private splatters: THREE.Material[];
  private streaks: THREE.Material[];
  private pools: THREE.Material[];
  private wounds: THREE.Material[];
  private plane = new THREE.PlaneGeometry(1, 1);

  constructor(private world: World, private particles: Particles) {
    this.splatters = [0, 1, 2, 3].map((i) => BloodFX.material(splatterImage(i, false)));
    this.streaks = [0, 1, 2].map((i) => BloodFX.material(splatterImage(10 + i, true)));
    this.pools = [0, 1].map((i) => BloodFX.material(poolImage(20 + i), 0.08));
    this.wounds = [0, 1, 2].map((i) => BloodFX.material(woundImage(30 + i), 0.25));
  }

  /** A round strikes flesh at `point` travelling along `dir`. */
  hit(point: THREE.Vector3, dir: THREE.Vector3, normal: THREE.Vector3, part: THREE.Object3D | null, heavy: boolean, headshot: boolean) {
    const scale = (heavy ? 1.4 : 1) * (headshot ? 1.3 : 1);
    const back = dir.clone().negate();
    // Entry: a fine back-spray and mist toward the shooter.
    this.spray(point, back, 5 * scale, 1.0, 0.006, 45);
    this.mist(point, back, 0.04 * scale);
    // Exit: the bulk of the spray carries on with the round.
    const exit = point.clone().addScaledVector(dir, 0.12);
    this.spray(exit, dir, 16 * scale, 2.4 * scale, 0.007, 16);
    this.mist(point.clone().addScaledVector(dir, 0.15), dir, 0.07 * scale);

    if (part) this.wound(part, point, normal);

    // Spatter on whatever is behind: a wall, a rock, or the ground.
    const reach = 3.2 * scale;
    const h = this.world.raycast(point.clone().addScaledVector(dir, 0.1), point.clone().addScaledVector(dir, reach));
    if (h) {
      const size = (0.35 + h.distance * 0.18) * scale;
      this.decal(h.position, h.normal, size, pick(this.streaks), dir);
    }
    // Drips land on the ground just past the target.
    const drops = headshot ? 3 : 2;
    for (let i = 0; i < drops; i++) {
      const ahead = point.clone().addScaledVector(dir, rand(0.3, 1.6)).add(new THREE.Vector3(rand(-0.3, 0.3), 0, rand(-0.3, 0.3)));
      const g = this.world.raycast(new THREE.Vector3(ahead.x, point.y + 0.5, ahead.z), new THREE.Vector3(ahead.x, point.y - 3, ahead.z));
      if (g) this.decal(g.position, g.normal, rand(0.18, 0.42) * scale, pick(this.splatters), dir);
    }
  }

  /** Spreading pool under a body that has come to rest. */
  pool(point: THREE.Vector3) {
    const h = this.world.raycast(point.clone().add(new THREE.Vector3(0, 0.8, 0)), point.clone().add(new THREE.Vector3(0, -2, 0)));
    if (!h) return;
    const size = rand(1.1, 1.5);
    const mesh = this.decal(h.position, h.normal, size, pick(this.pools), null);
    mesh.userData.full = size;
    mesh.scale.setScalar(size * 0.12);
    this.growing.push({ mesh, t: 0, duration: rand(9, 14) });
  }

  update(dt: number) {
    for (const g of this.growing) {
      g.t = Math.min(g.duration, g.t + dt);
      const x = g.t / g.duration;
      const ease = 1 - (1 - x) * (1 - x);
      const full = g.mesh.userData.full as number;
      g.mesh.scale.setScalar(full * (0.12 + 0.88 * ease));
    }
    this.growing = this.growing.filter((g) => g.t < g.duration && g.mesh.parent);
    for (const f of this.fading) {
      f.t += dt;
      const m = f.mesh.material as THREE.MeshStandardMaterial;
      m.opacity = Math.max(0, 1 - f.t);
      if (f.t >= 1) f.mesh.removeFromParent();
    }
    this.fading = this.fading.filter((f) => f.t < 1);
  }

  private decal(p: THREE.Vector3, n: THREE.Vector3, size: number, material: THREE.Material, dir: THREE.Vector3 | null): THREE.Mesh {
    const mesh = new THREE.Mesh(this.plane, material);
    const normal = n.clone().normalize();
    // Face the plane's +Z along the surface normal, then spin it so streaks run with the spray.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    let spin = rand(0, Math.PI * 2);
    if (dir) {
      const tangent = dir.clone().addScaledVector(normal, -dir.dot(normal));
      if (tangent.length() > 1e-3) {
        tangent.normalize();
        const localUp = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
        spin = Math.atan2(new THREE.Vector3().crossVectors(localUp, tangent).dot(normal), localUp.dot(tangent));
      }
    }
    mesh.quaternion.copy(new THREE.Quaternion().setFromAxisAngle(normal, spin).multiply(q));
    mesh.position.copy(p).addScaledVector(normal, rand(0.012, 0.02));
    mesh.scale.setScalar(size);
    mesh.renderOrder = 5;
    mesh.receiveShadow = true;
    this.world.scene.add(mesh);
    this.decals.push(mesh);
    if (this.decals.length > this.maxDecals) {
      const old = this.decals.shift()!;
      // Each fading decal needs its own opacity.
      old.material = (old.material as THREE.Material).clone();
      this.fading.push({ mesh: old, t: 0 });
    }
    return mesh;
  }

  private wound(part: THREE.Object3D, p: THREE.Vector3, normal: THREE.Vector3) {
    const mesh = new THREE.Mesh(this.plane, pick(this.wounds));
    const n = normal.clone().normalize();
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    mesh.position.copy(p).addScaledVector(n, 0.006);
    mesh.scale.setScalar(0.07);
    mesh.renderOrder = 5;
    this.world.scene.add(mesh);
    // Parent to the body part so the wound follows the death animation.
    part.attach(mesh);
  }

  private spray(at: THREE.Vector3, direction: THREE.Vector3, count: number, speed: number, size: number, spread: number) {
    this.particles.emit({
      at, direction, count, speed, speedVariation: speed * 0.6, spread,
      size: size * 2.2, sizeVariation: size * 1.2, life: 0.5, lifeVariation: 0.3,
      color: new THREE.Color().setRGB(0.36, 0.015, 0.012, THREE.SRGBColorSpace), colorVariation: 0.15,
      alpha: 1, fade: [1, 1, 0.6], gravity: 9.8,
    });
  }

  private mist(at: THREE.Vector3, direction: THREE.Vector3, size: number) {
    this.particles.emit({
      at, direction, count: 10, speed: 0.9, speedVariation: 0.6, spread: 40,
      size, grow: 4, life: 0.45,
      color: new THREE.Color().setRGB(0.42, 0.03, 0.03, THREE.SRGBColorSpace),
      alpha: 0.55, fade: [0.8, 0.35, 0], damping: 4,
    });
  }

  private static material(canvas: HTMLCanvasElement, roughness = 0.2): THREE.Material {
    // Glossy but dark, so the blood doesn't mirror the bright sky and wash out to grey.
    return new THREE.MeshStandardMaterial({
      map: canvasTexture(canvas),
      transparent: true,
      depthWrite: false,
      roughness: 0.35 + roughness,
      metalness: 0,
      envMapIntensity: 0.25,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
  }
}

// MARK: Textures

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  // Draw with y up, like the macOS version.
  g.translate(0, size);
  g.scale(1, -1);
  return [c, g];
}

function blood(r: SeededRandom, alpha: number) {
  const k = r.range(0.75, 1.15);
  return `rgba(${Math.round(0.3 * k * 255)},${Math.round(0.012 * k * 255)},${Math.round(0.012 * k * 255)},${alpha})`;
}

function ellipse(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  g.beginPath();
  g.ellipse(x + w / 2, y + h / 2, Math.abs(w / 2), Math.abs(h / 2), 0, 0, Math.PI * 2);
  g.fill();
}

/** Spatter: a dense core, satellite droplets thrown outward, and (if streaked) elongated runs along +Y. */
function splatterImage(seed: number, streaked: boolean) {
  const r = new SeededRandom(seed * 9973 + 17);
  const [c, g] = canvas(256);
  const cx = 128, cy = streaked ? 92 : 128;
  for (let i = 0; i < (streaked ? 9 : 14); i++) {
    const a = r.range(0, 2 * Math.PI), d = r.range(0, streaked ? 20 : 26);
    const rad = r.range(10, streaked ? 22 : 30);
    g.fillStyle = blood(r, r.range(0.75, 0.95));
    ellipse(g, cx + Math.cos(a) * d - rad, cy + Math.sin(a) * d - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < (streaked ? 70 : 55); i++) {
    let a = r.range(0, 2 * Math.PI);
    if (streaked) a = Math.PI / 2 + r.range(-0.55, 0.55);
    const d = r.range(30, streaked ? 150 : 110);
    const size = Math.max(1.2, r.range(2, 9) * (1 - d / 190));
    const stretch = streaked ? r.range(1.6, 4.2) : r.range(1, 1.8);
    g.save();
    g.translate(cx + Math.cos(a) * d, cy + Math.sin(a) * d);
    g.rotate(a);
    g.fillStyle = blood(r, r.range(0.7, 0.95));
    ellipse(g, -size * stretch, -size, size * stretch * 2, size * 2);
    g.restore();
  }
  if (streaked) {
    for (let i = 0; i < 7; i++) {
      const x0 = cx + r.range(-22, 22);
      const len = r.range(40, 120);
      const w = r.range(2, 5);
      g.fillStyle = blood(r, 0.8);
      g.beginPath();
      g.moveTo(x0 - w, cy);
      g.lineTo(x0 + w, cy);
      g.lineTo(x0 + r.range(-6, 6), cy + len);
      g.closePath();
      g.fill();
    }
  }
  return c;
}

/** Pool: a smooth irregular lobe shape, darker and denser in the middle. */
function poolImage(seed: number) {
  const r = new SeededRandom(seed * 7919 + 3);
  const [c, g] = canvas(256);
  for (let layer = 0; layer < 2; layer++) {
    for (let i = 0; i < 12; i++) {
      const a = r.range(0, 2 * Math.PI), d = r.range(0, layer === 0 ? 55 : 30);
      const rad = r.range(layer === 0 ? 35 : 30, layer === 0 ? 62 : 48);
      g.fillStyle = layer === 0 ? "rgba(61,2,2,0.55)" : "rgba(36,2,2,0.6)";
      ellipse(g, 128 + Math.cos(a) * d - rad, 128 + Math.sin(a) * d - rad, rad * 2, rad * 2);
    }
  }
  return c;
}

/** Wound: a dark centre with a small ragged ring of smeared blood. */
function woundImage(seed: number) {
  const r = new SeededRandom(seed * 104729 + 11);
  const [c, g] = canvas(64);
  for (let i = 0; i < 10; i++) {
    const a = r.range(0, 2 * Math.PI), d = r.range(2, 14);
    const rad = r.range(4, 11);
    g.fillStyle = blood(r, 0.75);
    ellipse(g, 32 + Math.cos(a) * d - rad, 32 + Math.sin(a) * d - rad, rad * 2, rad * 2);
  }
  for (let i = 0; i < 5; i++) {
    const a = r.range(0, 2 * Math.PI);
    g.save();
    g.translate(32, 32);
    g.rotate(a);
    g.fillStyle = blood(r, 0.7);
    ellipse(g, 6, -1.5, r.range(10, 20), 3);
    g.restore();
  }
  g.fillStyle = "rgba(15,0,0,0.95)";
  ellipse(g, 28, 28, 8, 8);
  return c;
}
