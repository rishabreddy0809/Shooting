#if os(macOS)
import SceneKit
import simd

/// Bounding-volume hierarchy over one mesh's triangles, for segment queries.
///
/// The game used to ask SceneKit's physics world for every ray-cast. Each of those calls takes the
/// scene lock, which the render thread holds while it draws, so dozens of queries a frame spent
/// most of their time waiting on the renderer. These queries run on plain arrays instead.
final class MeshBVH {
    private struct Node {
        var lo: V3
        var hi: V3
        /// Leaf: first triangle. Inner: index of the left child (the right child follows it).
        var first: Int32
        /// Triangle count for leaves, 0 for inner nodes.
        var count: Int32
    }

    private let nodes: [Node]
    private let p0: [V3]
    private let e1: [V3]
    private let e2: [V3]
    let lo: V3
    let hi: V3

    init?(triangles tris: [(V3, V3, V3)]) {
        let n = tris.count
        guard n > 0 else { return nil }
        var tlo = [V3](repeating: .zero, count: n)
        var thi = [V3](repeating: .zero, count: n)
        var centre = [V3](repeating: .zero, count: n)
        for i in 0..<n {
            let (a, b, c) = tris[i]
            tlo[i] = simd_min(a, simd_min(b, c))
            thi[i] = simd_max(a, simd_max(b, c))
            centre[i] = (a + b + c) / 3
        }
        var order = Array(0..<n)
        var nodes: [Node] = [Node(lo: .zero, hi: .zero, first: 0, count: 0)]
        nodes.reserveCapacity(n)
        var work: [(node: Int, start: Int, end: Int)] = [(0, 0, n)]
        while let (ni, s, e) = work.popLast() {
            var blo = V3(repeating: .infinity), bhi = V3(repeating: -.infinity)
            var clo = blo, chi = bhi
            for k in s..<e {
                let t = order[k]
                blo = simd_min(blo, tlo[t]); bhi = simd_max(bhi, thi[t])
                clo = simd_min(clo, centre[t]); chi = simd_max(chi, centre[t])
            }
            nodes[ni].lo = blo
            nodes[ni].hi = bhi
            let count = e - s
            if count <= 4 {
                nodes[ni].first = Int32(s)
                nodes[ni].count = Int32(count)
                continue
            }
            // Split the longest axis of the centroid bounds at its middle.
            let ext = chi - clo
            let axis = ext.x > ext.y ? (ext.x > ext.z ? 0 : 2) : (ext.y > ext.z ? 1 : 2)
            var mid = s + count / 2
            if ext[axis] > 1e-6 {
                let split = (clo[axis] + chi[axis]) * 0.5
                var i = s, j = e - 1
                while i <= j {
                    if centre[order[i]][axis] < split { i += 1 } else { order.swapAt(i, j); j -= 1 }
                }
                if i > s && i < e { mid = i }
            }
            let left = nodes.count
            nodes.append(Node(lo: .zero, hi: .zero, first: 0, count: 0))
            nodes.append(Node(lo: .zero, hi: .zero, first: 0, count: 0))
            nodes[ni].first = Int32(left)
            nodes[ni].count = 0
            work.append((left, s, mid))
            work.append((left + 1, mid, e))
        }
        self.nodes = nodes
        p0 = order.map { tris[$0].0 }
        e1 = order.map { tris[$0].1 - tris[$0].0 }
        e2 = order.map { tris[$0].2 - tris[$0].0 }
        lo = nodes[0].lo
        hi = nodes[0].hi
    }

    /// Nearest hit along `a + d·t` for t in (0, maxT): the parameter and the face normal (not normalised).
    func intersect(_ a: V3, _ d: V3, maxT: Float) -> (t: Float, normal: V3)? {
        let inv = MeshBVH.inverse(d)
        var best = maxT
        var bestNormal = V3.zero
        var found = false
        return nodes.withUnsafeBufferPointer { nodes in
            p0.withUnsafeBufferPointer { p0 in
                e1.withUnsafeBufferPointer { e1 in
                    e2.withUnsafeBufferPointer { e2 in
                        withUnsafeTemporaryAllocation(of: Int32.self, capacity: 64) { stack in
                            var top = 1
                            stack[0] = 0
                            while top > 0 {
                                top -= 1
                                let node = nodes[Int(stack[top])]
                                guard MeshBVH.slab(node.lo, node.hi, a, inv, best) else { continue }
                                if node.count > 0 {
                                    let start = Int(node.first)
                                    for k in start..<(start + Int(node.count)) {
                                        let edge1 = e1[k], edge2 = e2[k]
                                        let p = simd_cross(d, edge2)
                                        let det = simd_dot(edge1, p)
                                        if abs(det) < 1e-12 { continue }
                                        let invDet = 1 / det
                                        let s = a - p0[k]
                                        let u = simd_dot(s, p) * invDet
                                        if u < 0 || u > 1 { continue }
                                        let q = simd_cross(s, edge1)
                                        let v = simd_dot(d, q) * invDet
                                        if v < 0 || u + v > 1 { continue }
                                        let t = simd_dot(edge2, q) * invDet
                                        if t > 1e-6 && t < best {
                                            best = t
                                            bestNormal = simd_cross(edge1, edge2)
                                            found = true
                                        }
                                    }
                                } else if top + 2 <= 64 {
                                    stack[top] = node.first
                                    stack[top + 1] = node.first + 1
                                    top += 2
                                }
                            }
                            return found ? (best, bestNormal) : nil
                        }
                    }
                }
            }
        }
    }

    /// 1/d without infinities: an axis-aligned ray against a box face lying exactly on its line would
    /// otherwise compute 0·∞ = NaN and wrongly miss (vertical probes on grid-aligned terrain do this).
    @inline(__always)
    static func inverse(_ d: V3) -> V3 {
        let tiny: Float = 1e-20
        let safe = V3(abs(d.x) < tiny ? tiny : d.x, abs(d.y) < tiny ? tiny : d.y, abs(d.z) < tiny ? tiny : d.z)
        return V3(1, 1, 1) / safe
    }

    /// Does the segment enter the box before `maxT`?
    @inline(__always)
    static func slab(_ lo: V3, _ hi: V3, _ a: V3, _ inv: V3, _ maxT: Float) -> Bool {
        let t1 = (lo - a) * inv
        let t2 = (hi - a) * inv
        let near = simd_reduce_max(simd_min(t1, t2))
        let far = simd_reduce_min(simd_max(t1, t2))
        return far >= max(near, 0) && near <= maxT
    }
}

/// The static level as ray-cast geometry: unique meshes placed by transform, plus tree trunks as cylinders.
final class CollisionWorld {
    struct Hit {
        let t: Float
        let normal: V3
        let tag: String
    }

    private struct Instance {
        let mesh: MeshBVH
        let toLocal: simd_float4x4
        /// Inverse transpose of the instance transform, for normals.
        let normalToWorld: simd_float3x3
        let lo: V3
        let hi: V3
        let tag: String
    }

    private struct Trunk {
        let x: Float, z: Float, r: Float, y0: Float, y1: Float
    }

    private var instances: [Instance] = []
    private var trunks: [Trunk] = []
    private(set) var triangleCount = 0

    func add(_ mesh: MeshBVH, transform: simd_float4x4, tag: String) {
        var lo = V3(repeating: .infinity), hi = V3(repeating: -.infinity)
        for i in 0..<8 {
            let corner = V3(i & 1 == 0 ? mesh.lo.x : mesh.hi.x, i & 2 == 0 ? mesh.lo.y : mesh.hi.y, i & 4 == 0 ? mesh.lo.z : mesh.hi.z)
            let w = (transform * SIMD4(corner, 1)).xyz
            lo = simd_min(lo, w); hi = simd_max(hi, w)
        }
        let toLocal = transform.inverse
        let m = simd_float3x3(toLocal.columns.0.xyz, toLocal.columns.1.xyz, toLocal.columns.2.xyz)
        instances.append(Instance(mesh: mesh, toLocal: toLocal, normalToWorld: m.transpose, lo: lo, hi: hi, tag: tag))
        topDirty = true
    }

    private struct TopNode {
        var lo: V3, hi: V3
        /// Leaf: first entry in `topOrder`. Inner: left child (right child follows).
        var first: Int32
        var count: Int32
    }

    private var topNodes: [TopNode] = []
    private var topOrder: [Int] = []
    private var topDirty = true

    /// Bounding-volume tree over the placed instances (median split on the longest axis).
    private func buildTop() {
        topDirty = false
        topOrder = Array(instances.indices)
        topNodes = [TopNode(lo: .zero, hi: .zero, first: 0, count: 0)]
        guard !instances.isEmpty else { topNodes[0].lo = V3(repeating: 1); topNodes[0].hi = V3(repeating: -1); return }
        var work: [(Int, Int, Int)] = [(0, 0, instances.count)]
        while let (ni, s, e) = work.popLast() {
            var lo = V3(repeating: .infinity), hi = V3(repeating: -.infinity)
            for k in s..<e { lo = simd_min(lo, instances[topOrder[k]].lo); hi = simd_max(hi, instances[topOrder[k]].hi) }
            topNodes[ni].lo = lo
            topNodes[ni].hi = hi
            if e - s <= 2 {
                topNodes[ni].first = Int32(s)
                topNodes[ni].count = Int32(e - s)
                continue
            }
            let ext = hi - lo
            let axis = ext.x > ext.z ? 0 : 2
            let centre = { (i: Int) -> Float in (self.instances[i].lo[axis] + self.instances[i].hi[axis]) * 0.5 }
            topOrder[s..<e].sort { centre($0) < centre($1) }
            let mid = (s + e) / 2
            let left = topNodes.count
            topNodes.append(TopNode(lo: .zero, hi: .zero, first: 0, count: 0))
            topNodes.append(TopNode(lo: .zero, hi: .zero, first: 0, count: 0))
            topNodes[ni].first = Int32(left)
            topNodes[ni].count = 0
            work.append((left, s, mid))
            work.append((left + 1, mid, e))
        }
    }

    func addTrunk(x: Float, z: Float, radius: Float, from y0: Float, to y1: Float) {
        trunks.append(Trunk(x: x, z: z, r: radius, y0: y0, y1: y1))
    }

    /// Nearest hit on the segment a→b. The normal always faces back along the ray.
    /// `only` restricts the test to geometry with that tag.
    func raycast(from a: V3, to b: V3, only: String? = nil) -> Hit? {
        let d = b - a
        let inv = MeshBVH.inverse(d)
        var best: Float = 1
        var normal = V3.zero
        var tag = ""
        if topDirty { buildTop() }
        // Walk the tree of instance bounds, so a ray only visits the few objects along it.
        var stack = [Int32](repeating: 0, count: 64)
        var top = 1
        while top > 0 {
            top -= 1
            let node = topNodes[Int(stack[top])]
            guard MeshBVH.slab(node.lo, node.hi, a, inv, best) else { continue }
            if node.count > 0 {
                for k in Int(node.first)..<Int(node.first + node.count) {
                    let i = topOrder[k]
                    guard MeshBVH.slab(instances[i].lo, instances[i].hi, a, inv, best) else { continue }
                    let inst = instances[i]
                    if let only, inst.tag != only { continue }
                    let la = (inst.toLocal * SIMD4(a, 1)).xyz
                    let ld = (inst.toLocal * SIMD4(d, 0)).xyz
                    if let h = inst.mesh.intersect(la, ld, maxT: best) {
                        best = h.t
                        normal = inst.normalToWorld * h.normal
                        tag = inst.tag
                    }
                }
            } else if top + 2 <= stack.count {
                stack[top] = node.first
                stack[top + 1] = node.first + 1
                top += 2
            }
        }
        // Trunks: vertical cylinders, tested in the ground plane.
        let dx = d.x, dz = d.z
        let qa = dx * dx + dz * dz
        if qa > 1e-9 && (only == nil || only == "tree") {
            for tr in trunks {
                let ox = a.x - tr.x, oz = a.z - tr.z
                let qb = ox * dx + oz * dz
                let qc = ox * ox + oz * oz - tr.r * tr.r
                let disc = qb * qb - qa * qc
                guard disc >= 0 else { continue }
                let t = (-qb - disc.squareRoot()) / qa
                guard t > 0, t < best else { continue }
                let y = a.y + d.y * t
                guard y >= tr.y0, y <= tr.y1 else { continue }
                best = t
                normal = V3(ox + dx * t, 0, oz + dz * t)
                tag = "tree"
            }
        }
        guard !tag.isEmpty else { return nil }
        var n = simd_normalize(normal)
        if simd_dot(n, d) > 0 { n = -n }
        return Hit(t: best, normal: n, tag: tag)
    }

    // MARK: Mesh extraction

    /// All triangles under `root`, in `root`'s own coordinate space.
    static func triangles(of root: SCNNode) -> [(V3, V3, V3)] {
        var out: [(V3, V3, V3)] = []
        let rootInverse = root.simdWorldTransform.inverse
        root.enumerateHierarchy { node, _ in
            guard let geo = node.geometry, let src = geo.sources(for: .vertex).first,
                  src.usesFloatComponents, src.bytesPerComponent == 4, src.componentsPerVector >= 3 else { return }
            let m = rootInverse * node.simdWorldTransform
            var verts = [V3](repeating: .zero, count: src.vectorCount)
            src.data.withUnsafeBytes { raw in
                for i in 0..<src.vectorCount {
                    let base = src.dataOffset + i * src.dataStride
                    guard base + 12 <= raw.count else { break }
                    let p = V3(raw.loadUnaligned(fromByteOffset: base, as: Float.self),
                               raw.loadUnaligned(fromByteOffset: base + 4, as: Float.self),
                               raw.loadUnaligned(fromByteOffset: base + 8, as: Float.self))
                    verts[i] = (m * SIMD4(p, 1)).xyz
                }
            }
            // USD imports can index each attribute separately: every corner then carries one index per
            // source (position, normal, uv...), in source order. Read only the position's slot.
            let sources = geo.sources
            let vertexSlot = sources.firstIndex { $0.semantic == .vertex } ?? 0
            for el in geo.elements where el.primitiveType == .triangles && el.primitiveCount > 0 {
                let w = el.bytesPerIndex
                let channels = max(1, el.data.count / (el.primitiveCount * 3 * w))
                let slot = channels == sources.count ? vertexSlot : 0
                el.data.withUnsafeBytes { raw in
                    func index(_ k: Int) -> Int {
                        let at = (k * channels + slot) * w
                        switch w {
                        case 1: return Int(raw.load(fromByteOffset: at, as: UInt8.self))
                        case 2: return Int(raw.loadUnaligned(fromByteOffset: at, as: UInt16.self))
                        default: return Int(raw.loadUnaligned(fromByteOffset: at, as: UInt32.self))
                        }
                    }
                    let available = raw.count / (w * channels * 3)
                    for t in 0..<min(el.primitiveCount, available) {
                        let i0 = index(t * 3), i1 = index(t * 3 + 1), i2 = index(t * 3 + 2)
                        guard i0 < verts.count, i1 < verts.count, i2 < verts.count else { continue }
                        out.append((verts[i0], verts[i1], verts[i2]))
                    }
                }
            }
        }
        return out
    }
}
#endif
