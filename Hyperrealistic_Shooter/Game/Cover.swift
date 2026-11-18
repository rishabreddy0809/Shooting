#if os(macOS)
import SceneKit
import simd
import AppKit

/// Extra hiding spots scattered over the open ground, thickest toward the far desert edges:
/// rock outcrops, sandbag fighting positions, barricade lines and large rock formations.
/// Placement is seeded, so the map is the same every run (and on the minimap).
extension World {
    struct CoverRand {
        var s: UInt64
        mutating func next() -> Float {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            return Float((s >> 40) & 0xFFFFFF) / Float(0xFFFFFF)
        }
        mutating func range(_ a: Float, _ b: Float) -> Float { a + (b - a) * next() }
    }

    func setupCover() {
        var rng = CoverRand(s: 0x5EED_C0DE_2026)
        let existing = occupied
        var sites: [SIMD2<Float>] = []
        let cell: Float = 16
        for gz in stride(from: -200 as Float, through: 200, by: cell) {
            for gx in stride(from: -200 as Float, through: 200, by: cell) {
                let x = gx + rng.range(-5.5, 5.5), z = gz + rng.range(-5.5, 5.5)
                let edge = (x * x + z * z).squareRoot()
                // Open ground toward the edge of the (circular, r = 202 m) play area gets the most; the built-up middle keeps what it has.
                let t = max(0, min(1, (edge - 60) / 100))
                let chance = 0.14 + 0.62 * t * t * (3 - 2 * t)
                let roll = rng.next(), kind = rng.next(), yaw = rng.range(0, 2 * .pi)
                guard roll < chance, edge < 195 else { continue }
                let p = SIMD2(x, z)
                guard !existing.contains(where: { simd_distance($0, p) < 12 }),
                      !sites.contains(where: { simd_distance($0, p) < 15 }),
                      let ground = flatGround(x: x, z: z, radius: 3.5) else { continue }
                sites.append(p)
                var site = rng
                site.s ^= UInt64(sites.count) &* 0x9E3779B97F4A7C15
                if kind < 0.30 {
                    rockOutcrop(at: ground, yaw: yaw, rng: &site)
                } else if kind < 0.55 {
                    sandbagNest(at: ground, yaw: yaw, rng: &site)
                } else if kind < 0.80 {
                    barricade(at: ground, yaw: yaw, rng: &site)
                } else if edge > 110 {
                    rockFormation(at: ground, yaw: yaw, rng: &site)
                } else {
                    rockOutcrop(at: ground, yaw: yaw, rng: &site)
                }
            }
        }
        coverSites = sites
    }

    // MARK: Site kinds

    private func rockOutcrop(at c: V3, yaw: Float, rng: inout CoverRand) {
        let big = rng.range(1.5, 2.3)
        if let y = terrainHeight(c.x, c.z) {
            placeProp("boulder_a", at: V3(c.x, y - 0.2 * big, c.z), yaw: yaw, scale: big,
                      tilt: V3(rng.range(-0.12, 0.12), 0, rng.range(-0.12, 0.12)))
        }
        let extra = 1 + Int(rng.next() * 3)
        for i in 0..<extra {
            let a = yaw + Float(i) * 2.1 + rng.range(-0.5, 0.5)
            let r = rng.range(2.4, 3.6) * big / 1.8
            let x = c.x + cos(a) * r, z = c.z + sin(a) * r
            let s = rng.range(1.1, 2.0)
            guard let y = terrainHeight(x, z) else { continue }
            placeProp("boulder_b", at: V3(x, y - 0.15 * s, z), yaw: rng.range(0, 6.28), scale: s,
                      tilt: V3(rng.range(-0.2, 0.2), 0, rng.range(-0.2, 0.2)))
        }
    }

    private func rockFormation(at c: V3, yaw: Float, rng: inout CoverRand) {
        // A house-sized rock with smaller blocks shed along one side: full standing cover.
        let big = rng.range(2.8, 3.6)
        if let y = lowestGround(around: c, radius: 1.5 * big) {
            placeProp("boulder_a", at: V3(c.x, y - 0.22 * big, c.z), yaw: yaw, scale: big,
                      tilt: V3(rng.range(-0.1, 0.1), 0, rng.range(-0.1, 0.1)))
        }
        let dir = V3(cos(yaw), 0, -sin(yaw))
        for i in 0..<3 {
            let side: Float = i == 1 ? -1 : 1
            let along = side * rng.range(2.6, 3.4) * big / 2.4 + (i == 2 ? 1.6 : 0)
            let p = c + dir * along + V3(-dir.z, 0, dir.x) * rng.range(-1.2, 1.2)
            let bs = i == 2 ? rng.range(1.2, 1.8) : rng.range(1.7, 2.4)
            guard let gy = terrainHeight(p.x, p.z) else { continue }
            placeProp(i == 2 ? "boulder_b" : "boulder_a", at: V3(p.x, gy - 0.2 * bs, p.z), yaw: rng.range(0, 6.28), scale: bs,
                      tilt: V3(rng.range(-0.15, 0.15), 0, rng.range(-0.15, 0.15)))
        }
    }

    private func barricade(at c: V3, yaw: Float, rng: inout CoverRand) {
        let dir = V3(cos(yaw), 0, -sin(yaw))
        let side = V3(-dir.z, 0, dir.x)
        // Concrete barriers end to end, with a sandbag wall stacked up behind for standing cover.
        let count = 2 + Int(rng.next() * 2)
        for i in 0..<count {
            let off = (Float(i) - Float(count - 1) / 2) * 1.58
            let p = c + dir * off + side * rng.range(-0.06, 0.06)
            guard let y = terrainHeight(p.x, p.z) else { continue }
            placeProp("barrier", at: V3(p.x, y - 0.03, p.z), yaw: yaw + rng.range(-0.05, 0.05), scale: 1)
        }
        let length = Float(count) * 1.4
        let behind = c - side * 0.75
        let path = (0...12).map { i -> (V3, V3) in
            let u = Float(i) / 12 - 0.5
            return (behind + dir * (u * length), dir)
        }
        addSandbags(along: path, rows: 8, name: "sandbags", rng: &rng)
        if rng.next() < 0.6 {
            let p = c + dir * (length * 0.5 + 1.2) - side * rng.range(0, 1)
            if let y = terrainHeight(p.x, p.z) {
                placeProp("log", at: V3(p.x, y + 0.1, p.z), yaw: yaw + rng.range(1.2, 1.9), scale: 1.2)
            }
        }
    }

    /// A horseshoe fighting position: a sandbag ring open at the back, sometimes with a barrel inside.
    private func sandbagNest(at c: V3, yaw: Float, rng: inout CoverRand) {
        let radius = rng.range(1.8, 2.4)
        let span = rng.range(1.15, 1.45) * .pi
        let steps = 24
        let path = (0...steps).map { i -> (V3, V3) in
            let a = yaw - span / 2 + span * Float(i) / Float(steps)
            let p = c + V3(cos(a), 0, -sin(a)) * radius
            let tangent = V3(-sin(a), 0, -cos(a))
            return (p, tangent)
        }
        addSandbags(along: path, rows: 8 + Int(rng.next() * 2), name: "sandbags", rng: &rng)
        if rng.next() < 0.55 {
            let a = yaw + .pi + rng.range(-0.5, 0.5)
            let p = c + V3(cos(a), 0, -sin(a)) * radius * 0.55
            if let y = terrainHeight(p.x, p.z) {
                placeProp(rng.next() < 0.5 ? "barrel_blue" : "barrel_red", at: V3(p.x, y, p.z), yaw: rng.range(0, 6.28), scale: 1)
            }
        }
    }

    // MARK: Ground queries

    private func terrainHeight(_ x: Float, _ z: Float) -> Float? {
        guard let h = collision.raycast(from: V3(x, 90, z), to: V3(x, -40, z), only: "terrain") else { return nil }
        return 90 - 130 * h.t
    }

    /// Ground at the centre if the area around it is fairly level and nothing is built there.
    private func flatGround(x: Float, z: Float, radius: Float) -> V3? {
        guard let hit = collision.raycast(from: V3(x, 90, z), to: V3(x, -40, z)),
              hit.tag == "terrain", hit.normal.y > 0.93 else { return nil }
        let y = 90 - 130 * hit.t
        for k in 0..<6 {
            let a = Float(k) * .pi / 3
            guard let h = terrainHeight(x + cos(a) * radius, z + sin(a) * radius), abs(h - y) < 1.1 else { return nil }
        }
        return V3(x, y, z)
    }

    private func lowestGround(around c: V3, radius: Float) -> Float? {
        var low = c.y
        for k in 0..<8 {
            let a = Float(k) * .pi / 4
            guard let h = terrainHeight(c.x + cos(a) * radius, c.z + sin(a) * radius) else { return nil }
            low = min(low, h)
        }
        return low
    }

    // MARK: Sandbags

    /// Stacks bags in running bond along a path of (point, direction) samples, following the ground.
    /// The whole wall is one mesh: one draw call and one ray-cast tree.
    private func addSandbags(along path: [(V3, V3)], rows: Int, name: String, rng: inout CoverRand) {
        // Arc-length table for placing bags evenly.
        var lengths: [Float] = [0]
        for i in 1..<path.count { lengths.append(lengths[i - 1] + simd_distance(path[i].0, path[i - 1].0)) }
        let total = lengths.last ?? 0
        guard total > 0.5 else { return }
        func sample(_ s: Float) -> (V3, V3) {
            var i = 1
            while i < path.count - 1 && lengths[i] < s { i += 1 }
            let seg = max(1e-4, lengths[i] - lengths[i - 1])
            let u = max(0, min(1, (s - lengths[i - 1]) / seg))
            let p = path[i - 1].0 + (path[i].0 - path[i - 1].0) * u
            return (p, simd_normalize(path[i - 1].1 + (path[i].1 - path[i - 1].1) * u))
        }

        let bagLength: Float = 0.6, spacing: Float = 0.47, rise: Float = 0.114
        var positions: [V3] = [], normals: [V3] = [], uvs: [SIMD2<Float>] = [], colors: [SIMD4<Float>] = []
        var indices: [UInt32] = []
        var triangles: [(V3, V3, V3)] = []

        for row in 0..<rows {
            let offset: Float = row % 2 == 0 ? 0 : spacing / 2
            // Upper rows step back slightly, like a real battered wall.
            var s = offset + spacing / 2
            while s < total - spacing * 0.3 {
                let (p, dir) = sample(s)
                s += spacing
                guard let ground = terrainHeight(p.x, p.z) else { continue }
                let side = V3(-dir.z, 0, dir.x)
                let centre = V3(p.x, 0, p.z) + side * (Float(row) * 0.012) + V3(0, ground - 0.02 + 0.07 + Float(row) * rise, 0)
                let yaw = atan2(-dir.z, dir.x) + rng.range(-0.09, 0.09)
                let shape = SandbagShape(length: bagLength * rng.range(0.94, 1.06), width: rng.range(0.33, 0.37),
                                         height: rng.range(0.14, 0.16), squash: rng.range(0, 1), seed: UInt64(rng.next() * 1e6))
                let shade = rng.range(0.82, 1.08)
                let tint = SIMD4<Float>(shade, shade * rng.range(0.97, 1.0), shade * rng.range(0.92, 1.0), 1)
                let rot = simd_quatf(angle: yaw, axis: V3(0, 1, 0)) * simd_quatf(angle: rng.range(-0.04, 0.04), axis: V3(1, 0, 0))
                shape.append(centre: centre, rotation: rot, tint: tint, uvOffset: SIMD2(rng.next(), rng.next()),
                             positions: &positions, normals: &normals, uvs: &uvs, colors: &colors, indices: &indices)
                // Collision uses a plain box per bag: a fraction of the triangles, and as solid to a bullet.
                World.appendBox(centre: centre, rotation: rot, half: V3(shape.length * 0.47, shape.height * 0.5, shape.width * 0.5), to: &triangles)
            }
        }
        guard !indices.isEmpty else { return }
        let geo = SCNGeometry(sources: [
            SCNGeometrySource(vertices: positions.map { SCNVector3($0) }),
            SCNGeometrySource(normals: normals.map { SCNVector3($0) }),
            SCNGeometrySource(textureCoordinates: uvs.map { CGPoint(x: CGFloat($0.x), y: CGFloat($0.y)) }),
            World.colorSource(colors),
        ], elements: [SCNGeometryElement(indices: indices, primitiveType: .triangles)])
        geo.materials = [World.sandbagMaterial]
        let node = SCNNode(geometry: geo)
        node.name = name
        staticRoot.addChildNode(node)
        if let mesh = MeshBVH(triangles: triangles) {
            collision.add(mesh, transform: matrix_identity_float4x4, tag: name)
        }
    }

    static func appendBox(centre: V3, rotation: simd_quatf, half: V3, to tris: inout [(V3, V3, V3)]) {
        func corner(_ i: Int) -> V3 {
            centre + rotation.act(V3(i & 1 == 0 ? -half.x : half.x, i & 2 == 0 ? -half.y : half.y, i & 4 == 0 ? -half.z : half.z))
        }
        let faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
        for (a, b, c, d) in faces {
            tris.append((corner(a), corner(b), corner(c)))
            tris.append((corner(a), corner(c), corner(d)))
        }
    }

    private static func colorSource(_ colors: [SIMD4<Float>]) -> SCNGeometrySource {
        let data = colors.withUnsafeBufferPointer { Data(buffer: $0) }
        return SCNGeometrySource(data: data, semantic: .color, vectorCount: colors.count, usesFloatComponents: true,
                                 componentsPerVector: 4, bytesPerComponent: 4, dataOffset: 0,
                                 dataStride: MemoryLayout<SIMD4<Float>>.stride)
    }

    /// Weathered burlap: a tight weave, sun-bleached and dusty.
    nonisolated(unsafe) static let sandbagMaterial: SCNMaterial = {
        let m = SCNMaterial()
        m.lightingModel = .physicallyBased
        let (albedo, normal) = burlapTextures(size: 256)
        m.diffuse.contents = albedo
        m.diffuse.wrapS = .repeat
        m.diffuse.wrapT = .repeat
        m.normal.contents = normal
        m.normal.wrapS = .repeat
        m.normal.wrapT = .repeat
        m.normal.intensity = 0.8
        m.roughness.contents = 0.93
        m.metalness.contents = 0.0
        return m
    }()

    private static func burlapTextures(size n: Int) -> (CGImage, CGImage) {
        var rng = CoverRand(s: 77)
        var height = [Float](repeating: 0, count: n * n)
        // Low-frequency dust and stains, tiling: sum of a few wrapped sine blobs.
        var blobs: [(Float, Float, Float, Float)] = []
        for _ in 0..<10 { blobs.append((rng.range(0, 1), rng.range(0, 1), rng.range(1, 3).rounded(), rng.range(0, 6.28))) }
        var dirt = [Float](repeating: 0, count: n * n)
        let period: Float = 6
        for y in 0..<n {
            for x in 0..<n {
                let fx = Float(x), fy = Float(y)
                let cx = Int(fx / period), cy = Int(fy / period)
                let warp = abs(sin(.pi * (fx + 0.5) / period))   // vertical threads across x
                let weft = abs(sin(.pi * (fy + 0.5) / period))
                let over = (cx + cy) % 2 == 0
                var h = over ? 0.55 + 0.45 * weft * (0.6 + 0.4 * warp) : 0.55 + 0.45 * warp * (0.6 + 0.4 * weft)
                h *= 0.85 + 0.3 * rng.next()
                height[y * n + x] = h
                var d: Float = 0
                for b in blobs {
                    d += sin(2 * .pi * (b.2 * Float(x) / Float(n) + b.0) + b.3) * sin(2 * .pi * (b.2 * Float(y) / Float(n) + b.1))
                }
                dirt[y * n + x] = d / Float(blobs.count)
            }
        }
        var albedo = [UInt8](repeating: 255, count: n * n * 4)
        var normal = [UInt8](repeating: 255, count: n * n * 4)
        for y in 0..<n {
            for x in 0..<n {
                let i = y * n + x
                let h = height[i]
                let d = dirt[i] * 2.2
                let light = 0.58 + 0.42 * h
                let r = (0.60 + 0.05 * d) * light, g = (0.52 + 0.04 * d) * light, b = (0.38 + 0.02 * d) * light
                albedo[i * 4] = UInt8(max(0, min(255, r * 255)))
                albedo[i * 4 + 1] = UInt8(max(0, min(255, g * 255)))
                albedo[i * 4 + 2] = UInt8(max(0, min(255, b * 255)))
                let hx = height[y * n + (x + 1) % n] - height[y * n + (x + n - 1) % n]
                let hy = height[((y + 1) % n) * n + x] - height[((y + n - 1) % n) * n + x]
                let v = simd_normalize(V3(-hx * 2.5, -hy * 2.5, 1))
                normal[i * 4] = UInt8((v.x * 0.5 + 0.5) * 255)
                normal[i * 4 + 1] = UInt8((v.y * 0.5 + 0.5) * 255)
                normal[i * 4 + 2] = UInt8((v.z * 0.5 + 0.5) * 255)
            }
        }
        func image(_ bytes: [UInt8]) -> CGImage {
            let provider = CGDataProvider(data: Data(bytes) as CFData)!
            return CGImage(width: n, height: n, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: n * 4,
                           space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
                           provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent)!
        }
        return (image(albedo), image(normal))
    }
}

/// One filled bag: a pillow with a flat bottom, a rounded top and pinched, tied-off ends.
struct SandbagShape {
    let length: Float, width: Float, height: Float
    /// 0 = plump, 1 = slumped flatter and wider.
    let squash: Float
    let seed: UInt64

    static let nu = 11, nv = 10

    func append(centre: V3, rotation: simd_quatf, tint: SIMD4<Float>, uvOffset: SIMD2<Float>,
                positions: inout [V3], normals: inout [V3], uvs: inout [SIMD2<Float>], colors: inout [SIMD4<Float>],
                indices: inout [UInt32]) {
        let nu = SandbagShape.nu, nv = SandbagShape.nv
        let base = UInt32(positions.count)
        var local = [V3](repeating: .zero, count: nu * nv)
        let h = height * (1 - 0.18 * squash), w = width * (1 + 0.12 * squash)
        var lumps = World.CoverRand(s: seed | 1)
        let lumpA = lumps.range(-0.012, 0.012), lumpB = lumps.range(0, 6.28)
        for i in 0..<nu {
            let u = Float(i) / Float(nu - 1)
            let e = abs(2 * u - 1)
            // Full section through the middle, gathered to a tie at each end.
            let gather = pow(max(0, 1 - pow(e, 7)), 0.35)
            for j in 0..<nv {
                let a = 2 * Float.pi * Float(j) / Float(nv)
                let c = cos(a), s = sin(a)
                // Rounded-box section: boxy sides, softer top.
                var z = (w / 2) * copysign(pow(abs(c), 0.55), c) * gather
                var y = (h / 2) * copysign(pow(abs(s), 0.7), s) * gather
                // Weight settles the bag onto whatever is below it.
                y = max(y, -h * 0.36 * gather)
                if s > 0 { y += lumpA * sin(3 * .pi * u + lumpB) * gather }
                z *= 1 + 0.06 * max(0, -s)
                local[i * nv + j] = V3((u - 0.5) * length, y, z)
            }
        }
        // Smooth normals from the ring grid.
        for i in 0..<nu {
            for j in 0..<nv {
                let p = local[i * nv + j]
                let du = local[min(nu - 1, i + 1) * nv + j] - local[max(0, i - 1) * nv + j]
                let dv = local[i * nv + (j + 1) % nv] - local[i * nv + (j + nv - 1) % nv]
                var n = simd_cross(dv, du)
                if simd_length(n) < 1e-6 { n = V3(i < nu / 2 ? -1 : 1, 0, 0) }
                n = simd_normalize(n)
                // Keep normals pointing outward.
                if simd_dot(n, p - V3(p.x * 0.5, 0, 0)) < 0 { n = -n }
                positions.append(centre + rotation.act(p))
                normals.append(rotation.act(n))
                uvs.append(SIMD2(Float(i) / Float(nu - 1) * 2.2, Float(j) / Float(nv) * 1.4) + uvOffset)
                colors.append(tint)
            }
        }
        for i in 0..<(nu - 1) {
            for j in 0..<nv {
                let a = base + UInt32(i * nv + j), b = base + UInt32(i * nv + (j + 1) % nv)
                let c = base + UInt32((i + 1) * nv + j), d = base + UInt32((i + 1) * nv + (j + 1) % nv)
                indices += [a, c, b, b, c, d]
            }
        }
    }
}
#endif
