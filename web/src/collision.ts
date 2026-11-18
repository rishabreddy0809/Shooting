import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";

/**
 * The static level as ray-cast geometry: unique meshes placed by transform, plus tree trunks as
 * cylinders. Rays walk a tree of instance bounds first, so each query visits only nearby objects.
 */
export interface Hit {
  /** Fraction along the segment, 0…1. */
  t: number;
  /** Unit normal facing back along the ray. */
  normal: THREE.Vector3;
  tag: string;
}

export class CollisionMesh {
  readonly bvh: MeshBVH;
  readonly geometry: THREE.BufferGeometry;
  readonly box: THREE.Box3;
  constructor(geometry: THREE.BufferGeometry) {
    this.geometry = geometry;
    this.bvh = new MeshBVH(geometry, { maxLeafSize: 8 });
    geometry.computeBoundingBox();
    this.box = geometry.boundingBox!.clone();
  }

  /** Merges every mesh under `root` into one geometry in `root`'s own space (positions only). */
  static from(root: THREE.Object3D): CollisionMesh | null {
    const positions: number[] = [];
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    const m = new THREE.Matrix4();
    const v = new THREE.Vector3();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const g = mesh.geometry;
      const pos = g.getAttribute("position");
      m.multiplyMatrices(inv, mesh.matrixWorld);
      const index = g.getIndex();
      const count = index ? index.count : pos.count;
      for (let i = 0; i < count; i++) {
        const k = index ? index.getX(i) : i;
        v.fromBufferAttribute(pos, k).applyMatrix4(m);
        positions.push(v.x, v.y, v.z);
      }
    });
    if (!positions.length) return null;
    return CollisionMesh.fromTriangles(positions);
  }

  /** Flat triangle soup: x,y,z per corner, three corners per triangle. */
  static fromTriangles(positions: number[]): CollisionMesh {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    const idx = new Uint32Array(positions.length / 3);
    for (let i = 0; i < idx.length; i++) idx[i] = i;
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    return new CollisionMesh(g);
  }
}

interface Instance {
  mesh: CollisionMesh;
  toLocal: THREE.Matrix4;
  toWorld: THREE.Matrix4;
  normalToWorld: THREE.Matrix3;
  box: THREE.Box3;
  tag: string;
}

interface Trunk {
  x: number; z: number; r: number; y0: number; y1: number;
}

interface TopNode {
  box: THREE.Box3;
  /** Leaf: first entry in `order`. Inner: left child (right child follows). */
  first: number;
  count: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _hitPoint = new THREE.Vector3();
const _localRay = new THREE.Ray();
const _stack: number[] = [];

export class CollisionWorld {
  private instances: Instance[] = [];
  private trunks: Trunk[] = [];
  private nodes: TopNode[] = [];
  private order: number[] = [];
  private dirty = true;

  add(mesh: CollisionMesh, transform: THREE.Matrix4, tag: string) {
    const box = mesh.box.clone().applyMatrix4(transform);
    const toLocal = transform.clone().invert();
    const normalToWorld = new THREE.Matrix3().getNormalMatrix(transform);
    this.instances.push({ mesh, toLocal, toWorld: transform.clone(), normalToWorld, box, tag });
    this.dirty = true;
  }

  addTrunk(x: number, z: number, radius: number, y0: number, y1: number) {
    this.trunks.push({ x, z, r: radius, y0, y1 });
  }

  private build() {
    this.dirty = false;
    const inst = this.instances;
    this.order = inst.map((_, i) => i);
    this.nodes = [{ box: new THREE.Box3(), first: 0, count: 0 }];
    if (!inst.length) return;
    const work: [number, number, number][] = [[0, 0, inst.length]];
    while (work.length) {
      const [ni, s, e] = work.pop()!;
      const box = new THREE.Box3();
      for (let k = s; k < e; k++) box.union(inst[this.order[k]].box);
      this.nodes[ni].box = box;
      if (e - s <= 2) {
        this.nodes[ni].first = s;
        this.nodes[ni].count = e - s;
        continue;
      }
      const size = box.getSize(new THREE.Vector3());
      const axis = size.x > size.z ? "x" : "z";
      const centre = (i: number) => (inst[i].box.min[axis] + inst[i].box.max[axis]) * 0.5;
      const slice = this.order.slice(s, e).sort((p, q) => centre(p) - centre(q));
      for (let k = 0; k < slice.length; k++) this.order[s + k] = slice[k];
      const mid = (s + e) >> 1;
      const left = this.nodes.length;
      this.nodes.push({ box: new THREE.Box3(), first: 0, count: 0 }, { box: new THREE.Box3(), first: 0, count: 0 });
      this.nodes[ni].first = left;
      this.nodes[ni].count = 0;
      work.push([left, s, mid], [left + 1, mid, e]);
    }
  }

  /** Nearest hit on the segment a→b. `only` restricts the test to geometry with that tag. */
  raycast(a: THREE.Vector3, b: THREE.Vector3, only?: string): Hit | null {
    if (this.dirty) this.build();
    const d = _d.subVectors(b, a);
    const length = d.length();
    if (length < 1e-6) return null;
    let best = 1;
    let tag = "";
    const normal = new THREE.Vector3();
    const dir = _dir.copy(d).divideScalar(length);
    const stack = _stack;
    stack.length = 0;
    stack.push(0);
    while (stack.length) {
      const node = this.nodes[stack.pop()!];
      if (!segmentHitsBox(a, dir, best * length, node.box)) continue;
      if (node.count > 0) {
        for (let k = node.first; k < node.first + node.count; k++) {
          const inst = this.instances[this.order[k]];
          if (only && inst.tag !== only) continue;
          if (!segmentHitsBox(a, dir, best * length, inst.box)) continue;
          // Into the instance's own space; its scale is uniform, so distances scale by one factor.
          _a.copy(a).applyMatrix4(inst.toLocal);
          _b.copy(a).addScaledVector(dir, best * length).applyMatrix4(inst.toLocal);
          const localLen = _a.distanceTo(_b);
          if (localLen < 1e-6) continue;
          _localRay.origin.copy(_a);
          _localRay.direction.copy(_b).sub(_a).divideScalar(localLen);
          const h = inst.mesh.bvh.raycastFirst(_localRay, THREE.DoubleSide, 0, localLen);
          if (h && h.face) {
            _hitPoint.copy(h.point).applyMatrix4(inst.toWorld);
            const t = _hitPoint.distanceTo(a) / length;
            if (t < best) {
              best = t;
              tag = inst.tag;
              normal.copy(h.face.normal).applyMatrix3(inst.normalToWorld);
            }
          }
        }
      } else {
        stack.push(node.first, node.first + 1);
      }
    }
    // Trunks: vertical cylinders, tested in the ground plane.
    if (!only || only === "tree") {
      const dx = d.x, dz = d.z;
      const qa = dx * dx + dz * dz;
      if (qa > 1e-9) {
        for (const tr of this.trunks) {
          const ox = a.x - tr.x, oz = a.z - tr.z;
          const qb = ox * dx + oz * dz;
          const qc = ox * ox + oz * oz - tr.r * tr.r;
          const disc = qb * qb - qa * qc;
          if (disc < 0) continue;
          const t = (-qb - Math.sqrt(disc)) / qa;
          if (t <= 0 || t >= best) continue;
          const y = a.y + d.y * t;
          if (y < tr.y0 || y > tr.y1) continue;
          best = t;
          tag = "tree";
          normal.set(ox + dx * t, 0, oz + dz * t);
        }
      }
    }
    if (!tag) return null;
    normal.normalize();
    if (normal.dot(d) > 0) normal.negate();
    return { t: best, normal, tag };
  }
}

/** Does the segment (origin, unit dir, length) touch the box? */
function segmentHitsBox(o: THREE.Vector3, dir: THREE.Vector3, len: number, box: THREE.Box3): boolean {
  let tmin = 0, tmax = len;
  for (const ax of ["x", "y", "z"] as const) {
    const d = dir[ax];
    const lo = box.min[ax], hi = box.max[ax], p = o[ax];
    if (Math.abs(d) < 1e-12) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let t1 = (lo - p) / d, t2 = (hi - p) / d;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}
