import fs from "fs";
for (const f of process.argv.slice(2)) {
  const b = fs.readFileSync(f);
  const len = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + len).toString());
  console.log("==", f.split("/").pop(), "nodes:", (j.nodes || []).map(n => n.name).join(", "));
  console.log("   materials:", (j.materials || []).map(m => m.name + (m.alphaMode ? "[" + m.alphaMode + "]" : "")).join(", "));
}
