import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { HDRLoader } from "three/examples/jsm/loaders/HDRLoader.js";
import { isTouchDevice } from "./touch";

/**
 * iPads and phones get far less memory per tab than a desktop browser; when the textures don't fit,
 * Safari kills the page and reloads it, over and over. There, textures are capped at 1024 px
 * (a quarter of the memory of the 2k originals), the sky at 4096 px, and models load a few at a time.
 */
const LOW_MEMORY = isTouchDevice() || new URLSearchParams(location.search).has("lowmem");
const MAX_TEXTURE = LOW_MEMORY ? 1024 : Infinity;

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
        await shrinkTextures(root);
        prototypes.set(name, root);
      },
    });
  }
  jobs.push({
    label: "sky",
    run: async () => {
      const t = await new THREE.TextureLoader().loadAsync(`${base}assets/${LOW_MEMORY ? "sky_bg_4k" : "sky_bg"}.jpg`);
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
  let next = 0;
  // A few downloads in flight at once keeps the memory peak down on tablets.
  const lanes = LOW_MEMORY ? 3 : jobs.length;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (next < jobs.length) {
        const j = jobs[next++];
        await j.run();
        done += 1;
        onProgress(done / jobs.length, j.label);
      }
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

/** Downsizes any texture in the model larger than MAX_TEXTURE, freeing the full-size image. */
async function shrinkTextures(root: THREE.Object3D) {
  if (!Number.isFinite(MAX_TEXTURE)) return;
  const seen = new Set<THREE.Texture>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const m of (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) as THREE.MeshStandardMaterial[]) {
      for (const key of ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "alphaMap"] as const) {
        if (m[key]) seen.add(m[key]!);
      }
    }
  });
  for (const t of seen) {
    const im = t.image as (ImageBitmap | HTMLImageElement | HTMLCanvasElement) & { close?: () => void };
    const w = im?.width ?? 0, h = im?.height ?? 0;
    if (!w || !h) continue;
    // Once the GPU has its copy, drop ours: nothing re-uploads model textures, and keeping both
    // doubles what the tab holds.
    t.onUpdate = () => (t.image as { close?: () => void })?.close?.();
    if (Math.max(w, h) <= MAX_TEXTURE) continue;
    const k = MAX_TEXTURE / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * k)), nh = Math.max(1, Math.round(h * k));
    let out: ImageBitmap | HTMLCanvasElement;
    try {
      out = await createImageBitmap(im, { resizeWidth: nw, resizeHeight: nh, resizeQuality: "high" });
    } catch {
      const c = document.createElement("canvas");
      c.width = nw;
      c.height = nh;
      c.getContext("2d")!.drawImage(im, 0, 0, nw, nh);
      out = c;
    }
    im.close?.();
    t.image = out;
    t.needsUpdate = true;
  }
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
