# Ridgeline — web

Browser port of the macOS SceneKit game: Three.js + TypeScript + Vite, with three-mesh-bvh for collision.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (any static host; relative paths)
```

Touch screens (iPad, phones) get on-screen controls automatically: drag the left side to move, the right side
to look, and use the buttons for fire, aim, reload and the rest (`src/touch.ts`). Add `?mouse` to force mouse
and keyboard instead. Pushes to `main` deploy to Vercel (`vercel.json` at the repo root builds `web/`).
On an iPad, open the Vercel URL in Safari, hold it sideways, and use Share → Add to Home Screen to
play full screen. Touch devices load lighter textures and start at low quality to stay inside
Safari's per-tab memory limit; add `?lowmem` to try that on a desktop.

URL options: `?quality=low|medium|high`, `?perf` (FPS overlay), `?demo` (starts without pointer lock).
In the console, `ridgeline.game.debug` has helpers (`giveAll()`, `stage(m)`, `viewCover(i)`, `peace()`).

Assets in `public/assets` are converted from `../Hyperrealistic_Shooter/GameAssets` with
`Blender --background --factory-startup --python tools/convert_assets.py` (GLB, WebP textures, Draco),
plus `layout.json`, `sky_light.hdr` and a 6144-px `sky_bg.jpg`.

Module map: `world.ts` (sky, terrain, props, tree LOD, shadows, map render), `cover.ts` (seeded cover and
sandbags), `collision.ts`, `game.ts` (player, weapons, ballistics, loot), `npc.ts`, `blood.ts`,
`particles.ts`, `gunsynth.ts` + `audio.ts` (procedural WebAudio), `hud.ts`.
