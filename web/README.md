# Ridgeline — web

Browser port of the macOS SceneKit game: Three.js + TypeScript + Vite, with three-mesh-bvh for collision.

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/ (any static host; relative paths)
```

URL options: `?quality=low|medium|high`, `?perf` (FPS overlay), `?demo` (starts without pointer lock).
In the console, `ridgeline.game.debug` has helpers (`giveAll()`, `stage(m)`, `viewCover(i)`, `peace()`).

Assets in `public/assets` are converted from `../Hyperrealistic_Shooter/GameAssets` with
`Blender --background --factory-startup --python tools/convert_assets.py` (GLB, WebP textures, Draco),
plus `layout.json`, `sky_light.hdr` and a 6144-px `sky_bg.jpg`.

Module map: `world.ts` (sky, terrain, props, tree LOD, shadows, map render), `cover.ts` (seeded cover and
sandbags), `collision.ts`, `game.ts` (player, weapons, ballistics, loot), `npc.ts`, `blood.ts`,
`particles.ts`, `gunsynth.ts` + `audio.ts` (procedural WebAudio), `hud.ts`.
