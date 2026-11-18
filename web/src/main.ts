import * as THREE from "three";
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from "three-mesh-bvh";
import { loadAll, prototype } from "./assets";
import { GameAudio } from "./audio";
import { Game, Input, type Quality } from "./game";
import { HUD, renderCard } from "./hud";
import { isTouchDevice, TouchControls } from "./touch";
import { World } from "./world";

// Fast ray casts against the soldiers' body parts.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const view = document.getElementById("view") as HTMLCanvasElement;
const hudCanvas = document.getElementById("hud") as HTMLCanvasElement;
const card = document.getElementById("card")!;
const loading = document.getElementById("loading")!;
const progress = document.getElementById("progress")!;
const status = document.getElementById("status")!;

const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true, powerPreference: "high-performance", reversedDepthBuffer: true });
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const params = new URLSearchParams(location.search);

async function start() {
  const setStatus = (f: number, what: string) => {
    progress.style.width = `${Math.round(f * 85)}%`;
    status.textContent = `Loading ${what}…`;
  };
  await loadAll(renderer, setStatus);
  const tick = () => new Promise((r) => setTimeout(r, 0));
  status.textContent = "Building the valley…";
  await tick();
  // Ray-cast trees for the soldier model's parts (shared by every soldier).
  prototype("npc").traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) mesh.geometry.computeBoundsTree();
  });
  const world = new World();
  progress.style.width = "92%";
  status.textContent = "Synthesizing gunfire…";
  await tick();
  const audio = new GameAudio();
  audio.build();
  const game = new Game(world, audio);
  const hud = new HUD(hudCanvas);
  const input = new Input();

  // Quality presets: resolution and shadow map size are the expensive knobs.
  const applyQuality = (q: Quality) => {
    const dpr = window.devicePixelRatio || 1;
    renderer.setPixelRatio(q === "low" ? Math.min(dpr, 1) : q === "medium" ? Math.min(dpr, 1.5) : Math.min(dpr, 2));
    world.setShadowMapSize(q === "low" ? 1024 : q === "medium" ? 2048 : 4096);
    renderer.shadowMap.type = q === "low" ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
    resize();
  };
  const resize = () => {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    game.camera.aspect = w / h;
    game.camera.updateProjectionMatrix();
    hud.resize(w, h);
  };
  game.onQuality = applyQuality;
  const q = params.get("quality");
  if (q === "low" || q === "medium" || q === "high") game.quality = q;
  applyQuality(game.quality);
  window.addEventListener("resize", resize);

  status.textContent = "Drawing the map…";
  await tick();
  hud.map = world.renderMapImage(renderer);
  resize();
  game.populate();
  // Compile every shader up front so the first shots don't stutter.
  await renderer.compileAsync(world.scene, game.camera);
  progress.style.width = "100%";
  loading.classList.add("hidden");

  // MARK: Input

  const locked = () => document.pointerLockElement === view;
  // Touch screens (iPad, phones) have no pointer lock: on-screen controls drive the same Input.
  let pausedAt = 0;
  const touch = isTouchDevice() && !params.has("mouse")
    ? new TouchControls(input, { slotAt: (x, y) => hud.slotAt(x, y), onPause: () => { pausedAt = performance.now(); game.pause(); showCard(); } })
    : null;
  if (touch) document.getElementById("game")!.insertBefore(touch.root, card);
  const showCard = () => {
    renderCard(card, { mode: game.mode, kills: game.snapshot().kills, headshots: game.snapshot().headshots, longest: game.snapshot().longest }, !!touch);
    touch?.show(game.mode === "playing");
  };
  showCard();
  card.addEventListener("click", () => {
    audio.resume();
    if (touch) {
      if (performance.now() - pausedAt < 400) return;
      game.begin();
      showCard();
      return;
    }
    const p = view.requestPointerLock({ unadjustedMovement: true }) as unknown as Promise<void> | undefined;
    // Not every browser supports raw mouse input; fall back to the default.
    p?.catch?.(() => view.requestPointerLock());
  });
  document.addEventListener("pointerlockchange", () => {
    if (locked()) game.begin();
    else game.pause();
    showCard();
  });
  game.onDown = () => {
    if (document.pointerLockElement) document.exitPointerLock();
    showCard();
  };
  window.addEventListener("keydown", (e) => {
    if (["Space", "ArrowUp", "ArrowDown", "Tab"].includes(e.code)) e.preventDefault();
    if (!locked() && !params.has("demo") && !(touch && game.mode === "playing")) return;
    if (!e.repeat) input.pressed.add(e.code);
    input.keys.add(e.code);
    if (e.code === "KeyP" && !e.repeat) perf = !perf;
  });
  window.addEventListener("keyup", (e) => input.keys.delete(e.code));
  // Switching apps or locking the iPad pauses, and lets go of anything held down.
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && touch && game.mode === "playing") { game.pause(); showCard(); }
  });
  // Safari's pinch-to-zoom would otherwise fight two-finger play.
  for (const ev of ["gesturestart", "gesturechange", "dblclick"]) document.addEventListener(ev, (e) => e.preventDefault());
  window.addEventListener("blur", () => {
    input.keys.clear();
    input.fireDown = false;
    input.adsDown = false;
    touch?.reset();
  });
  view.addEventListener("mousemove", (e) => {
    if (!locked()) return;
    input.mouseDX += e.movementX;
    input.mouseDY += e.movementY;
  });
  view.addEventListener("mousedown", (e) => {
    if (!locked()) return;
    if (e.button === 0) { input.fireDown = true; input.firePressed = true; }
    if (e.button === 2) input.adsDown = true;
  });
  window.addEventListener("mouseup", (e) => {
    if (e.button === 0) input.fireDown = false;
    if (e.button === 2) input.adsDown = false;
  });
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  view.addEventListener("wheel", (e) => {
    if (!locked()) return;
    e.preventDefault();
    // Wheel up is positive, matching the macOS build: zoom in, previous slot. One notch ≈ 2.5.
    const scale = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 20 : 1 / 40;
    input.scroll += -e.deltaY * scale;
  }, { passive: false });

  // MARK: Loop

  let perf = params.has("perf");
  let last = performance.now();
  let frames = 0, acc = 0, updateMs = 0, fps = 0;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const t0 = performance.now();
    game.update(dt, input, window.innerHeight);
    updateMs += performance.now() - t0;
    game.particles.setScale(renderer.domElement.height, game.effectiveFOV);
    renderer.render(world.scene, game.camera);
    frames += 1;
    acc += dt;
    if (acc >= 0.5) {
      fps = frames / acc;
      game.perfText = perf
        ? `${fps.toFixed(0)} FPS · update ${(updateMs / frames).toFixed(1)} ms · ${renderer.info.render.calls} draws · ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris · ${game.quality.toUpperCase()}`
        : null;
      frames = 0; acc = 0; updateMs = 0;
    }
    const snap = game.snapshot();
    hud.draw(snap);
    touch?.sync(snap);
  };
  requestAnimationFrame(loop);

  // Console and automated-check access.
  Object.assign(window, { ridgeline: { game, world, renderer, input, THREE } });
  if (params.has("demo")) {
    game.begin();
    card.classList.add("hidden");
  }
}

start().catch((err) => {
  console.error(err);
  status.textContent = `Failed to load: ${err?.message ?? err}`;
});
