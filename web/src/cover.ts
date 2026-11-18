import * as THREE from "three";
import { CollisionMesh } from "./collision";
import { SeededRandom } from "./util";
import type { World } from "./world";

/**
 * Extra hiding spots scattered over the open ground, thickest toward the far desert edges:
 * rock outcrops, sandbag fighting positions, barricade lines and large rock formations.
 * Placement is seeded, so the map is the same every run (and on the minimap).
 */
export function setupCover(world: World) {
  const g = new Ground(world);
  const rng = new SeededRandom(0x5eedc0de2026n);
  const existing = world.occupied.slice();
  const sites: THREE.Vector2[] = [];
  const cell = 16;
  for (let gz = -200; gz <= 200; gz += cell) {
    for (let gx = -200; gx <= 200; gx += cell) {
      const x = gx + rng.range(-5.5, 5.5), z = gz + rng.range(-5.5, 5.5);
      const edge = Math.hypot(x, z);
      // Open ground toward the edge of the (circular, r = 202 m) play area gets the most.
      const t = Math.max(0, Math.min(1, (edge - 60) / 100));
      const chance = 0.14 + 0.62 * t * t * (3 - 2 * t);
      const roll = rng.next(), kind = rng.next(), yaw = rng.range(0, 2 * Math.PI);
      if (!(roll < chance && edge < 195)) continue;
      const p = new THREE.Vector2(x, z);
      if (existing.some((e) => e.distanceTo(p) < 12) || sites.some((s) => s.distanceTo(p) < 15)) continue;
      const ground = g.flat(x, z, 3.5);
      if (!ground) continue;
      sites.push(p);
      const site = rng.fork(sites.length);
      if (kind < 0.3) rockOutcrop(world, g, ground, yaw, site);
      else if (kind < 0.55) sandbagNest(world, g, ground, yaw, site);
      else if (kind < 0.8) barricade(world, g, ground, yaw, site);
      else if (edge > 110) rockFormation(world, g, ground, yaw, site);
      else rockOutcrop(world, g, ground, yaw, site);
    }
  }
  world.coverSites = sites;
}

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

// MARK: Site kinds

function rockOutcrop(world: World, g: Ground, c: THREE.Vector3, yaw: number, rng: SeededRandom) {
  const big = rng.range(1.5, 2.3);
  const y0 = g.height(c.x, c.z);
  if (y0 !== null) {
    world.placeProp("boulder_a", V(c.x, y0 - 0.2 * big, c.z), yaw, big, V(rng.range(-0.12, 0.12), 0, rng.range(-0.12, 0.12)));
  }
  const extra = 1 + Math.floor(rng.next() * 3);
  for (let i = 0; i < extra; i++) {
    const a = yaw + i * 2.1 + rng.range(-0.5, 0.5);
    const r = (rng.range(2.4, 3.6) * big) / 1.8;
    const x = c.x + Math.cos(a) * r, z = c.z + Math.sin(a) * r;
    const s = rng.range(1.1, 2.0);
    const y = g.height(x, z);
    if (y === null) continue;
    world.placeProp("boulder_b", V(x, y - 0.15 * s, z), rng.range(0, 6.28), s, V(rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2)));
  }
}

function rockFormation(world: World, g: Ground, c: THREE.Vector3, yaw: number, rng: SeededRandom) {
  // A house-sized rock with smaller blocks shed along one side: full standing cover.
  const big = rng.range(2.8, 3.6);
  const y0 = g.lowest(c, 1.5 * big);
  if (y0 !== null) {
    world.placeProp("boulder_a", V(c.x, y0 - 0.22 * big, c.z), yaw, big, V(rng.range(-0.1, 0.1), 0, rng.range(-0.1, 0.1)));
  }
  const dir = V(Math.cos(yaw), 0, -Math.sin(yaw));
  const side = V(-dir.z, 0, dir.x);
  for (let i = 0; i < 3; i++) {
    const sgn = i === 1 ? -1 : 1;
    const along = (sgn * rng.range(2.6, 3.4) * big) / 2.4 + (i === 2 ? 1.6 : 0);
    const p = c.clone().addScaledVector(dir, along).addScaledVector(side, rng.range(-1.2, 1.2));
    const bs = i === 2 ? rng.range(1.2, 1.8) : rng.range(1.7, 2.4);
    const gy = g.height(p.x, p.z);
    if (gy === null) continue;
    world.placeProp(i === 2 ? "boulder_b" : "boulder_a", V(p.x, gy - 0.2 * bs, p.z), rng.range(0, 6.28), bs,
      V(rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15)));
  }
}

function barricade(world: World, g: Ground, c: THREE.Vector3, yaw: number, rng: SeededRandom) {
  const dir = V(Math.cos(yaw), 0, -Math.sin(yaw));
  const side = V(-dir.z, 0, dir.x);
  // Concrete barriers end to end, with a sandbag wall stacked up behind for standing cover.
  const count = 2 + Math.floor(rng.next() * 2);
  for (let i = 0; i < count; i++) {
    const off = (i - (count - 1) / 2) * 1.58;
    const p = c.clone().addScaledVector(dir, off).addScaledVector(side, rng.range(-0.06, 0.06));
    const y = g.height(p.x, p.z);
    if (y === null) continue;
    world.placeProp("barrier", V(p.x, y - 0.03, p.z), yaw + rng.range(-0.05, 0.05), 1);
  }
  const length = count * 1.4;
  const behind = c.clone().addScaledVector(side, -0.75);
  const path: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i <= 12; i++) {
    const u = i / 12 - 0.5;
    path.push([behind.clone().addScaledVector(dir, u * length), dir.clone()]);
  }
  addSandbags(world, g, path, 8, rng);
  if (rng.next() < 0.6) {
    const p = c.clone().addScaledVector(dir, length * 0.5 + 1.2).addScaledVector(side, -rng.range(0, 1));
    const y = g.height(p.x, p.z);
    if (y !== null) world.placeProp("log", V(p.x, y + 0.1, p.z), yaw + rng.range(1.2, 1.9), 1.2);
  }
}

/** A horseshoe fighting position: a sandbag ring open at the back, sometimes with a barrel inside. */
function sandbagNest(world: World, g: Ground, c: THREE.Vector3, yaw: number, rng: SeededRandom) {
  const radius = rng.range(1.8, 2.4);
  const span = rng.range(1.15, 1.45) * Math.PI;
  const steps = 24;
  const path: [THREE.Vector3, THREE.Vector3][] = [];
  for (let i = 0; i <= steps; i++) {
    const a = yaw - span / 2 + (span * i) / steps;
    path.push([c.clone().add(V(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(radius)), V(-Math.sin(a), 0, -Math.cos(a))]);
  }
  addSandbags(world, g, path, 8 + Math.floor(rng.next() * 2), rng);
  if (rng.next() < 0.55) {
    const a = yaw + Math.PI + rng.range(-0.5, 0.5);
    const p = c.clone().add(V(Math.cos(a), 0, -Math.sin(a)).multiplyScalar(radius * 0.55));
    const y = g.height(p.x, p.z);
    if (y !== null) world.placeProp(rng.next() < 0.5 ? "barrel_blue" : "barrel_red", V(p.x, y, p.z), rng.range(0, 6.28), 1);
  }
}

// MARK: Ground queries

class Ground {
  constructor(private world: World) {}

  height(x: number, z: number): number | null {
    const h = this.world.collision.raycast(V(x, 90, z), V(x, -40, z), "terrain");
    return h ? 90 - 130 * h.t : null;
  }

  /** Ground at the centre if the area around it is fairly level and nothing is built there. */
  flat(x: number, z: number, radius: number): THREE.Vector3 | null {
    const hit = this.world.collision.raycast(V(x, 90, z), V(x, -40, z));
    if (!hit || hit.tag !== "terrain" || hit.normal.y <= 0.93) return null;
    const y = 90 - 130 * hit.t;
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3;
      const h = this.height(x + Math.cos(a) * radius, z + Math.sin(a) * radius);
      if (h === null || Math.abs(h - y) >= 1.1) return null;
    }
    return V(x, y, z);
  }

  lowest(c: THREE.Vector3, radius: number): number | null {
    let low = c.y;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const h = this.height(c.x + Math.cos(a) * radius, c.z + Math.sin(a) * radius);
      if (h === null) return null;
      low = Math.min(low, h);
    }
    return low;
  }
}

// MARK: Sandbags

/**
 * Stacks bags in running bond along a path of (point, direction) samples, following the ground.
 * The whole wall is one mesh: one draw call and one ray-cast tree of simple boxes.
 */
function addSandbags(world: World, g: Ground, path: [THREE.Vector3, THREE.Vector3][], rows: number, rng: SeededRandom) {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) lengths.push(lengths[i - 1] + path[i][0].distanceTo(path[i - 1][0]));
  const total = lengths[lengths.length - 1];
  if (total <= 0.5) return;
  const sample = (s: number): [THREE.Vector3, THREE.Vector3] => {
    let i = 1;
    while (i < path.length - 1 && lengths[i] < s) i++;
    const seg = Math.max(1e-4, lengths[i] - lengths[i - 1]);
    const u = Math.max(0, Math.min(1, (s - lengths[i - 1]) / seg));
    const p = path[i - 1][0].clone().lerp(path[i][0], u);
    const d = path[i - 1][1].clone().lerp(path[i][1], u).normalize();
    return [p, d];
  };

  const bagLength = 0.6, spacing = 0.47, rise = 0.114;
  const buf: Buffers = { positions: [], normals: [], uvs: [], colors: [], indices: [] };
  const boxes: number[] = [];
  const up = V(0, 1, 0), xAxis = V(1, 0, 0);

  for (let row = 0; row < rows; row++) {
    const offset = row % 2 === 0 ? 0 : spacing / 2;
    let s = offset + spacing / 2;
    while (s < total - spacing * 0.3) {
      const [p, dir] = sample(s);
      s += spacing;
      const ground = g.height(p.x, p.z);
      if (ground === null) continue;
      const side = V(-dir.z, 0, dir.x);
      // Upper rows step back slightly, like a real battered wall.
      const centre = V(p.x, 0, p.z).addScaledVector(side, row * 0.012).add(V(0, ground - 0.02 + 0.07 + row * rise, 0));
      const yaw = Math.atan2(-dir.z, dir.x) + rng.range(-0.09, 0.09);
      const length = bagLength * rng.range(0.94, 1.06), width = rng.range(0.33, 0.37);
      const height = rng.range(0.14, 0.16), squash = rng.range(0, 1);
      const seed = Math.floor(rng.next() * 1e6);
      const shade = rng.range(0.82, 1.08);
      const tint: [number, number, number] = [shade, shade * rng.range(0.97, 1.0), shade * rng.range(0.92, 1.0)];
      const rot = new THREE.Quaternion().setFromAxisAngle(up, yaw).multiply(new THREE.Quaternion().setFromAxisAngle(xAxis, rng.range(-0.04, 0.04)));
      const uvOffset: [number, number] = [rng.next(), rng.next()];
      appendBag(buf, { length, width, height, squash, seed }, centre, rot, tint, uvOffset);
      // Collision uses a plain box per bag: a fraction of the triangles, and as solid to a bullet.
      appendBox(boxes, centre, rot, V(length * 0.47, height * 0.5, width * 0.5));
    }
  }
  if (!buf.indices.length) return;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(buf.positions, 3));
  geo.setAttribute("normal", new THREE.Float32BufferAttribute(buf.normals, 3));
  geo.setAttribute("uv", new THREE.Float32BufferAttribute(buf.uvs, 2));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(buf.colors, 3));
  geo.setIndex(buf.indices);
  geo.computeBoundingSphere();
  const mesh = new THREE.Mesh(geo, sandbagMaterial());
  mesh.name = "sandbags";
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  world.staticRoot.add(mesh);
  world.collision.add(CollisionMesh.fromTriangles(boxes), new THREE.Matrix4(), "sandbags");
}

function appendBox(out: number[], centre: THREE.Vector3, rotation: THREE.Quaternion, half: THREE.Vector3) {
  const corner = (i: number) =>
    V(i & 1 ? half.x : -half.x, i & 2 ? half.y : -half.y, i & 4 ? half.z : -half.z).applyQuaternion(rotation).add(centre);
  const faces = [[0, 1, 3, 2], [4, 6, 7, 5], [0, 4, 5, 1], [2, 3, 7, 6], [0, 2, 6, 4], [1, 5, 7, 3]];
  for (const [a, b, c, d] of faces) {
    for (const k of [a, b, c, a, c, d]) {
      const v = corner(k);
      out.push(v.x, v.y, v.z);
    }
  }
}

interface Buffers {
  positions: number[];
  normals: number[];
  uvs: number[];
  colors: number[];
  indices: number[];
}

interface BagShape {
  length: number;
  width: number;
  height: number;
  /** 0 = plump, 1 = slumped flatter and wider. */
  squash: number;
  seed: number;
}

const NU = 11, NV = 10;

/** One filled bag: a pillow with a flat bottom, a rounded top and pinched, tied-off ends. */
function appendBag(buf: Buffers, shape: BagShape, centre: THREE.Vector3, rotation: THREE.Quaternion, tint: [number, number, number], uvOffset: [number, number]) {
  const base = buf.positions.length / 3;
  const local: THREE.Vector3[] = new Array(NU * NV);
  const h = shape.height * (1 - 0.18 * shape.squash), w = shape.width * (1 + 0.12 * shape.squash);
  const lumps = new SeededRandom(shape.seed | 1);
  const lumpA = lumps.range(-0.012, 0.012), lumpB = lumps.range(0, 6.28);
  const signPow = (v: number, e: number) => Math.sign(v) * Math.pow(Math.abs(v), e);
  for (let i = 0; i < NU; i++) {
    const u = i / (NU - 1);
    const e = Math.abs(2 * u - 1);
    // Full section through the middle, gathered to a tie at each end.
    const gather = Math.pow(Math.max(0, 1 - Math.pow(e, 7)), 0.35);
    for (let j = 0; j < NV; j++) {
      const a = (2 * Math.PI * j) / NV;
      const c = Math.cos(a), s = Math.sin(a);
      // Rounded-box section: boxy sides, softer top.
      let z = (w / 2) * signPow(c, 0.55) * gather;
      let y = (h / 2) * signPow(s, 0.7) * gather;
      // Weight settles the bag onto whatever is below it.
      y = Math.max(y, -h * 0.36 * gather);
      if (s > 0) y += lumpA * Math.sin(3 * Math.PI * u + lumpB) * gather;
      z *= 1 + 0.06 * Math.max(0, -s);
      local[i * NV + j] = V((u - 0.5) * shape.length, y, z);
    }
  }
  const du = new THREE.Vector3(), dv = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) {
      const p = local[i * NV + j];
      du.subVectors(local[Math.min(NU - 1, i + 1) * NV + j], local[Math.max(0, i - 1) * NV + j]);
      dv.subVectors(local[i * NV + ((j + 1) % NV)], local[i * NV + ((j + NV - 1) % NV)]);
      n.crossVectors(dv, du);
      if (n.length() < 1e-6) n.set(i < NU / 2 ? -1 : 1, 0, 0);
      n.normalize();
      // Keep normals pointing outward.
      if (n.dot(V(p.x * 0.5, p.y, p.z)) < 0) n.negate();
      const wp = p.clone().applyQuaternion(rotation).add(centre);
      const wn = n.clone().applyQuaternion(rotation);
      buf.positions.push(wp.x, wp.y, wp.z);
      buf.normals.push(wn.x, wn.y, wn.z);
      buf.uvs.push((i / (NU - 1)) * 2.2 + uvOffset[0], (j / NV) * 1.4 + uvOffset[1]);
      buf.colors.push(tint[0], tint[1], tint[2]);
    }
  }
  for (let i = 0; i < NU - 1; i++) {
    for (let j = 0; j < NV; j++) {
      const a = base + i * NV + j, b = base + i * NV + ((j + 1) % NV);
      const c = base + (i + 1) * NV + j, d = base + (i + 1) * NV + ((j + 1) % NV);
      buf.indices.push(a, c, b, b, c, d);
    }
  }
}

let _sandbag: THREE.MeshStandardMaterial | null = null;

/** Weathered burlap: a tight weave, sun-bleached and dusty. */
function sandbagMaterial(): THREE.MeshStandardMaterial {
  if (_sandbag) return _sandbag;
  const [albedo, normal] = burlapTextures(256);
  albedo.colorSpace = THREE.SRGBColorSpace;
  for (const t of [albedo, normal]) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
  }
  _sandbag = new THREE.MeshStandardMaterial({
    map: albedo,
    normalMap: normal,
    normalScale: new THREE.Vector2(0.8, 0.8),
    roughness: 0.93,
    metalness: 0,
    vertexColors: true,
  });
  return _sandbag;
}

function burlapTextures(n: number): [THREE.DataTexture, THREE.DataTexture] {
  const rng = new SeededRandom(77);
  const height = new Float32Array(n * n);
  const blobs: [number, number, number, number][] = [];
  for (let i = 0; i < 10; i++) blobs.push([rng.range(0, 1), rng.range(0, 1), Math.round(rng.range(1, 3)), rng.range(0, 6.28)]);
  const dirt = new Float32Array(n * n);
  const period = 6;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const cx = Math.floor(x / period), cy = Math.floor(y / period);
      const warp = Math.abs(Math.sin((Math.PI * (x + 0.5)) / period));
      const weft = Math.abs(Math.sin((Math.PI * (y + 0.5)) / period));
      const over = (cx + cy) % 2 === 0;
      let h = over ? 0.55 + 0.45 * weft * (0.6 + 0.4 * warp) : 0.55 + 0.45 * warp * (0.6 + 0.4 * weft);
      h *= 0.85 + 0.3 * rng.next();
      height[y * n + x] = h;
      let d = 0;
      for (const b of blobs) d += Math.sin(2 * Math.PI * ((b[2] * x) / n + b[0]) + b[3]) * Math.sin(2 * Math.PI * ((b[2] * y) / n + b[1]));
      dirt[y * n + x] = d / blobs.length;
    }
  }
  const albedo = new Uint8Array(n * n * 4);
  const normal = new Uint8Array(n * n * 4);
  const clamp255 = (v: number) => Math.max(0, Math.min(255, v * 255));
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const h = height[i];
      const d = dirt[i] * 2.2;
      const light = 0.58 + 0.42 * h;
      albedo[i * 4] = clamp255((0.6 + 0.05 * d) * light);
      albedo[i * 4 + 1] = clamp255((0.52 + 0.04 * d) * light);
      albedo[i * 4 + 2] = clamp255((0.38 + 0.02 * d) * light);
      albedo[i * 4 + 3] = 255;
      const hx = height[y * n + ((x + 1) % n)] - height[y * n + ((x + n - 1) % n)];
      const hy = height[((y + 1) % n) * n + x] - height[((y + n - 1) % n) * n + x];
      const v = V(-hx * 2.5, -hy * 2.5, 1).normalize();
      normal[i * 4] = (v.x * 0.5 + 0.5) * 255;
      normal[i * 4 + 1] = (v.y * 0.5 + 0.5) * 255;
      normal[i * 4 + 2] = (v.z * 0.5 + 0.5) * 255;
      normal[i * 4 + 3] = 255;
    }
  }
  const make = (data: Uint8Array) => {
    const t = new THREE.DataTexture(data, n, n, THREE.RGBAFormat);
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    return t;
  };
  return [make(albedo), make(normal)];
}
