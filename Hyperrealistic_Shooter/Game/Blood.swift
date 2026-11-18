#if os(macOS)
import SceneKit
import AppKit
import simd

/// Blood effects: droplet spray at the wound, spatter decals on whatever lies behind the target,
/// wound marks that ride on the body, and a pool that spreads under the dead.
final class BloodFX {
    private let world: World
    private var decals: [SCNNode] = []
    private let maxDecals = 70

    private lazy var splatters: [SCNMaterial] = (0..<4).map { BloodFX.material(BloodFX.splatterImage(seed: $0, streaked: false)) }
    private lazy var streaks: [SCNMaterial] = (0..<3).map { BloodFX.material(BloodFX.splatterImage(seed: 10 + $0, streaked: true)) }
    private lazy var pools: [SCNMaterial] = (0..<2).map { BloodFX.material(BloodFX.poolImage(seed: 20 + $0), roughness: 0.08) }
    private lazy var wounds: [SCNMaterial] = (0..<3).map { BloodFX.material(BloodFX.woundImage(seed: 30 + $0), roughness: 0.25) }
    private lazy var dropImage: NSImage = Game.softDisc(color: NSColor(white: 1, alpha: 1))

    init(world: World) {
        self.world = world
    }

    // MARK: Hits

    /// A round strikes flesh at `point` travelling along `dir`.
    func hit(at point: V3, direction dir: V3, normal: V3, onto part: SCNNode?, heavy: Bool, headshot: Bool) {
        let scale: Float = (heavy ? 1.4 : 1) * (headshot ? 1.3 : 1)
        // Entry: a fine back-spray and mist toward the shooter.
        spray(at: point, direction: -dir, count: 5 * scale, speed: 1.0, size: 0.006, spread: 45)
        mist(at: point, direction: -dir, size: 0.04 * CGFloat(scale))
        // Exit: the bulk of the spray carries on with the round.
        spray(at: point + dir * 0.12, direction: dir, count: 16 * scale, speed: CGFloat(2.4 * scale), size: 0.007, spread: 16)
        mist(at: point + dir * 0.15, direction: dir, size: 0.07 * CGFloat(scale))

        if let part { wound(on: part, at: point, normal: normal) }

        // Spatter on whatever is behind: a wall, a rock, or the ground.
        let reach: Float = 3.2 * scale
        if let h = world.raycast(from: point + dir * 0.1, to: point + dir * reach) {
            let size = CGFloat(0.35 + h.distance * 0.18) * CGFloat(scale)
            decal(at: h.position, normal: h.normal, size: size, material: streaks.randomElement()!, along: dir)
        }
        // Drips land on the ground just past the target.
        let drops = headshot ? 3 : 2
        for _ in 0..<drops {
            let ahead = point + dir * Float.random(in: 0.3...1.6) + V3(Float.random(in: -0.3...0.3), 0, Float.random(in: -0.3...0.3))
            if let h = world.raycast(from: V3(ahead.x, point.y + 0.5, ahead.z), to: V3(ahead.x, point.y - 3, ahead.z)) {
                decal(at: h.position, normal: h.normal, size: CGFloat.random(in: 0.18...0.42) * CGFloat(scale),
                      material: splatters.randomElement()!, along: dir)
            }
        }
    }

    /// Spreading pool under a body that has come to rest.
    func pool(at point: V3) {
        guard let h = world.raycast(from: point + V3(0, 0.8, 0), to: point - V3(0, 2, 0)) else { return }
        let node = decal(at: h.position, normal: h.normal, size: CGFloat.random(in: 1.1...1.5), material: pools.randomElement()!, along: nil)
        node.simdScale = V3(repeating: 0.12)
        let grow = SCNAction.scale(to: 1, duration: TimeInterval.random(in: 9...14))
        grow.timingMode = .easeOut
        node.runAction(grow)
    }

    // MARK: Pieces

    @discardableResult
    private func decal(at p: V3, normal n: V3, size: CGFloat, material: SCNMaterial, along dir: V3?) -> SCNNode {
        let plane = SCNPlane(width: size, height: size)
        plane.materials = [material]
        let node = SCNNode(geometry: plane)
        let normal = simd_normalize(n)
        // Face the plane's +Z along the surface normal, then spin it so streaks run with the spray.
        var q = simd_quatf(from: V3(0, 0, 1), to: normal)
        let spin: Float
        if let dir {
            let tangent = dir - normal * simd_dot(dir, normal)
            let localUp = q.act(V3(0, 1, 0))
            spin = simd_length(tangent) > 1e-3
                ? atan2(simd_dot(simd_cross(localUp, simd_normalize(tangent)), normal), simd_dot(localUp, simd_normalize(tangent)))
                : Float.random(in: 0...(2 * .pi))
        } else {
            spin = Float.random(in: 0...(2 * .pi))
        }
        q = simd_quatf(angle: spin, axis: normal) * q
        node.simdOrientation = q
        node.simdPosition = p + normal * Float.random(in: 0.012...0.02)
        node.castsShadow = false
        node.renderingOrder = 5
        world.scene.rootNode.addChildNode(node)
        decals.append(node)
        if decals.count > maxDecals {
            let old = decals.removeFirst()
            old.runAction(.sequence([.fadeOut(duration: 1), .removeFromParentNode()]))
        }
        return node
    }

    private func wound(on part: SCNNode, at p: V3, normal: V3) {
        let plane = SCNPlane(width: 0.07, height: 0.07)
        plane.materials = [wounds.randomElement()!]
        let node = SCNNode(geometry: plane)
        node.simdOrientation = simd_quatf(from: V3(0, 0, 1), to: simd_normalize(normal))
        node.simdPosition = p + simd_normalize(normal) * 0.006
        node.castsShadow = false
        node.renderingOrder = 5
        // Parent to the body part so the wound follows the death animation.
        let world = node.simdWorldTransform
        part.addChildNode(node)
        node.simdTransform = part.simdWorldTransform.inverse * world
    }

    private func spray(at p: V3, direction: V3, count: Float, speed: CGFloat, size: CGFloat, spread: CGFloat) {
        let ps = SCNParticleSystem()
        ps.loops = false
        ps.emissionDuration = 0.03
        ps.birthRate = CGFloat(count) / 0.03
        ps.particleLifeSpan = 0.5
        ps.particleLifeSpanVariation = 0.3
        ps.particleVelocity = speed
        ps.particleVelocityVariation = speed * 0.6
        ps.spreadingAngle = spread
        ps.emittingDirection = SCNVector3(direction)
        ps.acceleration = SCNVector3(0, -9.8, 0)
        ps.particleSize = size
        ps.particleSizeVariation = size * 0.6
        ps.particleColor = NSColor(calibratedRed: 0.36, green: 0.015, blue: 0.012, alpha: 1)
        ps.particleColorVariation = SCNVector4(0, 0, 0.15, 0)
        ps.particleImage = dropImage
        ps.stretchFactor = 0.006
        ps.blendMode = .alpha
        ps.isLightingEnabled = false
        let node = SCNNode()
        node.simdPosition = p
        node.addParticleSystem(ps)
        world.scene.rootNode.addChildNode(node)
        node.runAction(.sequence([.wait(duration: 1.3), .removeFromParentNode()]))
    }

    private func mist(at p: V3, direction: V3, size: CGFloat) {
        let ps = SCNParticleSystem()
        ps.loops = false
        ps.emissionDuration = 0.03
        ps.birthRate = 10 / 0.03
        ps.particleLifeSpan = 0.45
        ps.particleVelocity = 0.9
        ps.particleVelocityVariation = 0.6
        ps.spreadingAngle = 40
        ps.emittingDirection = SCNVector3(direction)
        ps.dampingFactor = 4
        ps.particleSize = size
        ps.particleColor = NSColor(calibratedRed: 0.42, green: 0.03, blue: 0.03, alpha: 0.55)
        ps.particleImage = dropImage
        ps.blendMode = .alpha
        ps.isLightingEnabled = false
        let fade = CAKeyframeAnimation()
        fade.values = [0.8, 0.35, 0.0]
        let grow = CABasicAnimation()
        grow.fromValue = size
        grow.toValue = size * 4
        ps.propertyControllers = [
            .opacity: SCNParticlePropertyController(animation: fade),
            .size: SCNParticlePropertyController(animation: grow),
        ]
        let node = SCNNode()
        node.simdPosition = p
        node.addParticleSystem(ps)
        world.scene.rootNode.addChildNode(node)
        node.runAction(.sequence([.wait(duration: 0.8), .removeFromParentNode()]))
    }

    // MARK: Materials and textures

    private static func material(_ image: NSImage, roughness: CGFloat = 0.2) -> SCNMaterial {
        // Blinn rather than PBR: a PBR surface this glossy mirrors the bright sky at low angles and
        // washes the blood out to grey. Here it stays dark, with only a small wet highlight from the sun.
        let m = SCNMaterial()
        m.lightingModel = .blinn
        m.diffuse.contents = image
        m.specular.contents = NSColor(white: 0.55 - roughness, alpha: 1)
        m.shininess = 0.9 - roughness
        m.transparencyMode = .aOne
        m.blendMode = .alpha
        m.writesToDepthBuffer = false
        m.isDoubleSided = false
        return m
    }

    /// Small deterministic generator so each texture variant is stable.
    private struct Rand {
        var s: UInt64
        mutating func next() -> CGFloat {
            s = s &* 6364136223846793005 &+ 1442695040888963407
            return CGFloat((s >> 33) & 0xFFFFFF) / CGFloat(0xFFFFFF)
        }
        mutating func range(_ a: CGFloat, _ b: CGFloat) -> CGFloat { a + (b - a) * next() }
    }

    private static func blood(_ r: inout Rand, alpha: CGFloat) -> CGColor {
        let k = r.range(0.75, 1.15)
        return NSColor(calibratedRed: 0.30 * k, green: 0.012 * k, blue: 0.012 * k, alpha: alpha).cgColor
    }

    /// Spatter: a dense core, satellite droplets thrown outward, and (if streaked) elongated runs along +Y.
    private static func splatterImage(seed: Int, streaked: Bool) -> NSImage {
        var r = Rand(s: UInt64(seed) &* 9_973 &+ 17)
        return NSImage(size: NSSize(width: 256, height: 256), flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let c = CGPoint(x: 128, y: streaked ? 92 : 128)
            // Core: overlapping blobs.
            for _ in 0..<(streaked ? 9 : 14) {
                let a = r.range(0, 2 * .pi), d = r.range(0, streaked ? 20 : 26)
                let rad = r.range(10, streaked ? 22 : 30)
                ctx.setFillColor(blood(&r, alpha: r.range(0.75, 0.95)))
                ctx.fillEllipse(in: CGRect(x: c.x + cos(a) * d - rad, y: c.y + sin(a) * d - rad, width: rad * 2, height: rad * 2))
            }
            // Thrown droplets: farther ones smaller, stretched along their flight.
            for _ in 0..<(streaked ? 70 : 55) {
                var a = r.range(0, 2 * .pi)
                if streaked { a = .pi / 2 + r.range(-0.55, 0.55) }
                let d = r.range(30, streaked ? 150 : 110)
                let size = max(1.2, r.range(2, 9) * (1 - d / 190))
                let stretch = streaked ? r.range(1.6, 4.2) : r.range(1, 1.8)
                ctx.saveGState()
                ctx.translateBy(x: c.x + cos(a) * d, y: c.y + sin(a) * d)
                ctx.rotate(by: a)
                ctx.setFillColor(blood(&r, alpha: r.range(0.7, 0.95)))
                ctx.fillEllipse(in: CGRect(x: -size * stretch, y: -size, width: size * stretch * 2, height: size * 2))
                ctx.restoreGState()
            }
            if streaked {
                // Runs: thin trails from the core outward.
                for _ in 0..<7 {
                    let x0 = c.x + r.range(-22, 22)
                    let len = r.range(40, 120)
                    let w = r.range(2, 5)
                    ctx.setFillColor(blood(&r, alpha: 0.8))
                    let path = CGMutablePath()
                    path.move(to: CGPoint(x: x0 - w, y: c.y))
                    path.addLine(to: CGPoint(x: x0 + w, y: c.y))
                    path.addLine(to: CGPoint(x: x0 + r.range(-6, 6), y: c.y + len))
                    path.closeSubpath()
                    ctx.addPath(path)
                    ctx.fillPath()
                }
            }
            return true
        }
    }

    /// Pool: a smooth irregular lobe shape, darker and denser in the middle.
    private static func poolImage(seed: Int) -> NSImage {
        var r = Rand(s: UInt64(seed) &* 7_919 &+ 3)
        return NSImage(size: NSSize(width: 256, height: 256), flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            for layer in 0..<2 {
                for _ in 0..<12 {
                    let a = r.range(0, 2 * .pi), d = r.range(0, layer == 0 ? 55 : 30)
                    let rad = r.range(layer == 0 ? 35 : 30, layer == 0 ? 62 : 48)
                    ctx.setFillColor(NSColor(calibratedRed: layer == 0 ? 0.24 : 0.14, green: 0.006, blue: 0.006, alpha: layer == 0 ? 0.55 : 0.6).cgColor)
                    ctx.fillEllipse(in: CGRect(x: 128 + cos(a) * d - rad, y: 128 + sin(a) * d - rad, width: rad * 2, height: rad * 2))
                }
            }
            return true
        }
    }

    /// Wound: a dark centre with a small ragged ring of smeared blood.
    private static func woundImage(seed: Int) -> NSImage {
        var r = Rand(s: UInt64(seed) &* 104_729 &+ 11)
        return NSImage(size: NSSize(width: 64, height: 64), flipped: false) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            for _ in 0..<10 {
                let a = r.range(0, 2 * .pi), d = r.range(2, 14)
                let rad = r.range(4, 11)
                ctx.setFillColor(blood(&r, alpha: 0.75))
                ctx.fillEllipse(in: CGRect(x: 32 + cos(a) * d - rad, y: 32 + sin(a) * d - rad, width: rad * 2, height: rad * 2))
            }
            for _ in 0..<5 {
                let a = r.range(0, 2 * .pi)
                ctx.saveGState()
                ctx.translateBy(x: 32, y: 32)
                ctx.rotate(by: a)
                ctx.setFillColor(blood(&r, alpha: 0.7))
                ctx.fillEllipse(in: CGRect(x: 6, y: -1.5, width: r.range(10, 20), height: 3))
                ctx.restoreGState()
            }
            ctx.setFillColor(NSColor(calibratedRed: 0.06, green: 0.0, blue: 0.0, alpha: 0.95).cgColor)
            ctx.fillEllipse(in: CGRect(x: 28, y: 28, width: 8, height: 8))
            return true
        }
    }
}
#endif
