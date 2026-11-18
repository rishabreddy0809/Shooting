import * as THREE from "three";
import { model } from "./assets";
import { pick, rand, randInt } from "./util";
import type { World } from "./world";

/** What an NPC needs from the game each frame. */
export interface NPCEnvironment {
  world: World;
  playerEye: THREE.Vector3;
  playerAlive: boolean;
  npcFired(npc: NPC, muzzle: THREE.Vector3): void;
  /** The body has hit the ground: thud, drop the gun, start the pool. */
  npcLanded(npc: NPC, impact: number): void;
}

export type HitZone = "head" | "body" | "limb";

export interface NPCHit {
  position: THREE.Vector3;
  zone: HitZone;
  normal: THREE.Vector3;
  part: THREE.Object3D;
}

type State = "idle" | "patrol" | "scatter" | "engage" | "dead";

const JOINTS = ["pelvis", "torso", "head", "upperarm_L", "forearm_L", "upperarm_R", "forearm_R", "thigh_L", "shin_L", "thigh_R", "shin_R", "npcgun"];

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const OUTFITS = [
  [srgb(0.27, 0.3, 0.19), srgb(0.24, 0.25, 0.17), srgb(0.15, 0.15, 0.11), srgb(0.2, 0.23, 0.15)],
  [srgb(0.5, 0.42, 0.3), srgb(0.44, 0.37, 0.27), srgb(0.3, 0.25, 0.17), srgb(0.42, 0.36, 0.26)],
  [srgb(0.16, 0.17, 0.19), srgb(0.13, 0.14, 0.16), srgb(0.08, 0.08, 0.09), srgb(0.1, 0.1, 0.11)],
  [srgb(0.36, 0.33, 0.25), srgb(0.21, 0.24, 0.17), srgb(0.22, 0.2, 0.14), srgb(0.25, 0.27, 0.18)],
  [srgb(0.3, 0.22, 0.17), srgb(0.18, 0.2, 0.24), srgb(0.17, 0.18, 0.13), srgb(0.33, 0.3, 0.22)],
];
const SKINS = [srgb(0.78, 0.6, 0.48), srgb(0.62, 0.44, 0.33), srgb(0.45, 0.31, 0.23), srgb(0.3, 0.21, 0.16)];

const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0), Z = new THREE.Vector3(0, 0, 1);
const D2R = Math.PI / 180;
const _q = new THREE.Quaternion(), _qy = new THREE.Quaternion(), _qx = new THREE.Quaternion();
const _raycaster = new THREE.Raycaster();

interface Limb { angle: THREE.Vector3; velocity: THREE.Vector3; rest: THREE.Vector3 }

/** A jointed soldier figure animated procedurally: patrols, scatters when shot at, then returns fire. */
export class NPC {
  readonly root = new THREE.Group();
  private pivot = new THREE.Group();
  private joints = new Map<string, THREE.Object3D>();
  private meshes: THREE.Mesh[] = [];
  private gunRest = new THREE.Vector3();

  state: State = "idle";
  health = 100;
  position: THREE.Vector3;
  private yaw = rand(0, Math.PI * 2);
  private home: THREE.Vector3;
  private target: THREE.Vector3;
  private speed = 0;
  private phase = rand(0, 6);
  private timer = rand(0.5, 4);
  private probeTimer = 0;
  private fireTimer = rand(1, 3);
  private burstLeft = 0;
  private burstTimer = 0;
  private engageTimer = 0;
  private aim = 0;
  deadTime = 0;
  private fallDirection = 1;
  private hasSight = false;
  /** Last angles written to each joint (degrees), so the death simulation starts from the live pose. */
  private angles = new Map<string, THREE.Vector3>();

  // Death simulation: the body topples about the feet like an inverted pendulum while the knees
  // buckle, and the limbs follow on loose springs so they lag, flail and flop on impact.
  private limbs = new Map<string, Limb>();
  private tilt = 0;
  private tiltVelocity = 0;
  private groundTilt = Math.PI / 2;
  private roll = 0;
  private rollTarget = 0;
  private knee = 0;
  private kneeTarget = 0;
  private kneeRate = 3;
  private bounces = 0;
  private landed = false;
  private groundChecked = false;
  private flinch = new THREE.Vector3();
  gunDropped = false;
  private sightTimer = 0;
  readonly scale = rand(0.95, 1.06);

  get isAlive() { return this.state !== "dead"; }
  /** Actively fighting: shows on the minimap at any range. */
  get isEngaged() { return this.state === "engage" || this.state === "scatter"; }
  get chest() { return this.position.clone().add(new THREE.Vector3(0, 1.2 * this.scale, 0)); }
  get headPosition() { return this.position.clone().add(new THREE.Vector3(0, 1.62 * this.scale, 0)); }

  constructor(at: THREE.Vector3, readonly sentry = false) {
    this.position = at.clone();
    this.home = at.clone();
    this.target = at.clone();
    const m = model("npc");
    const [shirt, pants, vest, helmet] = pick(OUTFITS);
    const skin = pick(SKINS);
    const pack = vest.clone().lerp(shirt, 0.35);
    m.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      this.meshes.push(mesh);
      const recolor = (orig: THREE.Material) => {
        const mat = (orig as THREE.MeshStandardMaterial).clone();
        const n = mat.name;
        const c = n.includes("shirt") ? shirt : n.includes("pants") ? pants : n.includes("vest") ? vest
          : n.includes("pack") ? pack : n.includes("helmet") ? helmet : n.includes("skin") ? skin : null;
        if (c) {
          mat.color.copy(c);
          mat.map = null;
        }
        return mat;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(recolor) : recolor(mesh.material);
    });
    // A joint is the plain-named node; end parts without children came through as "<name>_001".
    for (const name of JOINTS) {
      const node = m.getObjectByName(name) ?? m.getObjectByName(`${name}_001`);
      if (node) this.joints.set(name, node);
    }
    this.gunRest.copy(this.joints.get("npcgun")?.position ?? new THREE.Vector3());
    this.pivot.add(m);
    this.root.add(this.pivot);
    this.root.scale.setScalar(this.scale);
    this.root.name = "npc";
    if (sentry) { this.state = "engage"; this.engageTimer = 0; }
    this.apply();
    this.pose(0);
  }

  // MARK: Behaviour

  update(dt: number, env: NPCEnvironment) {
    if (this.state === "dead") {
      this.deadTime += dt;
      this.simulateDeath(dt, env);
      this.root.updateMatrixWorld(true);
      return;
    }
    this.flinch.multiplyScalar(Math.exp(-9 * dt));
    const head = this.headPosition;
    const toPlayer = env.playerEye.clone().sub(head);
    const distance = toPlayer.length();

    // Periodic sight check; a close, visible player draws attention.
    this.sightTimer -= dt;
    if (this.sightTimer <= 0) {
      this.sightTimer = rand(0.35, 0.6);
      this.hasSight = env.playerAlive && distance < 330 && env.world.lineOfSight(head, env.playerEye);
      if (this.hasSight && distance < 55 && this.state !== "scatter") {
        this.state = "engage";
        this.engageTimer = Math.max(this.engageTimer, 20);
      }
    }

    switch (this.state) {
      case "idle":
        this.speed = 0;
        this.timer -= dt;
        this.yaw += Math.sin(this.phase * 0.3) * 0.25 * dt;
        this.phase += dt;
        if (this.timer <= 0) { this.pickWaypoint(26); this.state = "patrol"; }
        break;
      case "patrol":
        this.speed = 1.35;
        if (this.move(dt, env)) { this.state = "idle"; this.timer = rand(2, 7); }
        break;
      case "scatter":
        this.speed = 4.4;
        this.timer -= dt;
        if (this.move(dt, env) || this.timer <= 0) { this.state = "engage"; this.fireTimer = rand(0.4, 1.4); }
        break;
      case "engage": {
        this.engageTimer -= dt;
        if ((this.engageTimer <= 0 || !env.playerAlive) && !this.sentry) {
          this.state = "idle";
          this.timer = rand(1, 3);
          this.home.copy(this.position);
        }
        const desired = Math.atan2(-toPlayer.x, -toPlayer.z);
        this.yaw = turn(this.yaw, desired, 5 * dt);
        const advancing = !this.sentry && (!this.hasSight || distance > 140) && distance > 30;
        if (advancing) {
          this.speed = 2.8;
          this.target = this.position.clone().add(new THREE.Vector3(toPlayer.x, 0, toPlayer.z).normalize().multiplyScalar(6));
          this.move(dt, env, false);
        } else {
          this.speed = 0;
        }
        if (this.burstLeft > 0) {
          this.burstTimer -= dt;
          if (this.burstTimer <= 0) {
            this.burstLeft -= 1;
            this.burstTimer = 0.11;
            this.root.updateMatrixWorld(true);
            env.npcFired(this, this.muzzle());
          }
        } else {
          this.fireTimer -= dt;
          if (this.fireTimer <= 0 && this.hasSight && this.aim > 0.8 && this.engageTimer > 0) {
            this.burstLeft = randInt(1, 3);
            this.burstTimer = 0;
            this.fireTimer = rand(1.4, 3.2);
          }
        }
        break;
      }
    }
    this.apply();
    this.pose(dt);
    this.root.updateMatrixWorld(true);
  }

  /** Called when the player respawns so nobody keeps firing at the new spawn point. */
  standDown() {
    if (this.state === "dead") return;
    this.burstLeft = 0;
    this.engageTimer = 0;
    if (!this.sentry) {
      this.state = "idle";
      this.timer = rand(1, 4);
      this.home.copy(this.position);
    }
  }

  /** Called when a round lands close by or a comrade is hit. */
  alert(threat: THREE.Vector3) {
    if (this.state === "dead") return;
    this.engageTimer = rand(22, 34);
    if (this.sentry) return;
    if (this.state === "engage" || this.state === "scatter") return;
    const away = new THREE.Vector3(this.position.x - threat.x, 0, this.position.z - threat.z).normalize()
      .add(new THREE.Vector3(rand(-1, 1), 0, rand(-1, 1)).multiplyScalar(0.8)).normalize();
    this.target = this.position.clone().addScaledVector(away, rand(5, 12));
    this.state = "scatter";
    this.timer = rand(1.2, 2.6);
  }

  private pickWaypoint(radius: number) {
    const a = rand(0, Math.PI * 2);
    const r = rand(5, radius);
    this.target = this.home.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    if (Math.hypot(this.target.x, this.target.z) > 190) this.target.copy(this.home);
  }

  /** Steps toward the current target. Returns true on arrival or when blocked. */
  private move(dt: number, env: NPCEnvironment, faceTravel = true): boolean {
    const d = this.target.clone().sub(this.position);
    d.y = 0;
    const dist = d.length();
    if (dist < 0.6) return true;
    const dir = d.divideScalar(dist);
    if (faceTravel) this.yaw = turn(this.yaw, Math.atan2(-dir.x, -dir.z), 6 * dt);

    this.probeTimer -= dt;
    if (this.probeTimer <= 0) {
      this.probeTimer = 0.2;
      const from = this.position.clone().add(new THREE.Vector3(0, 0.8, 0));
      const hit = env.world.raycast(from, from.clone().addScaledVector(dir, 1.6));
      if (hit && hit.normal.y < 0.6) {
        if (this.state === "patrol") this.pickWaypoint(20);
        else {
          const side = new THREE.Vector3().crossVectors(dir, Y).multiplyScalar(Math.random() < 0.5 ? 1 : -1);
          this.target = this.position.clone().addScaledVector(side, 5).addScaledVector(dir, 1.5);
        }
        return this.state !== "patrol";
      }
    }
    const nx = this.position.x + dir.x * this.speed * dt, nz = this.position.z + dir.z * this.speed * dt;
    const ground = env.world.groundHeight(nx, nz, this.position.y + 1.1, 4);
    if (ground === null) return true;
    if (ground - this.position.y > 0.55) return true;
    this.position.set(nx, ground, nz);
    this.phase += this.speed * dt * (this.speed > 3 ? 2.1 : 3.4);
    return false;
  }

  private muzzle(): THREE.Vector3 {
    const gun = this.joints.get("npcgun");
    // The rifle's barrel runs along its local -Z.
    return gun ? gun.localToWorld(new THREE.Vector3(0, 0.01, -0.72)) : this.chest;
  }

  // MARK: Damage

  /** Tests a world-space segment against this figure's body parts. */
  hitTest(a: THREE.Vector3, b: THREE.Vector3): NPCHit | null {
    if (this.state === "dead") return null;
    // Cheap reject: closest approach of the segment to the torso.
    const chest = this.chest;
    const ab = b.clone().sub(a);
    const len2 = Math.max(ab.lengthSq(), 1e-6);
    const t = Math.max(0, Math.min(1, chest.clone().sub(a).dot(ab) / len2));
    if (a.clone().addScaledVector(ab, t).distanceTo(chest) > 1.6) return null;

    const length = Math.sqrt(len2);
    _raycaster.set(a, ab.divideScalar(length));
    _raycaster.near = 0;
    _raycaster.far = length;
    const hits = _raycaster.intersectObjects(this.meshes, false);
    const r = hits.find((h) => h.object.visible && h.object.parent?.visible !== false);
    if (!r) return null;
    let node: THREE.Object3D | null = r.object;
    let part = "torso";
    while (node) {
      const name = node.name.replace(/_\d+$/, "");
      if (JOINTS.includes(name)) { part = name; break; }
      node = node.parent;
    }
    const zone: HitZone = part === "head" ? "head" : part === "torso" || part === "pelvis" ? "body" : "limb";
    const normal = r.face ? r.face.normal.clone().transformDirection(r.object.matrixWorld) : ab.clone().negate();
    if (normal.dot(ab) > 0) normal.negate();
    return { position: r.point.clone(), zone, normal, part: r.object };
  }

  /** World position of the carried rifle, while it is still in hand. */
  get gunPosition(): THREE.Vector3 | null {
    const gun = this.joints.get("npcgun");
    if (this.gunDropped || !gun) return null;
    return gun.localToWorld(new THREE.Vector3(0, 0, -0.2));
  }

  /** Where the chest ends up once the body is down. */
  get restingChest() {
    return this.position.clone().add(new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.fallDirection * 0.6 * this.scale));
  }

  dropGun() {
    this.gunDropped = true;
    const gun = this.joints.get("npcgun");
    if (gun) gun.visible = false;
  }

  /** Applies damage; returns true if this hit was fatal. */
  takeHit(zone: HitZone, damage: number, direction: THREE.Vector3): boolean {
    if (this.state === "dead") return false;
    const multiplier = zone === "head" ? 5 : zone === "body" ? 1 : 0.55;
    this.health -= damage * multiplier;
    const facing = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const fromFront = facing.dot(direction) < 0;
    const side = direction.dot(right);
    if (this.health <= 0) {
      this.die(zone, damage * multiplier, fromFront, side);
      return true;
    }
    // Survivable hit: a sharp jolt away from the round.
    const jolt = Math.min(1.6, 0.5 + damage / 40);
    this.flinch.add(new THREE.Vector3((fromFront ? -11 : 9) * jolt, 0, -side * 10 * jolt));
    if (zone === "head") this.flinch.x += fromFront ? -10 : 8;
    return false;
  }

  private die(zone: HitZone, damage: number, fromFront: boolean, side: number) {
    this.state = "dead";
    this.deadTime = 0;
    this.burstLeft = 0;
    // Shot from the front falls backward (+1); from behind, forward (-1).
    this.fallDirection = fromFront ? 1 : -1;
    if (zone === "head" || Math.random() < 0.2) {
      // Instant loss of control: the knees fold first and the body crumples onto them.
      this.kneeTarget = rand(0.75, 1);
      this.kneeRate = rand(5, 7);
      this.tiltVelocity = rand(0.2, 0.6);
      if (Math.random() < 0.45) this.fallDirection = -this.fallDirection;
    } else {
      // Torso hit: the round's momentum and the stagger start the fall.
      this.kneeTarget = rand(0.25, 0.65);
      this.kneeRate = rand(2, 3.5);
      this.tiltVelocity = Math.min(2.8, 0.7 + damage / 55) * rand(0.8, 1.2);
    }
    this.rollTarget = Math.max(-0.7, Math.min(0.7, side * 0.8 * this.fallDirection)) + rand(-0.3, 0.3);
    this.tilt = 0.02;
    this.roll = 0;
    this.knee = 0;
    this.bounces = 0;
    this.landed = false;
    this.groundChecked = false;

    const start = (name: string, rest: THREE.Vector3) => {
      this.limbs.set(name, { angle: (this.angles.get(name) ?? new THREE.Vector3()).clone(), velocity: new THREE.Vector3(), rest });
    };
    // Arms come to rest on the ground: small forward swing, the spread goes out to the sides.
    const lift: [number, number] = this.fallDirection > 0 ? [-15, 25] : [-35, 5];
    start("upperarm_L", new THREE.Vector3(rand(...lift), 0, rand(-85, -25)));
    start("upperarm_R", new THREE.Vector3(rand(...lift), 0, rand(25, 85)));
    start("forearm_L", new THREE.Vector3(rand(5, 55), 0, 0));
    start("forearm_R", new THREE.Vector3(rand(5, 55), 0, 0));
    start("head", new THREE.Vector3(rand(-25, 25), rand(-30, 30), rand(-30, 30)));
    start("torso", new THREE.Vector3(rand(-6, 8), 0, rand(-10, 10)));
  }

  /** Advances the fall. Tilt is the lean about the feet, roll the turn onto a side. */
  private simulateDeath(dt: number, env: NPCEnvironment) {
    if (dt <= 0) return;
    if (!this.groundChecked) {
      this.groundChecked = true;
      // Lie along the slope: find the ground where the head will land.
      const away = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)).multiplyScalar(this.fallDirection);
      const probe = this.position.clone().addScaledVector(away, 1.3);
      const g = env.world.groundHeight(probe.x, probe.z, this.position.y + 2.5, 6);
      if (g !== null) {
        const slope = Math.atan2(g - this.position.y, 1.3);
        this.groundTilt = Math.max(1.05, Math.min(1.95, Math.PI / 2 - slope - 0.04));
      }
    }

    // Knees fold toward their target; a folded body is shorter and falls faster.
    this.knee += (this.kneeTarget - this.knee) * Math.min(1, dt * this.kneeRate);
    const length = 0.95 * (1 - 0.4 * this.knee);
    if (!this.landed || Math.abs(this.tiltVelocity) > 0.01) {
      this.tiltVelocity += (9.81 / length) * Math.sin(Math.max(this.tilt, 0.02)) * dt;
      this.tiltVelocity *= Math.exp(-0.4 * dt);
      this.tilt += this.tiltVelocity * dt;
    }
    if (this.tilt >= this.groundTilt) {
      this.tilt = this.groundTilt;
      const impact = this.tiltVelocity;
      if (!this.landed) {
        this.landed = true;
        this.root.updateMatrixWorld(true);
        env.npcLanded(this, impact);
        // Legs settle out straighter once the weight is off them.
        this.kneeTarget = Math.min(this.kneeTarget, rand(0.04, 0.2));
        this.kneeRate = 2.5;
      }
      if (impact > 0.9 && this.bounces < 2) {
        this.bounces += 1;
        this.tiltVelocity = -impact * 0.2;
        // The landing throws the slack limbs.
        for (const limb of this.limbs.values()) {
          limb.velocity.add(new THREE.Vector3(rand(-1, 1), rand(-0.4, 0.4), rand(-1, 1)).multiplyScalar(impact * 160));
        }
      } else {
        this.tiltVelocity = 0;
      }
    }
    const progress = Math.max(0, Math.min(1, this.tilt / this.groundTilt));
    this.roll += (this.rollTarget * progress * progress - this.roll) * Math.min(1, dt * 6);

    // Loose springs: limbs lag the body's rotation, then sag to rest once down.
    const lag = this.fallDirection * this.tiltVelocity * 9;
    for (const [name, limb] of this.limbs) {
      const target = limb.rest.clone().multiplyScalar(this.landed ? 1 : 0.35 + 0.65 * progress);
      if (name.startsWith("upperarm")) target.x += lag;
      if (name === "head") target.x -= lag * 0.6;
      const stiffness = name === "torso" ? 90 : 38;
      const accel = target.sub(limb.angle).multiplyScalar(stiffness).addScaledVector(limb.velocity, -7);
      limb.velocity.addScaledVector(accel, dt);
      limb.angle.addScaledVector(limb.velocity, dt);
      this.set(name, limb.angle.x, limb.angle.y, limb.angle.z);
    }
    // Knees: hips flex forward while the shins fold back.
    const k = this.knee * 70;
    this.set("thigh_L", k + 4, 0, -6);
    this.set("thigh_R", k * 0.85 - 2, 0, 8);
    this.set("shin_L", -k * 1.7);
    this.set("shin_R", -k * 1.5);

    // Folding the legs shortens the figure: pull it down along its own axis to keep the feet on the
    // ground, and lift it by half the body depth as it comes to lie flat.
    const q = new THREE.Quaternion().setFromAxisAngle(X, this.fallDirection * this.tilt).multiply(_qy.setFromAxisAngle(Y, this.roll));
    this.pivot.quaternion.copy(q);
    const legs = 0.9 * (1 - Math.cos(this.knee * 70 * D2R));
    const offset = new THREE.Vector3(0, -legs, 0).applyQuaternion(q).add(new THREE.Vector3(0, 0.11 * Math.sin(this.tilt), 0));
    // Sink out of sight shortly before the body is recycled.
    if (this.deadTime > 14) offset.y -= (this.deadTime - 14) * 0.25;
    this.pivot.position.copy(offset);
  }

  // MARK: Pose

  private apply() {
    this.root.position.copy(this.position);
    this.root.rotation.set(0, this.yaw, 0);
  }

  private set(joint: string, x: number, y = 0, z = 0) {
    const a = this.angles.get(joint);
    if (a) a.set(x, y, z); else this.angles.set(joint, new THREE.Vector3(x, y, z));
    const node = this.joints.get(joint);
    if (!node) return;
    _q.setFromAxisAngle(Z, z * D2R).multiply(_qy.setFromAxisAngle(Y, y * D2R)).multiply(_qx.setFromAxisAngle(X, x * D2R));
    node.quaternion.copy(_q);
  }

  private pose(dt: number) {
    if (this.state === "dead") return;
    this.pivot.rotation.set(0, 0, 0);
    const moving = this.speed > 0.1;
    const running = this.speed > 3;
    const amp = moving ? (running ? 46 : 27) : 0;
    const knee = running ? 75 : 42;
    const s = Math.sin(this.phase), c = Math.cos(this.phase);
    this.set("thigh_L", amp * s + (running ? 8 : 0));
    this.set("thigh_R", -amp * s + (running ? 8 : 0));
    this.set("shin_L", moving ? -(8 + knee * Math.max(0, c)) : 0);
    this.set("shin_R", moving ? -(8 + knee * Math.max(0, -c)) : 0);
    this.pivot.position.set(0, moving ? Math.abs(s) * (running ? 0.05 : 0.025) - 0.02 : 0, 0);

    const wantAim = this.state === "engage" ? 1 : 0;
    this.aim += (wantAim - this.aim) * Math.min(1, dt * 6);
    if (dt === 0) this.aim = wantAim;
    const a = this.aim;
    const f = this.flinch;
    this.set("torso", (running ? 10 : 2) + 2 * a + f.x, 0, (moving ? 3 * s : 0) + f.z);
    this.set("head", (running ? -6 : 0) + f.x * 0.8, 0, f.z * 0.6);
    // Low-ready carry blends into a shouldered aim.
    this.set("upperarm_R", 30 + 38 * a, 0, -12);
    this.set("forearm_R", 78 - 30 * a, 0, 38 - 10 * a);
    this.set("upperarm_L", 52 + 26 * a, 0, 22);
    this.set("forearm_L", 46 - 22 * a, 0, -42 + 12 * a);
    const gun = this.joints.get("npcgun");
    if (gun) {
      gun.position.copy(this.gunRest).add(new THREE.Vector3(-0.03 * a, 0.02 * a, 0.13 * a));
      gun.quaternion.setFromAxisAngle(X, (-14 * (1 - a) + (this.burstLeft > 0 ? 3 : 0)) * D2R);
    }
  }
}

function turn(current: number, desired: number, maxStep: number): number {
  let delta = (desired - current) % (2 * Math.PI);
  if (delta > Math.PI) delta -= 2 * Math.PI;
  if (delta < -Math.PI) delta += 2 * Math.PI;
  return current + Math.max(-maxStep, Math.min(maxStep, delta));
}
