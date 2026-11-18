import * as THREE from "three";
import { CollisionMesh, CollisionWorld } from "./collision";
import { envTexture, layout, model, prototype, skyTexture } from "./assets";
import { setupCover } from "./cover";

export interface RayHit {
  position: THREE.Vector3;
  normal: THREE.Vector3;
  /** What was hit: "terrain", "buildings", a prop name, "sandbags" or "tree". */
  tag: string;
  distance: number;
}

/** The static environment: sky, sun, terrain, buildings, props from the Blender layout, and cover. */
export class World {
  readonly scene = new THREE.Scene();
  readonly staticRoot = new THREE.Group();
  readonly sun = new THREE.DirectionalLight(0xffffff, 3.1);
  readonly collision = new CollisionWorld();
  /** Unit vector from the ground toward the sun. */
  static readonly sunDirection = new THREE.Vector3(0.718, 0.383, 0.581).normalize();
  /** Half the side of the square the minimap image covers, centred on the origin. */
  static readonly mapHalfSize = 215;

  private propMeshes = new Map<string, CollisionMesh | null>();
  private treeLevels = new Map<string, THREE.Object3D[]>();
  /** Ground positions (x, z) of everything placed so far, so new cover keeps clear of it. */
  readonly occupied: THREE.Vector2[] = [];
  coverSites: THREE.Vector2[] = [];
  private readonly fog = new THREE.Fog(new THREE.Color().setRGB(0.72, 0.78, 0.84, THREE.SRGBColorSpace), 120, 1500);

  constructor() {
    this.staticRoot.name = "static";
    this.scene.add(this.staticRoot);
    this.staticRoot.matrixAutoUpdate = false;
    this.setupSky();
    this.setupTerrain();
    this.setupProps();
    setupCover(this);
    // Static geometry never moves: compute its matrices once.
    this.staticRoot.updateMatrixWorld(true);
    this.staticRoot.traverse((o) => {
      if (o !== this.staticRoot && !(o as THREE.LOD).isLOD) o.matrixAutoUpdate = false;
    });
  }

  // MARK: Sky and light

  private setupSky() {
    this.scene.background = skyTexture;
    this.scene.environment = envTexture;
    // Turn the panorama so the sun in the picture sits where the shadows say it is.
    this.scene.backgroundRotation.set(0, SKY_TURN, 0);
    this.scene.environmentRotation.set(0, SKY_TURN, 0);
    this.scene.environmentIntensity = 1.0;
    this.scene.backgroundIntensity = 1.0;
    this.scene.fog = this.fog;

    this.sun.color.setRGB(1.0, 0.9, 0.8, THREE.SRGBColorSpace);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(4096, 4096);
    s.bias = -0.0004;
    s.normalBias = 0.04;
    s.radius = 2.5;
    const cam = s.camera;
    cam.left = -SHADOW_HALF;
    cam.right = SHADOW_HALF;
    cam.top = SHADOW_HALF;
    cam.bottom = -SHADOW_HALF;
    cam.near = 1;
    cam.far = 800;
    this.scene.add(this.sun, this.sun.target);
  }

  setShadowMapSize(size: number) {
    const s = this.sun.shadow;
    if (s.mapSize.x === size) return;
    s.mapSize.set(size, size);
    s.map?.dispose();
    s.map = null;
  }

  /** Keeps the shadow box centred on the player, snapped to whole texels so edges don't crawl. */
  followShadow(center: THREE.Vector3) {
    const texel = (2 * SHADOW_HALF) / this.sun.shadow.mapSize.x;
    const z = World.sunDirection;
    const x = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), z).normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const cx = Math.round(center.dot(x) / texel) * texel;
    const cy = Math.round(center.dot(y) / texel) * texel;
    const cz = center.dot(z);
    const snapped = x.multiplyScalar(cx).addScaledVector(y, cy).addScaledVector(z, cz);
    this.sun.target.position.copy(snapped);
    this.sun.position.copy(snapped).addScaledVector(World.sunDirection, 400);
    this.sun.target.updateMatrixWorld();
  }

  /** Renders the map from straight above once, for the minimap. North (-Z) is up, +X is right. */
  renderMapImage(renderer: THREE.WebGLRenderer, pixels = 1024): HTMLCanvasElement {
    const h = World.mapHalfSize;
    const cam = new THREE.OrthographicCamera(-h, h, h, -h, 1, 400);
    cam.position.set(0, 160, 0);
    cam.up.set(0, 0, -1);
    cam.lookAt(0, 0, 0);
    const size = renderer.getSize(new THREE.Vector2());
    const ratio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(pixels, pixels, false);
    // Fog is tuned for eye level and would wash out the whole map from above.
    this.scene.fog = null;
    const exposure = renderer.toneMappingExposure;
    renderer.toneMappingExposure = exposure * 0.85;
    this.followShadow(new THREE.Vector3());
    renderer.render(this.scene, cam);
    const out = document.createElement("canvas");
    out.width = out.height = pixels;
    out.getContext("2d")!.drawImage(renderer.domElement, 0, 0, pixels, pixels);
    this.scene.fog = this.fog;
    renderer.toneMappingExposure = exposure;
    renderer.setPixelRatio(ratio);
    renderer.setSize(size.x, size.y, false);
    return out;
  }

  // MARK: Terrain and buildings

  private setupTerrain() {
    const terrain = model("terrain");
    terrain.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      const m = (mesh.material as THREE.MeshStandardMaterial).clone();
      m.onBeforeCompile = terrainShader;
      m.customProgramCacheKey = () => "terrain";
      mesh.material = m;
    });
    this.staticRoot.add(terrain);
    this.addCollision(terrain, "terrain");

    const buildings = model("buildings");
    this.staticRoot.add(buildings);
    this.addCollision(buildings, "buildings");
  }

  private addCollision(root: THREE.Object3D, tag: string) {
    const mesh = CollisionMesh.from(root);
    if (mesh) this.collision.add(mesh, root.matrixWorld.clone(), tag);
  }

  // MARK: Props

  private setupProps() {
    for (const item of layout) {
      this.placeProp(item.m, new THREE.Vector3(item.p[0], item.p[1], item.p[2]), item.r, item.s);
    }
  }

  /** Adds one copy of a prop model to the level, with collision. Trees block only at the trunk. */
  placeProp(name: string, position: THREE.Vector3, yaw: number, scale: number, tilt = new THREE.Vector3()): THREE.Object3D {
    const isTree = name.startsWith("tree");
    let node: THREE.Object3D;
    if (isTree) {
      const levels = this.treeLevelsFor(name);
      const lod = new THREE.LOD();
      lod.addLevel(levels[0].clone(), 0);
      lod.addLevel(levels[1].clone(), 22);
      lod.addLevel(levels[2].clone(), 70);
      node = lod;
    } else {
      node = model(name);
      if (!this.propMeshes.has(name)) this.propMeshes.set(name, CollisionMesh.from(prototype(name)));
    }
    node.name = name;
    node.position.copy(position);
    node.quaternion
      .setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw)
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), tilt.x))
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), tilt.z));
    node.scale.setScalar(scale);
    this.staticRoot.add(node);
    node.updateMatrixWorld(true);
    this.occupied.push(new THREE.Vector2(position.x, position.z));
    if (isTree) {
      // Bullets pass through foliage; only the trunk blocks.
      this.collision.addTrunk(position.x, position.z, 0.16 * scale, position.y - 0.5, position.y + 3.2 * scale);
    } else {
      const mesh = this.propMeshes.get(name);
      if (mesh) this.collision.add(mesh, node.matrixWorld.clone(), name);
    }
    return node;
  }

  /**
   * Each tree is ~130k alpha-tested, double-sided triangles. Distant trees use thinned copies of the
   * same mesh: one triangle pair in every few (leaf cards are quads), sharing the vertex buffers.
   */
  private treeLevelsFor(name: string): THREE.Object3D[] {
    const cached = this.treeLevels.get(name);
    if (cached) return cached;
    const full = prototype(name);
    const levels: THREE.Object3D[] = [full];
    for (const level of [0, 1]) {
      const copy = full.clone(true);
      copy.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const mat = mesh.material as THREE.Material;
        const leaves = mat.name.toLowerCase().includes("leaves");
        const keep = leaves ? [3, 9][level] : [2, 5][level];
        mesh.geometry = thinned(mesh.geometry, keep);
        // Thinned distant leaves don't need to cast shadows at full cost.
        if (level === 1) mesh.castShadow = !leaves;
      });
      levels.push(copy);
    }
    this.treeLevels.set(name, levels);
    return levels;
  }

  // MARK: Queries

  /** Closest hit against the static world along a segment. */
  raycast(a: THREE.Vector3, b: THREE.Vector3, only?: string): RayHit | null {
    const h = this.collision.raycast(a, b, only);
    if (!h) return null;
    const position = a.clone().lerp(b, h.t);
    return { position, normal: h.normal, tag: h.tag, distance: a.distanceTo(position) };
  }

  /** Height of the walkable surface under a point, searching downward from `fromY`. */
  groundHeight(x: number, z: number, fromY: number, depth = 60): number | null {
    const h = this.collision.raycast(_from.set(x, fromY, z), _to.set(x, fromY - depth, z));
    return h ? fromY - depth * h.t : null;
  }

  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    return this.collision.raycast(a, b) === null;
  }
}

const _from = new THREE.Vector3();
const _to = new THREE.Vector3();
const SHADOW_HALF = 85;
/**
 * Panorama yaw. Under Three's equirect convention the sun in sky_light.hdr (u 0.60, 22.6° up)
 * already lies along sunDirection, so no turn is needed (SceneKit's convention needed π).
 */
const SKY_TURN = 0;

function thinned(g: THREE.BufferGeometry, keepEvery: number): THREE.BufferGeometry {
  const index = g.getIndex();
  if (!index) return g;
  const src = index.array;
  const tris = src.length / 3;
  const out: number[] = [];
  for (let t = 0; t < tris; t++) {
    if (Math.floor(t / 2) % keepEvery !== 0) continue;
    out.push(src[t * 3], src[t * 3 + 1], src[t * 3 + 2]);
  }
  const copy = new THREE.BufferGeometry();
  for (const [name, attr] of Object.entries(g.attributes)) copy.setAttribute(name, attr);
  copy.setIndex(out);
  copy.boundingSphere = g.boundingSphere;
  copy.boundingBox = g.boundingBox;
  return copy;
}

/** Breaks up the 2.5 m texture tiling with large-scale tint and brightness variation (as on macOS). */
function terrainShader(shader: THREE.WebGLProgramParametersWithUniforms) {
  shader.vertexShader = shader.vertexShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vTerrainWorld;")
    .replace(
      "#include <worldpos_vertex>",
      "#include <worldpos_vertex>\nvTerrainWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;",
    );
  shader.fragmentShader = shader.fragmentShader
    .replace("#include <common>", "#include <common>\nvarying vec3 vTerrainWorld;")
    .replace(
      "#include <map_fragment>",
      /* glsl */ `#include <map_fragment>
      {
        vec2 p = vTerrainWorld.xz;
        float n1 = sin(p.x * 0.071 + sin(p.y * 0.053) * 2.0) * cos(p.y * 0.067 + sin(p.x * 0.047) * 2.0);
        float n2 = sin(p.x * 0.013 + 1.7) * cos(p.y * 0.017 + sin(p.x * 0.009) * 3.0);
        float n3 = sin(p.x * 0.31 + sin(p.y * 0.27) * 1.5) * cos(p.y * 0.29);
        float dist = length(vViewPosition);
        vec3 base = mix(diffuseColor.rgb, vec3(0.1542, 0.1173, 0.0474), smoothstep(35.0, 220.0, dist) * 0.72);
        vec3 c = base * (1.0 + 0.17 * n1 + 0.20 * n2 + 0.06 * n3);
        // Sun-bleached dry grass, matched to the field in the sky panorama.
        float lum = dot(c, vec3(0.3, 0.6, 0.1));
        c = mix(c, vec3(lum) * vec3(1.18, 1.05, 0.76), 0.38) * 1.9;
        c = mix(c, c * vec3(1.08, 1.0, 0.84), clamp(n2 * 0.5 + 0.5, 0.0, 1.0));
        diffuseColor.rgb = c;
      }`,
    );
}
