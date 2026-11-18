import * as THREE from "three";
import { model } from "./assets";
import { GameAudio } from "./audio";
import { BloodFX } from "./blood";
import type { FeedItem, Holdover, HUDSnapshot, Mode, Blip } from "./hud";
import { NPC, type NPCEnvironment, type NPCHit } from "./npc";
import { Particles } from "./particles";
import { canvasTexture, clamp, rand, softDisc } from "./util";
import { MODEL_NAMES, Pickup, Rarity, RIFLE_OPTICS, SPECS, Weapon, WeaponKind, prepareGunModel, type WeaponSpec } from "./weapons";
import { World } from "./world";

/** Raw input gathered between frames. Keys are KeyboardEvent.code values. */
export class Input {
  keys = new Set<string>();
  pressed = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  fireDown = false;
  firePressed = false;
  adsDown = false;
  scroll = 0;
  get shift() { return this.keys.has("ShiftLeft") || this.keys.has("ShiftRight"); }
  endFrame() {
    this.pressed.clear();
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.firePressed = false;
    this.scroll = 0;
  }
}

export type Quality = "low" | "medium" | "high";

interface Bullet {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
  age: number;
  damage: number;
  origin: THREE.Vector3;
  /** Rifle-calibre round: bigger wound and exit spray. */
  heavy: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const RIGHT = new THREE.Vector3(1, 0, 0);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export class Game implements NPCEnvironment {
  readonly camera = new THREE.PerspectiveCamera(62, 1, 0.03, 4000);
  readonly particles = new Particles();
  private blood: BloodFX;

  // Player
  private readonly spawnPoint = V(10, 12.1, 150);
  private position = this.spawnPoint.clone();
  private velocity = V();
  private yaw = 0;
  private pitch = -0.07;
  private grounded = true;
  private crouch = 0;
  private crouching = false;
  private health = 100;
  private sinceDamage = 99;
  private stepDistance = 0;
  private bobPhase = 0;
  mode: Mode = "ready";

  // Weapons: five inventory slots.
  private static startingLoadout = () => [new Weapon(WeaponKind.pistol, Rarity.common), new Weapon(WeaponKind.sniper, Rarity.rare), null, null, null];
  private slots: (Weapon | null)[] = Game.startingLoadout();
  private current = 1;
  private scopeZoom = 10;
  private weaponHolder = new THREE.Group();
  private viewModels = new Map<string, THREE.Object3D>();
  private muzzleFlash: THREE.Mesh;
  /** Raising a freshly selected weapon; it can't fire until this reaches zero. */
  private drawLeft = 0;
  private readonly drawTime = 0.45;
  private pumpPending = false;
  private scrollAccumulator = 0;

  // Loot
  private pickups: Pickup[] = [];
  private readonly maxPickups = 40;
  private nearPickup: Pickup | null = null;
  private ads = 0;
  private adsToggle = false;
  /** Seconds the assault rifle keeps its sight raised after the trigger is released. */
  private fireAimHold = 0;
  private sinceShot = 9;
  private reloadLeft = 0;
  private boltPending = false;
  private recoil = new THREE.Vector2();
  private weaponKick = 0;
  private swayTime = 0;
  private sway = new THREE.Vector2();
  private breath = 1;
  private winded = false;
  private holding = false;
  private lookDelta = new THREE.Vector2();

  // Ballistics
  private readonly muzzleVelocity = 820;
  private readonly drag = 0.00055;
  private zeroAngles = new Map<WeaponKind, number>();
  private zeroRange = 100;
  private readonly zeroSteps = [100, 200, 300, 400, 500, 600];
  private holdovers: Holdover[] = [];
  private driftPerWind = 0;
  private bullets: Bullet[] = [];

  // Wind: a steady base that gusts and veers slowly.
  private readonly windBase = rand(1.5, 5.5);
  private readonly windHeading = rand(0, Math.PI * 2);
  private windTime = 0;
  private wind = V();

  // World state
  private npcs: NPC[] = [];
  private readonly npcCount = 16;
  private kills = 0;
  private headshots = 0;
  private longest = 0;
  private feed: FeedItem[] = [];
  private hitAge = 9;
  private hitKill = false;
  private damageFlash = 0;
  private damageAngle = 0;
  private rangeReading: number | null = null;
  private rangeTimer = 0;
  private viewHeight = 800;
  private readonly baseFOV = 62;
  private flashes: { sprite: THREE.Sprite; left: number }[] = [];
  private flashMaterial: THREE.SpriteMaterial;
  quality: Quality = "medium";
  perfText: string | null = null;
  onQuality: (q: Quality) => void = () => {};

  get playerEye() { return this.position.clone().add(V(0, this.eyeHeight, 0)); }
  get playerAlive() { return this.mode !== "down"; }
  private get eyeHeight() { return 1.68 - 0.62 * this.crouch; }
  /** The weapon in hand. The current slot is never empty: pickups only fill or swap. */
  private get weapon(): Weapon { return this.slots[this.current] ?? new Weapon(WeaponKind.pistol, Rarity.common); }
  private get spec(): WeaponSpec { return this.weapon.spec; }

  constructor(readonly world: World, readonly audio: GameAudio) {
    world.scene.add(this.camera);
    world.scene.add(this.particles.points);
    this.blood = new BloodFX(world, this.particles);

    const flash = new THREE.PlaneGeometry(0.16, 0.16);
    this.muzzleFlash = new THREE.Mesh(flash, new THREE.MeshBasicMaterial({
      map: canvasTexture(softDisc("rgb(255,217,140)")), blending: THREE.AdditiveBlending,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    }));
    this.muzzleFlash.visible = false;
    this.flashMaterial = new THREE.SpriteMaterial({
      map: canvasTexture(softDisc("rgb(255,204,128)")), blending: THREE.AdditiveBlending,
      depthWrite: false, color: new THREE.Color(6, 6, 6), fog: false,
    });
    this.setupWeapon();
    this.computeBallistics();
    this.updateWind(0);
  }

  /** Separate from the constructor so the minimap can be rendered before anything moves in. */
  populate() {
    this.spawnInitialNPCs();
    this.spawnInitialPickups();
    this.placeCamera();
  }

  // MARK: Setup

  private setupWeapon() {
    for (const name of MODEL_NAMES) {
      const m = model(name);
      m.traverse((o) => {
        o.castShadow = false;
        if (o.name === "fp_arms" || o.name === "reddot_lens") o.visible = false;
        const mesh = o as THREE.Mesh;
        // Reflex and holo windows: the HUD draws the reticle, so the glass only needs to vanish.
        if (mesh.isMesh && (name === "smg" || name === "ar")) {
          const hide = (mat: THREE.Material) => {
            if (!mat.name.includes("glass")) return mat;
            const c = mat.clone();
            c.visible = false;
            return c;
          };
          mesh.material = Array.isArray(mesh.material) ? mesh.material.map(hide) : hide(mesh.material);
        }
      });
      m.visible = false;
      this.viewModels.set(name, m);
      this.weaponHolder.add(m);
    }
    this.camera.add(this.weaponHolder);
    this.weaponHolder.add(this.muzzleFlash);
    this.equip(this.current, false);
  }

  /** Takes out the weapon in `slot`: shows its model, resets aim and reload, and raises it. */
  private equip(slot: number, announce = true) {
    if (!this.slots[slot]) return;
    if (slot === this.current && announce) return;
    this.current = slot;
    const s = this.spec;
    for (const [name, node] of this.viewModels) node.visible = name === s.model;
    const rifle = this.viewModels.get("rifle");
    if (rifle) prepareGunModel(rifle, s);
    this.muzzleFlash.position.set(0, 0, -s.muzzle - 0.03);
    const kind = this.weapon.kind;
    const flashSize = kind === WeaponKind.pistol ? 0.11 : kind === WeaponKind.shotgun ? 0.24 : 0.16;
    this.muzzleFlash.scale.setScalar(flashSize / 0.16);
    // The suppressor hides most of the flash.
    (this.muzzleFlash.material as THREE.MeshBasicMaterial).opacity = kind === WeaponKind.smg ? 0.25 : 1;
    this.scopeZoom = clamp(this.scopeZoom, s.zoomMin, s.zoomMax);
    this.reloadLeft = 0;
    this.boltPending = false;
    this.pumpPending = false;
    this.ads = 0;
    this.adsToggle = false;
    this.drawLeft = announce ? this.drawTime : 0;
    if (announce) this.audio.play("draw", 0.55);
  }

  /** Flight of the round relative to a level line of sight: height (m) and time of flight (s) at a range. */
  private flight(angle: number, range: number, velocity = this.muzzleVelocity) {
    let px = 0, py = 0;
    let vx = Math.cos(angle) * velocity, vy = Math.sin(angle) * velocity;
    const dt = 1 / 600;
    let t = 0;
    while (px < range && vx > 50) {
      vy -= 9.81 * dt;
      const k = this.drag * Math.hypot(vx, vy) * dt;
      vx -= vx * k;
      vy -= vy * k;
      px += vx * dt;
      py += vy * dt;
      t += dt;
    }
    return { height: py, time: t };
  }

  private computeBallistics() {
    // Short-range guns carry a fixed battle zero; the scoped rifles use the dialled one.
    for (const kind of [0, 1, 2, 3, 4, 5] as WeaponKind[]) {
      const s = SPECS[kind];
      const zero = s.fixedZero ?? this.zeroRange;
      let angle = 0;
      for (let i = 0; i < 5; i++) angle -= Math.atan(this.flight(angle, zero, s.velocity).height / zero);
      this.zeroAngles.set(kind, angle);
    }
    const zeroAngle = this.zeroAngles.get(WeaponKind.sniper) ?? 0;
    this.holdovers = [200, 300, 400, 500, 600].map((r) => ({
      range: r,
      mils: Math.max(0, (-this.flight(zeroAngle, r).height / r) * 1000),
    }));
    // Crosswind drift follows the lag time: time of flight minus the time in a vacuum.
    const tof = this.flight(zeroAngle, 300).time;
    this.driftPerWind = ((tof - 300 / this.muzzleVelocity) / 300) * 1000;
  }

  private dialZero(step: number) {
    const index = this.zeroSteps.indexOf(this.zeroRange) + step;
    if (index < 0 || index >= this.zeroSteps.length) return;
    this.zeroRange = this.zeroSteps[index];
    this.computeBallistics();
    this.audio.play("click", 0.35);
  }

  private updateWind(dt: number) {
    this.windTime += dt;
    const t = this.windTime;
    const speed = Math.max(0, this.windBase * (1 + 0.35 * Math.sin(t * 0.21) + 0.15 * Math.sin(t * 0.83 + 1.1)));
    const heading = this.windHeading + 0.35 * Math.sin(t * 0.05);
    this.wind.set(Math.sin(heading) * speed, 0, Math.cos(heading) * speed);
  }

  cycleQuality() {
    const order: Quality[] = ["low", "medium", "high"];
    this.quality = order[(order.indexOf(this.quality) + 1) % 3];
    this.onQuality(this.quality);
    this.announce("Graphics", this.quality[0].toUpperCase() + this.quality.slice(1));
  }

  announce(text: string, detail: string) {
    this.feed.push({ text, detail, age: 0 });
    if (this.feed.length > 4) this.feed.shift();
  }

  // MARK: NPC spawning

  private spawnPosition(minPlayerDistance: number): THREE.Vector3 | null {
    for (let k = 0; k < 40; k++) {
      let x: number, z: number;
      if (Math.random() < 0.6) {
        x = rand(-33, 28);
        z = rand(-32, 30);
      } else {
        const a = rand(0, Math.PI * 2), r = rand(45, 135);
        x = Math.cos(a) * r;
        z = Math.sin(a) * r;
      }
      const hit = this.world.raycast(V(x, 80, z), V(x, -20, z));
      if (!hit || hit.tag !== "terrain" || hit.normal.y <= 0.85) continue;
      const p = hit.position;
      if (p.distanceTo(this.position) < minPlayerDistance) continue;
      // Keep clear of walls so nobody starts wedged in geometry.
      const chest = p.clone().add(V(0, 1, 0));
      const clear = [V(1, 0, 0), V(-1, 0, 0), V(0, 0, 1), V(0, 0, -1)].every(
        (d) => !this.world.raycast(chest, chest.clone().addScaledVector(d, 0.8)),
      );
      if (clear) return p;
    }
    return null;
  }

  private spawnInitialNPCs() {
    this.add(new NPC(V(18, 6.3, -22), true));
    for (let i = 0; i < this.npcCount; i++) {
      const p = this.spawnPosition(60);
      if (p) this.add(new NPC(p));
    }
  }

  private add(npc: NPC) {
    this.npcs.push(npc);
    this.world.scene.add(npc.root);
  }

  // MARK: Loot

  private spawnInitialPickups() {
    // A few at the overlook so the player has a choice from the start, the rest scattered.
    const starters = [new Weapon(WeaponKind.assaultRifle, Rarity.uncommon), new Weapon(WeaponKind.shotgun, Rarity.common), new Weapon(WeaponKind.smg, Rarity.common)];
    starters.forEach((w, i) => {
      const a = i * 0.9 - 0.9;
      const p = this.spawnPoint.clone().add(V(Math.sin(a) * 3.2, 0, -Math.cos(a) * 3.2 + 1));
      const y = this.world.groundHeight(p.x, p.z, this.spawnPoint.y + 3, 40);
      if (y !== null) this.addPickup(w, V(p.x, y, p.z));
    });
    for (let i = 0; i < 16; i++) {
      const p = this.spawnPosition(25);
      if (p) this.addPickup(Weapon.randomLoot(), p);
    }
  }

  private addPickup(weapon: Weapon, ground: THREE.Vector3) {
    const pickup = new Pickup(weapon, ground);
    this.pickups.push(pickup);
    this.world.scene.add(pickup.node);
    const live = this.pickups.filter((p) => p.fadeOut < 0);
    if (live.length > this.maxPickups) live[0].fadeOut = 0; // retire the oldest loot nobody has touched
  }

  /** Finds the gun the player is looking at within reach, and handles E to take it. */
  private handlePickups(input: Input) {
    const forward = V(0, 0, -1).applyQuaternion(this.viewOrientation());
    const eye = this.playerEye;
    let best: Pickup | null = null;
    let bestScore = Infinity;
    for (const p of this.pickups) {
      if (p.fadeOut >= 0) continue;
      const to = p.position.clone().sub(eye);
      const d = Math.hypot(to.x, to.z);
      if (d >= 2.6 || Math.abs(p.position.y - this.position.y) >= 1.6) continue;
      const facing = to.normalize().dot(forward);
      // Anything at your feet counts; farther ones need a look.
      if (!(d < 1.1 || facing > 0.82)) continue;
      const score = d - facing * 1.5;
      if (score < bestScore) { bestScore = score; best = p; }
    }
    this.nearPickup = best;
    if (best && input.pressed.has("KeyE")) this.take(best);
  }

  private take(pickup: Pickup) {
    const index = this.pickups.indexOf(pickup);
    if (index < 0) return;
    this.pickups.splice(index, 1);
    pickup.node.removeFromParent();
    this.nearPickup = null;
    const empty = this.slots.findIndex((s) => s === null);
    if (empty >= 0) {
      this.slots[empty] = pickup.weapon;
      this.equip(empty);
    } else {
      // Full: swap with the gun in hand, which drops where the new one lay.
      const dropped = this.weapon;
      this.slots[this.current] = pickup.weapon;
      this.equip(this.current, false);
      this.drawLeft = this.drawTime;
      this.addPickup(dropped, pickup.position);
    }
    this.audio.play("pickup", 0.7);
    this.announce(["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"][pickup.weapon.rarity], pickup.weapon.spec.name);
  }

  // MARK: Frame update

  begin() {
    if (this.mode === "down") this.respawn();
    this.mode = "playing";
  }

  pause() {
    if (this.mode === "playing") this.mode = "paused";
  }

  private respawn() {
    // Back to the starting kit; anything picked up stays where you fell, for the taking.
    const kit = Game.startingLoadout().filter((w): w is Weapon => !!w);
    const found = this.slots.filter((w): w is Weapon => !!w && !kit.some((k) => k.kind === w.kind && k.rarity === w.rarity));
    found.forEach((w, i) => {
      const a = i * 2.1;
      const p = this.position.clone().add(V(Math.cos(a) * 0.8, 0, Math.sin(a) * 0.8));
      const y = this.world.groundHeight(p.x, p.z, this.position.y + 1, 4) ?? this.position.y;
      this.addPickup(w, V(p.x, y, p.z));
    });
    this.position.copy(this.spawnPoint);
    this.velocity.set(0, 0, 0);
    this.yaw = 0;
    this.pitch = -0.07;
    this.health = 100;
    this.crouching = false;
    this.crouch = 0;
    this.slots = Game.startingLoadout();
    this.equip(1, false);
    this.reloadLeft = 0;
    this.bullets = [];
    this.damageFlash = 0;
    this.sinceDamage = 99;
    // NPCs freeze while the player is down; without this they resume firing at the spawn point.
    for (const npc of this.npcs) npc.standDown();
  }

  update(rawDT: number, input: Input, viewHeight: number) {
    const dt = Math.min(rawDT, 0.05);
    this.viewHeight = Math.max(viewHeight, 100);
    if (this.mode === "playing") {
      if (input.pressed.has("KeyG")) this.cycleQuality();
      this.handleLook(input);
      this.handleMovement(dt, input);
      this.handleWeapon(dt, input);
      this.handlePickups(input);
      this.updateWind(dt);
      this.updateBullets(dt);
      this.updateNPCs(dt);
      this.updateVitals(dt);
    }
    this.placeCamera();
    const eye = this.playerEye;
    this.pickups = this.pickups.filter((p) => p.update(dt, eye));
    this.particles.update(dt);
    this.blood.update(dt);
    for (const f of this.flashes) {
      f.left -= dt;
      if (f.left <= 0) f.sprite.removeFromParent();
    }
    this.flashes = this.flashes.filter((f) => f.left > 0);
    this.world.followShadow(this.position);
    this.hitAge += dt;
    this.damageFlash = Math.max(0, this.damageFlash - dt * 1.4);
    for (const f of this.feed) f.age += dt;
    this.feed = this.feed.filter((f) => f.age <= 5);
    input.endFrame();
  }

  private get currentZoom() {
    const s = this.spec;
    const target = s.zoomMax > s.zoomMin ? this.scopeZoom : s.zoomMin;
    const t = this.ads * this.ads * (3 - 2 * this.ads);
    return 1 + (target - 1) * t;
  }

  private handleLook(input: Input) {
    const sensitivity = 0.0021 / this.currentZoom;
    this.lookDelta.set(input.mouseDX * sensitivity, input.mouseDY * sensitivity);
    this.yaw -= this.lookDelta.x;
    this.pitch = clamp(this.pitch - this.lookDelta.y, -1.45, 1.45);
  }

  private handleMovement(dt: number, input: Input) {
    if (input.pressed.has("KeyC")) this.crouching = !this.crouching;
    this.crouch += ((this.crouching ? 1 : 0) - this.crouch) * Math.min(1, dt * 9);

    const forward = V(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = V(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wish = V();
    if (input.keys.has("KeyW")) wish.add(forward);
    if (input.keys.has("KeyS")) wish.sub(forward);
    if (input.keys.has("KeyD")) wish.add(right);
    if (input.keys.has("KeyA")) wish.sub(right);
    if (wish.lengthSq() > 0.01) wish.normalize();
    const sprinting = input.shift && this.ads < 0.3 && !this.crouching && input.keys.has("KeyW");
    const speed = this.crouching ? 1.7 : this.ads > 0.5 ? 1.9 : sprinting ? 5.8 : 3.5;
    const accel = this.grounded ? 11 : 2;
    const k = Math.min(1, accel * dt);
    this.velocity.x += (wish.x * speed - this.velocity.x) * k;
    this.velocity.z += (wish.z * speed - this.velocity.z) * k;

    const step = V(this.velocity.x * dt, 0, this.velocity.z * dt);
    for (let pass = 0; pass < 2; pass++) {
      const len = step.length();
      if (len < 1e-5) break;
      const dir = step.clone().divideScalar(len);
      let blocked = false;
      for (const h of [0.5, 1.0, this.eyeHeight - 0.15]) {
        const from = this.position.clone().add(V(0, h, 0));
        const hit = this.world.raycast(from, from.clone().addScaledVector(dir, len + 0.38));
        if (hit && hit.normal.y < 0.65) {
          const n = V(hit.normal.x, 0, hit.normal.z);
          if (n.length() > 0.01) n.normalize(); else n.copy(dir).negate();
          const into = step.dot(n);
          if (into < 0) step.addScaledVector(n, -into);
          if (hit.distance < 0.36) step.addScaledVector(n, (0.36 - hit.distance) * 0.5);
          blocked = true;
          break;
        }
      }
      if (!blocked) break;
    }
    this.position.add(step);
    const radius = Math.hypot(this.position.x, this.position.z);
    if (radius > 202) {
      this.position.x *= 202 / radius;
      this.position.z *= 202 / radius;
    }

    const ground = this.world.groundHeight(this.position.x, this.position.z, this.position.y + 0.6, 40);
    if (this.grounded) {
      if (input.pressed.has("Space") && !this.crouching) {
        this.velocity.y = 4.4;
        this.grounded = false;
      } else if (ground !== null && this.position.y - ground < 0.45) {
        this.position.y += (ground - this.position.y) * Math.min(1, dt * 18);
      } else {
        this.grounded = false;
        this.velocity.y = 0;
      }
    }
    if (!this.grounded) {
      this.velocity.y -= 14 * dt;
      this.position.y += this.velocity.y * dt;
      if (ground !== null && this.position.y <= ground && this.velocity.y <= 0) {
        this.position.y = ground;
        this.grounded = true;
        this.velocity.y = 0;
        this.audio.play("step", 0.5);
      }
    }

    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && horizontal > 0.5) {
      this.stepDistance += horizontal * dt;
      this.bobPhase += horizontal * dt * 3.3;
      if (this.stepDistance > (sprinting ? 2.3 : 1.7)) {
        this.stepDistance = 0;
        this.audio.play("step", this.crouching ? 0.12 : sprinting ? 0.4 : 0.25);
      }
    }
  }

  private handleWeapon(dt: number, input: Input) {
    ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5"].forEach((key, i) => {
      if (input.pressed.has(key)) this.equip(i);
    });
    if (input.pressed.has("KeyQ")) this.adsToggle = !this.adsToggle;
    if (input.pressed.has("ArrowUp")) this.dialZero(1);
    if (input.pressed.has("ArrowDown")) this.dialZero(-1);
    const s = this.spec;
    const variableZoom = s.zoomMax > s.zoomMin;
    if (variableZoom) {
      let z = this.scopeZoom;
      if (this.ads > 0.5 && Math.abs(input.scroll) > 0.01) z *= Math.pow(1.06, input.scroll);
      if (input.pressed.has("Equal") || input.pressed.has("NumpadAdd")) z *= 1.35;
      if (input.pressed.has("Minus") || input.pressed.has("NumpadSubtract")) z /= 1.35;
      this.scopeZoom = clamp(z, s.zoomMin, s.zoomMax);
    }
    // The wheel cycles weapons, except while it is working a variable scope.
    if (!(variableZoom && this.ads > 0.5)) {
      this.scrollAccumulator += input.scroll;
      if (Math.abs(this.scrollAccumulator) >= 1.5) {
        this.cycleWeapon(this.scrollAccumulator > 0 ? -1 : 1);
        this.scrollAccumulator = 0;
      }
    } else {
      this.scrollAccumulator = 0;
    }

    this.sinceShot += dt;
    this.drawLeft = Math.max(0, this.drawLeft - dt);
    // The assault rifle shoots from its sight: holding the trigger raises it, and it stays up a moment after.
    if (this.weapon.kind === WeaponKind.assaultRifle && input.fireDown && this.drawLeft <= 0) this.fireAimHold = 0.35;
    else this.fireAimHold = Math.max(0, this.fireAimHold - dt);
    const wantsADS = (input.adsDown || this.adsToggle || this.fireAimHold > 0) && (this.reloadLeft <= 0 || s.shellFed) && this.drawLeft <= 0;
    const adsSpeed = s.overlay ? 5.5 : 8;
    this.ads = clamp(this.ads + (wantsADS ? adsSpeed : -adsSpeed) * dt, 0, 1);

    const w = this.weapon;
    const reloadTime = s.reloadTime * w.reloadScale;
    if (this.reloadLeft > 0) {
      this.reloadLeft -= dt;
      if (this.reloadLeft <= 0) {
        if (s.shellFed) {
          // One shell at a time; keep feeding until full.
          w.ammo += 1;
          this.audio.play("shell", 0.6);
          if (w.ammo < s.magSize) this.reloadLeft = reloadTime;
        } else {
          w.ammo = s.magSize;
        }
      }
    } else if (input.pressed.has("KeyR") && w.ammo < s.magSize && this.drawLeft <= 0) {
      this.startReload();
    }
    if (this.boltPending && this.sinceShot > 0.3) {
      this.boltPending = false;
      this.audio.play("bolt", 0.6);
    }
    if (this.pumpPending && this.sinceShot > 0.22) {
      this.pumpPending = false;
      this.audio.play("pump", 0.75);
    }

    const interval = 60 / s.rpm;
    const trigger = s.automatic ? input.fireDown : input.firePressed;
    // A shell-fed gun can interrupt its reload to fire what is already loaded.
    const canFire = this.drawLeft <= 0 && (this.reloadLeft <= 0 || (s.shellFed && w.ammo > 0));
    if (trigger && this.sinceShot >= interval && canFire) {
      if (w.ammo > 0) {
        this.reloadLeft = 0;
        this.fire();
      } else if (input.firePressed) {
        this.audio.play("click", 0.7);
        this.startReload(0.15);
      }
    }

    // Breath control steadies the scope for a few seconds.
    const horizontal = Math.hypot(this.velocity.x, this.velocity.z);
    this.holding = input.shift && this.ads > 0.6 && !this.winded && horizontal < 0.5;
    if (this.holding) {
      this.breath -= dt / 6;
      if (this.breath <= 0) { this.breath = 0; this.winded = true; }
    } else {
      this.breath = Math.min(1, this.breath + dt / (this.winded ? 5 : 3.5));
      if (this.winded && this.breath > 0.45) this.winded = false;
    }
    this.swayTime += dt * (this.winded ? 1.7 : 1);
    let amplitude = 0.0021 * (1 - 0.5 * this.crouch) * (1 + horizontal * 1.4);
    if (this.holding) amplitude *= 0.1;
    if (this.winded) amplitude *= 2.1;
    amplitude *= this.ads;
    const t = this.swayTime;
    this.sway.set(
      Math.sin(t * 0.83) + 0.45 * Math.sin(t * 2.1 + 1.3) + 0.2 * Math.sin(t * 4.7),
      Math.cos(t * 0.67 + 0.5) + 0.45 * Math.sin(t * 1.7) + 0.2 * Math.cos(t * 5.3),
    ).multiplyScalar(amplitude);

    this.recoil.multiplyScalar(1 - Math.min(1, dt * 7));
    this.weaponKick -= this.weaponKick * Math.min(1, dt * 14);
    if (this.sinceShot > 0.045) this.muzzleFlash.visible = false;
  }

  private startReload(delay = 0) {
    const s = this.spec;
    this.reloadLeft = s.reloadTime * this.weapon.reloadScale + (s.shellFed ? 0.25 : 0);
    this.audio.play(s.shellFed ? "click" : "reload", 0.7, delay);
  }

  private cycleWeapon(step: number) {
    const filled = this.slots.map((s, i) => (s ? i : -1)).filter((i) => i >= 0);
    const at = filled.indexOf(this.current);
    if (filled.length <= 1 || at < 0) return;
    this.equip(filled[(at + step + filled.length) % filled.length]);
  }

  /** Spread of the hip-fire cone, also drawn as the crosshair gap. */
  private get hipSpread() {
    const moving = Math.hypot(this.velocity.x, this.velocity.z);
    return (1 - this.ads) * (this.spec.hipSpread + moving * 0.006) + (this.grounded ? 0 : 0.03);
  }

  private fire() {
    const s = this.spec;
    const w = this.weapon;
    w.ammo -= 1;
    this.sinceShot = 0;
    const q = this.viewOrientation();
    const forward = V(0, 0, -1).applyQuaternion(q);
    const up = V(0, 1, 0).applyQuaternion(q);
    const right = V(1, 0, 0).applyQuaternion(q);
    const elevation = Math.tan(this.zeroAngles.get(w.kind) ?? 0);
    // One aim error for the shot, plus each pellet's own scatter for the shotgun.
    const a = rand(0, Math.PI * 2);
    const r = this.hipSpread * Math.sqrt(Math.random());
    const aim = right.clone().multiplyScalar(Math.cos(a) * r).addScaledVector(up, Math.sin(a) * r + elevation);
    const damage = s.damage * w.damageScale;
    const eye = this.playerEye;
    for (let i = 0; i < s.pellets; i++) {
      const scatter = V();
      if (s.pelletSpread > 0) {
        const pa = rand(0, Math.PI * 2);
        const pr = s.pelletSpread * Math.sqrt(Math.random());
        scatter.copy(right).multiplyScalar(Math.cos(pa) * pr).addScaledVector(up, Math.sin(pa) * pr);
      }
      const dir = forward.clone().add(aim).add(scatter).normalize();
      const v = s.velocity * rand(0.985, 1.015);
      this.bullets.push({ position: eye.clone(), velocity: dir.multiplyScalar(v), age: 0, damage, origin: eye.clone(), heavy: s.velocity > 700 });
    }

    const k = (s.kick * (1 - 0.35 * this.crouch) * Math.PI) / 180;
    this.recoil.x += rand(-0.35, 0.35) * k;
    this.recoil.y += k;
    // Part of every kick stays as muzzle climb the shooter has to pull down.
    this.pitch += k * 0.22;
    this.weaponKick += 0.035 + s.kick * 0.012;
    this.muzzleFlash.visible = !(this.ads > 0.8 && s.overlay);
    this.muzzleFlash.rotation.z = rand(0, 6);
    this.audio.play(s.sound, 0.95);
    if (s.action === "bolt") this.boltPending = true;
    if (s.action === "pump") this.pumpPending = true;
    // The report carries: hostiles within earshot notice.
    for (const npc of this.npcs) {
      if (npc.isAlive && npc.position.distanceTo(this.position) < s.loudness) npc.alert(this.position);
    }
  }

  private viewOrientation(): THREE.Quaternion {
    const y = new THREE.Quaternion().setFromAxisAngle(UP, this.yaw + this.sway.x + this.recoil.x);
    const p = new THREE.Quaternion().setFromAxisAngle(RIGHT, this.pitch + this.sway.y + this.recoil.y);
    return y.multiply(p);
  }

  private placeCamera() {
    const cam = this.camera;
    cam.position.copy(this.playerEye).add(V(0, Math.sin(this.bobPhase * 2) * 0.012 * (1 - this.ads), 0));
    cam.quaternion.copy(this.viewOrientation());
    // Zoom narrows the field of view exactly as tan(fov/2) / zoom; LOD distances follow it too.
    cam.fov = this.baseFOV;
    cam.zoom = this.currentZoom;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();

    // Weapon: hip position blends to the sight line.
    const s = this.spec;
    const hip = V(...s.hip);
    const aim = V(0, -s.sightHeight, -s.aimDepth);
    const t = this.ads * this.ads * (3 - 2 * this.ads);
    const p = hip.clone().lerp(aim, t);
    const bob = (1 - t) * 0.006;
    p.add(V(Math.cos(this.bobPhase) * bob, Math.abs(Math.sin(this.bobPhase)) * bob, this.weaponKick));
    p.add(V(-this.lookDelta.x * 0.6, this.lookDelta.y * 0.6, 0).multiplyScalar(1 - t * 0.7));
    // Magazine changes dip the gun; shell loading only tilts it a little.
    const fullReload = s.reloadTime * this.weapon.reloadScale;
    let lower = this.reloadLeft > 0 ? (s.shellFed ? 0.35 : Math.min(1, Math.min(this.reloadLeft, fullReload - this.reloadLeft) * 5)) : 0;
    // A newly drawn weapon swings up from below.
    const draw = this.drawLeft / this.drawTime;
    lower = Math.max(lower, draw * draw * 2.2);
    p.y -= 0.09 * lower;
    // Working the pump slides the gun back briefly.
    if (s.action === "pump" && this.sinceShot > 0.18 && this.sinceShot < 0.5) {
      p.z += Math.sin(((this.sinceShot - 0.18) / 0.32) * Math.PI) * 0.045;
    }
    this.weaponHolder.position.copy(p);
    this.weaponHolder.rotation.set(this.weaponKick * 0.9 - 0.5 * lower, (1 - t) * -0.03, lower * 0.35);
    this.weaponHolder.visible = !(s.overlay && this.ads > 0.86);
  }

  // MARK: Bullets

  private updateBullets(dt: number) {
    const remaining: Bullet[] = [];
    const bloodied = new Set<NPC>();
    for (const b of this.bullets) {
      b.age += dt;
      const start = b.position.clone();
      b.velocity.y -= 9.81 * dt;
      // Drag acts on the round's speed through the air, so a crosswind carries it sideways.
      const air = b.velocity.clone().sub(this.wind);
      b.velocity.addScaledVector(air, -this.drag * air.length() * dt);
      const end = start.clone().addScaledVector(b.velocity, dt);

      let nearest = Infinity;
      const worldHit = this.world.raycast(start, end);
      if (worldHit) nearest = worldHit.distance;
      let struck: { npc: NPC; hit: NPCHit } | null = null;
      for (const npc of this.npcs) {
        const h = npc.hitTest(start, end);
        if (h) {
          const d = start.distanceTo(h.position);
          if (d < nearest) { nearest = d; struck = { npc, hit: h }; }
        }
      }
      if (struck) {
        // Shotgun pellets arrive together: one full blood burst per target per frame.
        const first = !bloodied.has(struck.npc);
        bloodied.add(struck.npc);
        this.resolveHit(struck.npc, struck.hit, b, first);
      } else if (worldHit) {
        this.impact(worldHit.position, worldHit.normal);
      } else if (b.age < 3 && end.y > -40) {
        b.position.copy(end);
        remaining.push(b);
      }
    }
    this.bullets = remaining;
  }

  private resolveHit(npc: NPC, hit: NPCHit, bullet: Bullet, effects: boolean) {
    const point = hit.position;
    const direction = bullet.velocity.clone().normalize();
    const distance = bullet.origin.distanceTo(point);
    const killed = npc.takeHit(hit.zone, bullet.damage, direction);
    if (effects) {
      this.blood.hit(point, direction, hit.normal, hit.part, bullet.heavy, hit.zone === "head");
      this.audio.play("hit_flesh", clamp(12 / distance, 0.08, 0.6), distance / 343);
    }
    // A kill marker from this volley isn't downgraded by a later pellet.
    this.hitKill = killed || (this.hitKill && this.hitAge < 0.05);
    this.hitAge = 0;
    if (effects || killed) this.audio.play("confirm", killed ? 0.5 : 0.28);
    if (killed) {
      this.kills += 1;
      if (hit.zone === "head") this.headshots += 1;
      this.longest = Math.max(this.longest, distance);
      this.announce(hit.zone === "head" ? "Headshot" : "Target down", `${distance.toFixed(0)} m`);
    }
    for (const other of this.npcs) {
      if (other.isAlive && (other.position.distanceTo(npc.position) < 42 || other.sentry)) other.alert(this.position);
    }
  }

  private impact(point: THREE.Vector3, normal: THREE.Vector3) {
    this.particles.emit({
      at: point.clone().addScaledVector(normal, 0.03), direction: normal, count: 22, speed: 2.6, speedVariation: 1.8,
      spread: 38, size: 0.16, sizeVariation: 0.08, grow: 4.5, life: 0.8, lifeVariation: 0.3,
      color: new THREE.Color().setRGB(0.62, 0.55, 0.42, THREE.SRGBColorSpace), alpha: 0.7, fade: [1, 0.7, 0],
      gravity: 2.2, damping: 2,
    });
    const d = point.distanceTo(this.playerEye);
    this.audio.play("impact", clamp(6 / d, 0.03, 0.5), d / 343);
    for (const npc of this.npcs) {
      if (npc.isAlive && npc.position.distanceTo(point) < 14) npc.alert(this.position);
    }
  }

  // MARK: NPCs

  private updateNPCs(dt: number) {
    for (const npc of this.npcs) npc.update(dt, this);
    this.npcs.forEach((npc, i) => {
      if (npc.isAlive || npc.deadTime <= 18) return;
      npc.root.removeFromParent();
      const p = npc.sentry ? V(18, 6.3, -22) : this.spawnPosition(80);
      if (!p) return;
      const replacement = new NPC(p, npc.sentry);
      this.npcs[i] = replacement;
      this.world.scene.add(replacement.root);
    });
  }

  npcLanded(npc: NPC, impact: number) {
    const d = npc.position.distanceTo(this.playerEye);
    this.audio.play("thud", clamp(9 / d, 0.03, 0.7) * Math.min(1, 0.4 + impact * 0.3), d / 343);
    // The rifle falls from his hands and can be taken.
    const gun = npc.gunPosition;
    if (gun) {
      npc.dropGun();
      const y = this.world.groundHeight(gun.x, gun.z, gun.y + 1, 4);
      if (y !== null) this.addPickup(Weapon.randomLoot(), V(gun.x, y, gun.z));
    }
    // Bleeding out beneath the chest.
    this.blood.pool(npc.restingChest);
  }

  npcFired(npc: NPC, muzzle: THREE.Vector3) {
    const eye = this.playerEye;
    const distance = eye.distanceTo(muzzle);
    this.flash(muzzle);
    const local = this.camera.worldToLocal(muzzle.clone());
    const pan = clamp((local.x / Math.max(distance, 1)) * 1.5, -1, 1);
    // Close by you hear the whole rifle; further out the air eats the highs and the echo takes over.
    const report = distance < 40 ? "shot_ar" : distance < 120 ? "shot_mid" : "shot_far";
    const loudness = distance < 40 ? Math.min(0.8, 9 / Math.max(distance, 1)) : clamp(30 / distance, 0.08, 0.85);
    this.audio.play(report, loudness, distance / 343, pan * 0.8);

    let chance = clamp(7.5 / distance, 0.012, 0.34);
    if (this.crouching) chance *= 0.6;
    if (this.velocity.length() > 3) chance *= 0.65;
    if (Math.random() < chance) {
      this.damage(rand(11, 19), muzzle);
    } else {
      if (Math.random() < 0.6) this.audio.play("whiz", 0.5, distance / 800, rand(-0.8, 0.8));
      const a = rand(0, Math.PI * 2), r = rand(1.2, 5);
      const x = this.position.x + Math.cos(a) * r, z = this.position.z + Math.sin(a) * r;
      const y = this.world.groundHeight(x, z, this.position.y + 2, 8);
      if (y !== null) this.impact(V(x, y, z), V(0, 1, 0));
    }
    void npc;
  }

  private damage(amount: number, source: THREE.Vector3) {
    if (this.mode !== "playing") return;
    this.health -= amount;
    this.sinceDamage = 0;
    this.damageFlash = 1;
    const d = source.clone().sub(this.position);
    this.damageAngle = Math.atan2(-d.x, -d.z) - this.yaw;
    this.recoil.x += rand(-0.012, 0.012);
    this.recoil.y += 0.01;
    this.audio.play("hurt", 0.8);
    if (this.health <= 0) {
      this.health = 0;
      this.mode = "down";
      this.onDown();
    }
  }

  onDown: () => void = () => {};

  private updateVitals(dt: number) {
    this.sinceDamage += dt;
    if (this.sinceDamage > 5 && this.health < 100) this.health = Math.min(100, this.health + dt * 6);
    this.rangeTimer -= dt;
    if (this.rangeTimer <= 0) {
      this.rangeTimer = 0.2;
      this.rangeReading = this.ads > 0.5 ? this.lase() : null;
    }
  }

  /** Laser rangefinder along the sight line. */
  private lase(): number | null {
    const from = this.playerEye;
    const to = from.clone().addScaledVector(V(0, 0, -1).applyQuaternion(this.viewOrientation()), 1500);
    let best: number | null = null;
    const h = this.world.raycast(from, to);
    if (h) best = h.distance;
    for (const npc of this.npcs) {
      const n = npc.hitTest(from, to);
      if (n) {
        const d = from.distanceTo(n.position);
        if (d < (best ?? Infinity)) best = d;
      }
    }
    return best;
  }

  private flash(at: THREE.Vector3) {
    const sprite = new THREE.Sprite(this.flashMaterial);
    sprite.position.copy(at);
    sprite.scale.setScalar(0.5);
    this.world.scene.add(sprite);
    this.flashes.push({ sprite, left: 0.07 });
  }

  // MARK: HUD

  snapshot(): HUDSnapshot {
    const w = this.weapon;
    const spec = w.spec;
    const zoom = this.currentZoom;
    const fov = 2 * Math.atan(Math.tan((this.baseFOV * Math.PI) / 360) / zoom);
    const pxPerMil = (this.viewHeight / 2 / Math.tan(fov / 2)) * 0.001;
    const scoped = spec.overlay && this.ads > 0.86;
    const moving = Math.hypot(this.velocity.x, this.velocity.z);
    // Crosshair gap drawn at the real cone: hip spread plus the pellet pattern, in screen pixels.
    const cone = spec.hipSpread + spec.pelletSpread + moving * 0.006 + (this.grounded ? 0 : 0.03);
    const blips: Blip[] = [];
    // Minimap: hostiles show close by, or at any range once they are fighting; loot within 60 m.
    for (const npc of this.npcs) {
      if (!npc.isAlive) continue;
      const d = npc.position.distanceTo(this.position);
      if (d < 70 || (npc.isEngaged && d < 260)) blips.push({ x: npc.position.x, z: npc.position.z, kind: "hostile", rarity: 0 });
    }
    for (const p of this.pickups) {
      if (p.position.distanceTo(this.position) < 60) blips.push({ x: p.position.x, z: p.position.z, kind: "pickup", rarity: p.weapon.rarity });
    }
    const right = V(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const cross = this.wind.dot(right);
    return {
      mode: this.mode,
      ammo: w.ammo,
      magSize: spec.magSize,
      reloading: this.reloadLeft > 0,
      health: this.health,
      kills: this.kills,
      headshots: this.headshots,
      longest: this.longest,
      opticName: spec.name,
      fireMode: spec.fireMode,
      reticle: spec.reticle,
      ads: this.ads,
      scoped,
      zoom,
      pxPerMil,
      range: this.rangeReading,
      breath: this.breath,
      holding: this.holding,
      // The exit pupil drifts as the rifle moves, shading one side of the scope picture.
      shadowX: scoped ? -this.lookDelta.x * 900 + this.sway.x * 9000 + this.recoil.x * 1500 : 0,
      shadowY: scoped ? this.lookDelta.y * 900 + this.sway.y * 9000 - this.recoil.y * 2500 : 0,
      spread: Math.round(Math.max(8, cone * pxPerMil * 1000 + this.recoil.y * 600)),
      hitAge: Math.min(this.hitAge, 1),
      hitKill: this.hitKill,
      damageFlash: this.damageFlash,
      damageAngle: this.damageAngle,
      feed: this.feed,
      holdovers: this.holdovers,
      zeroRange: this.zeroRange,
      windSpeed: this.wind.length(),
      crossWind: cross,
      windHold: Math.abs(cross) * this.driftPerWind,
      crouched: this.crouching,
      hostiles: this.npcs.filter((n) => n.isAlive).length,
      rarity: w.rarity,
      slots: this.slots.map((s) => (s ? { short: s.spec.short, rarity: s.rarity, ammo: s.ammo } : null)),
      currentSlot: this.current,
      pickupPrompt: this.nearPickup ? this.nearPickup.weapon.spec.name : null,
      pickupRarity: this.nearPickup ? this.nearPickup.weapon.rarity : 0,
      mapX: this.position.x,
      mapZ: this.position.z,
      mapYaw: this.yaw,
      blips,
      perf: this.perfText,
    };
  }

  /** Effective vertical field of view, for sizing particles. */
  get effectiveFOV() {
    return (2 * Math.atan(Math.tan((this.baseFOV * Math.PI) / 360) / this.camera.zoom) * 180) / Math.PI;
  }

  // MARK: Debug (used from the browser console and the automated checks)

  debug = {
    giveAll: () => {
      this.slots = [new Weapon(WeaponKind.pistol, Rarity.uncommon), new Weapon(WeaponKind.smg, Rarity.rare), new Weapon(WeaponKind.assaultRifle, Rarity.epic), new Weapon(WeaponKind.shotgun, Rarity.legendary), new Weapon(WeaponKind.sniper, Rarity.rare)];
      this.equip(this.current, false);
    },
    select: (slot: number) => this.equip(slot, false),
    look: (yaw: number, pitch: number) => { this.yaw = yaw; this.pitch = pitch; },
    pose: () => ({ position: this.position.toArray(), yaw: this.yaw, pitch: this.pitch, mode: this.mode, health: this.health }),
    teleport: (x: number, z: number) => {
      const y = this.world.groundHeight(x, z, 90, 140);
      if (y !== null) this.position.set(x, y, z);
    },
    /** Stands the player `distance` m from cover site `index`, looking at it. */
    viewCover: (index: number, distance = 9) => {
      const sites = this.world.coverSites;
      const c = sites[index % sites.length];
      const away = c.length() > 1 ? c.clone().normalize().negate() : new THREE.Vector2(0, 1);
      const p = c.clone().addScaledVector(away, distance);
      const y = this.world.groundHeight(p.x, p.y, 90, 140);
      if (y === null) return;
      this.position.set(p.x, y, p.y);
      const to = c.clone().sub(p);
      this.yaw = Math.atan2(-to.x, -to.y);
      this.pitch = -0.12;
    },
    /** Puts the nearest hostile `distance` m ahead, facing the player, and looks at his chest. */
    stage: (distance: number) => {
      const forward = V(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
      const p = this.position.clone().addScaledVector(forward, distance);
      const y = this.world.groundHeight(p.x, p.z, this.position.y + 20, 60);
      const alive = this.npcs.filter((n) => n.isAlive);
      if (y === null || !alive.length) return null;
      alive.sort((a, b) => a.position.distanceTo(p) - b.position.distanceTo(p));
      const npc = alive[0];
      npc.position.set(p.x, y, p.z);
      npc.standDown();
      (npc as unknown as { timer: number }).timer = 999;
      npc.update(0.016, this);
      const to = npc.chest.sub(this.playerEye);
      this.pitch = Math.atan2(to.y, Math.hypot(to.x, to.z));
      return npc;
    },
    /** Hostiles stop shooting (for screenshots and tests). */
    peace: () => { for (const n of this.npcs) (n as unknown as { fireTimer: number }).fireTimer = 1e9; },
    stats: () => ({ npcs: this.npcs.length, pickups: this.pickups.length, cover: this.world.coverSites.length, bullets: this.bullets.length }),
    weaponNames: () => RIFLE_OPTICS,
  };
}
