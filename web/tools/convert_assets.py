"""Convert the game's USDZ assets to compact GLB for the web build.

Run headless:  Blender --background --factory-startup --python web/tools/convert_assets.py
Textures are downscaled per asset and written as WebP; meshes are Draco-compressed.
"""
import bpy, os, sys, json

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "Hyperrealistic_Shooter", "GameAssets")
DST = os.path.join(ROOT, "web", "public", "assets")

# Longest texture side per asset (photoscans ship at 4–8k).
MAX_TEX = {
    "terrain": 2048, "buildings": 2048, "tree_a": 1024, "cliff_a": 2048,
    "boulder_a": 1024, "boulder_b": 1024, "crate": 1024, "barrier": 1024, "log": 1024,
    "barrel_blue": 512, "barrel_red": 512, "npc": 1024,
    "rifle": 1024, "pistol": 512, "smg": 512, "ar": 512, "shotgun": 512,
}
# Small hand-built meshes are not worth Draco (and the guns keep exact sight geometry).
NO_DRACO = {"rifle", "pistol", "smg", "ar", "shotgun", "npc"}

only = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
report = {}
for name, limit in MAX_TEX.items():
    if only and name not in only:
        continue
    src = os.path.join(SRC, name + ".usdz")
    if not os.path.exists(src):
        print("missing", src); continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.wm.usd_import(filepath=src)
    for img in bpy.data.images:
        if img.size[0] == 0:
            continue
        w, h = img.size
        s = min(1.0, limit / max(w, h))
        if s < 1.0:
            img.scale(max(1, int(w * s)), max(1, int(h * s)))
    tris = sum(len(o.data.loop_triangles) if (o.type == "MESH" and not o.data.calc_loop_triangles()) else 0 for o in bpy.data.objects)
    out = os.path.join(DST, name + ".glb")
    bpy.ops.export_scene.gltf(
        filepath=out, export_format="GLB", export_image_format="WEBP", export_image_quality=82,
        export_draco_mesh_compression_enable=name not in NO_DRACO, export_draco_mesh_compression_level=6,
        export_yup=True, export_apply=True, export_cameras=False, export_lights=False,
        export_animations=False, export_skins=False)
    report[name] = {"tris": tris, "bytes": os.path.getsize(out)}
    print("CONVERTED", name, report[name])
print("REPORT", json.dumps(report))
