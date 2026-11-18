import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";

/** Every model the game uses, loaded once up front. */
export const MODEL_NAMES = [
  "terrain", "buildings", "tree_a", "cliff_a", "boulder_a", "boulder_b", "crate", "barrier", "log",
  "barrel_blue", "barrel_red", "npc", "rifle", "pistol", "smg", "ar", "shotgun",
] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

const base = import.meta.env.BASE_URL;
const prototypes = new Map<string, THREE.Group>();
export let skyTexture: THREE.Texture | null = null;
export let envTexture: THREE.Texture | null = null;
export let layout: { m: string; p: number[]; r: number; s: number }[] = [];

/** Loads models, sky and layout; reports progress 0…1. */
export async function loadAll(renderer: THREE.WebGLRenderer, onProgress: (f: number, what: string) => void) {
  const draco = new DRACOLoader().setDecoderPath(`${base}draco/`);
  const gltf = new GLTFLoader().setDRACOLoader(draco);
  const jobs: { label: string; run: () => Promise<void> }[] = [];
  for (const name of MODEL_NAMES) {
    jobs.push({
      label: name,
      run: async () => {
        const g = await gltf.loadAsync(`${base}assets/${name}.glb`);
        const root = g.scene;
        root.name = name;
        tune(root, renderer);
        prototypes.set(name, root);
      },
    });
  }
  jobs.push({
    label: "sky",
    run: async () => {
      const t = await new THREE.TextureLoader().loadAsync(`${base}assets/sky_bg.jpg`);
      t.mapping = THREE.EquirectangularReflectionMapping;
      t.colorSpace = THREE.SRGBColorSpace;
      skyTexture = t;
    },
  });
  jobs.push({
    label: "lighting",
    run: async () => {
      const t = await new HDRLoader().loadAsync(`${base}assets/sky_light.hdr`);
      t.mapping = THREE.EquirectangularReflectionMapping;
      envTexture = t;
    },
  });
  jobs.push({
    label: "layout",
    run: async () => {
      layout = await (await fetch(`${base}assets/layout.json`)).json();
    },
  });
  let done = 0;
  await Promise.all(
    jobs.map(async (j) => {
      await j.run();
      done += 1;
      onProgress(done / jobs.length, j.label);
    }),
  );
  draco.dispose();
}

/** A fresh copy of a model sharing geometry and materials with the prototype. */
export function model(name: string): THREE.Group {
  const p = prototypes.get(name);
  if (!p) throw new Error(`Missing model ${name}`);
  const c = p.clone(true);
  c.name = name;
  return c;
}

export function prototype(name: string): THREE.Group {
  const p = prototypes.get(name);
  if (!p) throw new Error(`Missing model ${name}`);
  return p;
}

/** Material fix-ups shared by every model (mirrors the macOS build's Assets.tune). */
function tune(root: THREE.Object3D, renderer: THREE.WebGLRenderer) {
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats as THREE.MeshStandardMaterial[]) {
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap"] as const) {
        const t = m[key];
        if (t) {
          t.anisotropy = aniso;
          t.wrapS = t.wrapT = THREE.RepeatWrapping;
        }
      }
      const name = (m.name || "").toLowerCase();
      if (name.includes("leaves")) {
        // Alpha-tested foliage: opaque pass with discard, so leaves sort and shadow correctly.
        m.transparent = false;
        m.alphaTest = 0.35;
        m.side = THREE.DoubleSide;
        m.depthWrite = true;
        m.shadowSide = THREE.DoubleSide;
      } else if (name.includes("glass")) {
        m.transparent = true;
        m.opacity = 0.12;
        m.depthWrite = false;
      } else {
        m.transparent = false;
        m.opacity = 1;
      }
      m.needsUpdate = true;
    }
  });
}
