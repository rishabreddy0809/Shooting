import * as THREE from "three";
import { model } from "./assets";
import { canvasTexture, softDisc } from "./util";

export enum WeaponKind { pistol, smg, assaultRifle, shotgun, marksman, sniper }
export enum Rarity { common, uncommon, rare, epic, legendary }

/** dot: red dot; holo: ring and dot; iron/bead: the model's own sights, nothing drawn. */
export type Reticle = "dot" | "holo" | "iron" | "bead" | "chevron" | "milDot";
export type WeaponAction = "none" | "bolt" | "pump";

export const RARITY_NAME = ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"];
export const RARITY_RGB: [number, number, number][] = [
  [0.72, 0.72, 0.7], [0.36, 0.78, 0.3], [0.25, 0.58, 0.98], [0.7, 0.36, 0.95], [1.0, 0.68, 0.18],
];
export const rarityCSS = (r: number, a = 1) => {
  const [R, G, B] = RARITY_RGB[r];
  return `rgba(${Math.round(R * 255)},${Math.round(G * 255)},${Math.round(B * 255)},${a})`;
};
const DAMAGE_SCALE = [1, 1.06, 1.12, 1.19, 1.26];
const RELOAD_SCALE = [1, 0.96, 0.92, 0.88, 0.84];

function weighted(weights: number[]): number {
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < weights.length; i++) {
    if (roll < weights[i]) return i;
    roll -= weights[i];
  }
  return 0;
}

export interface WeaponSpec {
  name: string;
  short: string;
  /** Model name; the marksman and sniper share the rifle and differ by optic. */
  model: string;
  optic: string | null;
  reticle: Reticle;
  zoomMin: number;
  zoomMax: number;
  /** Height of the sight line above the bore (the model origin), in metres. */
  sightHeight: number;
  /** How far ahead of the eye the model origin sits when aiming. */
  aimDepth: number;
  hip: [number, number, number];
  /** True when aiming replaces the weapon view with a full scope picture. */
  overlay: boolean;
  automatic: boolean;
  rpm: number;
  damage: number;
  pellets: number;
  /** Half-angle of the pellet cone (shotgun), in radians. */
  pelletSpread: number;
  hipSpread: number;
  magSize: number;
  kick: number;
  /** Full reload time, or the time per shell for shell-fed weapons. */
  reloadTime: number;
  shellFed: boolean;
  action: WeaponAction;
  velocity: number;
  /** Muzzle position ahead of the model origin. */
  muzzle: number;
  sound: string;
  /** Hostiles within this radius hear the shot. */
  loudness: number;
  fireMode: string;
  /** Fixed zero in metres; null when the player dials it. */
  fixedZero: number | null;
}

export const SPECS: WeaponSpec[] = [
  {
    name: "PISTOL", short: "PISTOL", model: "pistol", optic: null, reticle: "iron", zoomMin: 1.2, zoomMax: 1.2,
    sightHeight: 0.026, aimDepth: 0.48, hip: [0.1, -0.14, -0.42], overlay: false, automatic: false,
    rpm: 420, damage: 30, pellets: 1, pelletSpread: 0, hipSpread: 0.018, magSize: 15, kick: 0.75,
    reloadTime: 1.6, shellFed: false, action: "none", velocity: 370, muzzle: 0.155,
    sound: "shot_pistol", loudness: 40, fireMode: "SEMI", fixedZero: 25,
  },
  {
    name: "SUPPRESSED SMG", short: "SMG", model: "smg", optic: null, reticle: "dot", zoomMin: 1.3, zoomMax: 1.3,
    sightHeight: 0.051, aimDepth: 0.2, hip: [0.12, -0.16, -0.38], overlay: false, automatic: true,
    rpm: 850, damage: 21, pellets: 1, pelletSpread: 0, hipSpread: 0.022, magSize: 30, kick: 0.32,
    reloadTime: 2.0, shellFed: false, action: "none", velocity: 400, muzzle: 0.4,
    sound: "shot_smg", loudness: 16, fireMode: "AUTO", fixedZero: 50,
  },
  {
    name: "ASSAULT RIFLE", short: "AR", model: "ar", optic: null, reticle: "holo", zoomMin: 1.5, zoomMax: 1.5,
    sightHeight: 0.0675, aimDepth: 0.17, hip: [0.12, -0.17, -0.42], overlay: false, automatic: true,
    rpm: 680, damage: 34, pellets: 1, pelletSpread: 0, hipSpread: 0.018, magSize: 30, kick: 0.5,
    reloadTime: 2.2, shellFed: false, action: "none", velocity: 900, muzzle: 0.6,
    sound: "shot_ar", loudness: 50, fireMode: "AUTO", fixedZero: 100,
  },
  {
    name: "PUMP SHOTGUN", short: "SHOTGUN", model: "shotgun", optic: null, reticle: "bead", zoomMin: 1.15, zoomMax: 1.15,
    sightHeight: 0.028, aimDepth: 0.28, hip: [0.12, -0.16, -0.38], overlay: false, automatic: false,
    rpm: 70, damage: 13, pellets: 9, pelletSpread: 0.042, hipSpread: 0.01, magSize: 6, kick: 2.2,
    reloadTime: 0.48, shellFed: true, action: "pump", velocity: 400, muzzle: 0.72,
    sound: "shot_shotgun", loudness: 55, fireMode: "PUMP", fixedZero: 25,
  },
  {
    name: "MARKSMAN 4×", short: "DMR", model: "rifle", optic: "optic_acog", reticle: "chevron", zoomMin: 4, zoomMax: 4,
    sightHeight: 0.092, aimDepth: 0.12, hip: [0.1, -0.15, -0.33], overlay: true, automatic: false,
    rpm: 320, damage: 52, pellets: 1, pelletSpread: 0, hipSpread: 0.016, magSize: 20, kick: 0.8,
    reloadTime: 2.3, shellFed: false, action: "none", velocity: 820, muzzle: 0.97,
    sound: "shot", loudness: 45, fireMode: "SEMI", fixedZero: null,
  },
  {
    name: "SNIPER 6–24×", short: "SNIPER", model: "rifle", optic: "optic_sniper", reticle: "milDot", zoomMin: 6, zoomMax: 24,
    sightHeight: 0.096, aimDepth: 0.12, hip: [0.1, -0.15, -0.33], overlay: true, automatic: false,
    rpm: 46, damage: 130, pellets: 1, pelletSpread: 0, hipSpread: 0.016, magSize: 8, kick: 1.7,
    reloadTime: 3.0, shellFed: false, action: "bolt", velocity: 820, muzzle: 0.97,
    sound: "shot_heavy", loudness: 45, fireMode: "BOLT", fixedZero: null,
  },
];

export const MODEL_NAMES = ["pistol", "smg", "ar", "shotgun", "rifle"];
export const RIFLE_OPTICS = ["optic_reddot", "optic_acog", "optic_sniper"];

/** One gun in the inventory or on the ground. */
export class Weapon {
  ammo: number;
  constructor(readonly kind: WeaponKind, readonly rarity: Rarity, ammo?: number) {
    this.ammo = ammo ?? SPECS[kind].magSize;
  }
  get spec(): WeaponSpec { return SPECS[this.kind]; }
  get damageScale() { return DAMAGE_SCALE[this.rarity]; }
  get reloadScale() { return RELOAD_SCALE[this.rarity]; }
  static randomLoot(): Weapon {
    return new Weapon(weighted([18, 22, 28, 18, 9, 5]) as WeaponKind, weighted([42, 30, 17, 8, 3]) as Rarity);
  }
}

/** Shows only the chosen optic on the shared rifle model and hides the arms and lens helpers. */
export function prepareGunModel(root: THREE.Object3D, spec: WeaponSpec) {
  root.traverse((o) => {
    if (o.name === "fp_arms" || o.name === "reddot_lens") o.visible = false;
    if (RIFLE_OPTICS.includes(o.name)) o.visible = o.name === spec.optic;
  });
}

// MARK: Pickups

let beamTexture: THREE.Texture | null = null;
const glowMaterials = new Map<number, THREE.MeshBasicMaterial>();
const discGeometry = new THREE.PlaneGeometry(1.1, 1.1);
const beamGeometry = new THREE.PlaneGeometry(0.22, 2.4);

/** Vertical light shaft: bright at the ground, fading upward and toward the edges. */
function beamImage(): THREE.Texture {
  if (beamTexture) return beamTexture;
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 128;
  const g = c.getContext("2d")!;
  for (let x = 0; x < 32; x++) {
    const edge = 1 - Math.abs(x - 15.5) / 16;
    const v = Math.round(edge * edge * 255);
    const grad = g.createLinearGradient(0, 128, 0, 0);
    grad.addColorStop(0, `rgb(${v},${v},${v})`);
    grad.addColorStop(1, "rgb(0,0,0)");
    g.fillStyle = grad;
    g.fillRect(x, 0, 1, 128);
  }
  beamTexture = canvasTexture(c);
  return beamTexture;
}

/** A gun lying in the world, marked with a rarity-coloured glow and a light beam. */
export class Pickup {
  readonly node = new THREE.Group();
  readonly position: THREE.Vector3;
  private glow: THREE.Mesh;
  private beam: THREE.Mesh;
  private age = Math.random() * 3;
  fadeOut = -1;

  constructor(readonly weapon: Weapon, ground: THREE.Vector3, yaw = Math.random() * Math.PI * 2) {
    this.position = ground.clone();
    const spec = weapon.spec;
    const gun = model(spec.model);
    prepareGunModel(gun, spec);
    gun.traverse((o) => { o.castShadow = true; });
    // Lying on its side, a little above the grass so it doesn't sink into the slope.
    gun.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2));
    gun.position.set(0, 0.035, 0);
    this.node.add(gun);

    let glowMat = glowMaterials.get(weapon.rarity);
    if (!glowMat) {
      const [r, g, b] = RARITY_RGB[weapon.rarity];
      glowMat = new THREE.MeshBasicMaterial({
        map: canvasTexture(softDisc(`rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`)),
        blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, fog: false,
      });
      glowMaterials.set(weapon.rarity, glowMat);
    }
    this.glow = new THREE.Mesh(discGeometry, glowMat.clone());
    this.glow.rotation.x = -Math.PI / 2;
    this.glow.position.y = 0.02;
    this.node.add(this.glow);

    const [r, g, b] = RARITY_RGB[weapon.rarity];
    const beamMat = new THREE.MeshBasicMaterial({
      map: beamImage(),
      color: new THREE.Color().setRGB(r * 1.5, g * 1.5, b * 1.5, THREE.SRGBColorSpace),
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
      opacity: 0.55 + 0.1 * weapon.rarity,
    });
    this.beam = new THREE.Mesh(beamGeometry, beamMat);
    this.beam.position.y = 1.2;
    this.node.add(this.beam);
    this.node.position.copy(ground);
    this.node.name = "pickup";
  }

  /** Pulses the glow and turns the beam to face the camera about the vertical. Returns false once gone. */
  update(dt: number, eye: THREE.Vector3): boolean {
    this.age += dt;
    const pulse = 0.775 + 0.225 * Math.cos((this.age / 1.1) * Math.PI);
    let fade = 1;
    if (this.fadeOut >= 0) {
      this.fadeOut += dt;
      fade = Math.max(0, 1 - this.fadeOut / 0.6);
      if (fade <= 0) {
        this.node.removeFromParent();
        return false;
      }
    }
    (this.glow.material as THREE.MeshBasicMaterial).opacity = pulse * fade;
    (this.beam.material as THREE.MeshBasicMaterial).opacity = (0.55 + 0.1 * this.weapon.rarity) * fade;
    this.beam.rotation.y = Math.atan2(eye.x - this.position.x, eye.z - this.position.z);
    return true;
  }
}
