import fs from "fs";
const b = fs.readFileSync(process.argv[2]);
const j = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString());
const f = (a) => a ? a.map(v => +v.toFixed(3)).join(",") : "";
function walk(i, d) {
  const n = j.nodes[i];
  console.log("  ".repeat(d) + n.name + (n.mesh !== undefined ? " [mesh]" : "") + (n.translation ? " t=" + f(n.translation) : "") + (n.rotation ? " r=" + f(n.rotation) : "") + (n.scale ? " s=" + f(n.scale) : ""));
  (n.children || []).forEach(c => walk(c, d + 1));
}
j.scenes[0].nodes.forEach(i => walk(i, 0));
