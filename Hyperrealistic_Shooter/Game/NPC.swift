#if os(macOS)
import SceneKit
import AppKit
import simd

/// What an NPC needs from the game each frame.
protocol NPCEnvironment: AnyObject {
    var world: World { get }
    var playerEye: V3 { get }
    var playerAlive: Bool { get }
    func npcFired(_ npc: NPC, from muzzle: V3)
    /// The body has hit the ground: thud, drop the gun, start the pool.
    func npcLanded(_ npc: NPC, impact: Float)
}

struct NPCHit {
    let position: V3
    let zone: HitZone
    let normal: V3
    let part: SCNNode
}

enum HitZone {
    case head, body, limb
}

/// A jointed soldier figure animated procedurally: patrols, scatters when shot at, then returns fire.
final class NPC {
    enum State {
        case idle, patrol, scatter, engage, dead
    }

    let root = SCNNode()
    private let pivot = SCNNode()
    private var joints: [String: SCNNode] = [:]
    private let gunRest: V3

    private(set) var state: State = .idle
    private(set) var health: Float = 100
    var position: V3
    private var yaw: Float
    private var home: V3
    private var target: V3
    private var speed: Float = 0
    private var phase = Float.random(in: 0...6)
    private var timer = Float.random(in: 0.5...4)
    private var probeTimer: Float = 0
    private var fireTimer = Float.random(in: 1...3)
    private var burstLeft = 0
    private var burstTimer: Float = 0
    private var engageTimer: Float = 0
    private var aim: Float = 0
    private(set) var deadTime: Float = 0
    private var fallDirection: Float = 1
    private var hasSight = false
    /// Last angles written to each joint (degrees), so the death simulation starts from the live pose.
    private var angles: [String: V3] = [:]

    // Death simulation: the body topples about the feet like an inverted pendulum while the knees
    // buckle, and the limbs follow on loose springs so they lag, flail and flop on impact.
    private struct Limb { var angle: V3; var velocity: V3; var rest: V3 }
    private var limbs: [String: Limb] = [:]
    private var tilt: Float = 0
    private var tiltVelocity: Float = 0
    private var groundTilt: Float = .pi / 2
    private var roll: Float = 0
    private var rollTarget: Float = 0
    private var knee: Float = 0
    private var kneeTarget: Float = 0
    private var kneeRate: Float = 3
    private var bounces = 0
    private var landed = false
    private var groundChecked = false
    private var flinch = V3.zero
    private(set) var gunDropped = false
    private var sightTimer: Float = 0
    let sentry: Bool
    let scale: Float

    var isAlive: Bool { state != .dead }
    /// Actively fighting: shows on the minimap at any range.
    var isEngaged: Bool { state == .engage || state == .scatter }
    var chest: V3 { position + V3(0, 1.2 * scale, 0) }
    var headPosition: V3 { position + V3(0, 1.62 * scale, 0) }

    private static let prototype: SCNNode = Assets.model("npc")
    private static let jointNames: Set<String> = [
        "pelvis", "torso", "head", "upperarm_L", "forearm_L", "upperarm_R", "forearm_R",
        "thigh_L", "shin_L", "thigh_R", "shin_R", "npcgun",
    ]

    private static let outfits: [(shirt: NSColor, pants: NSColor, vest: NSColor, helmet: NSColor)] = [
        (NSColor(srgbRed: 0.27, green: 0.30, blue: 0.19, alpha: 1), NSColor(srgbRed: 0.24, green: 0.25, blue: 0.17, alpha: 1), NSColor(srgbRed: 0.15, green: 0.15, blue: 0.11, alpha: 1), NSColor(srgbRed: 0.20, green: 0.23, blue: 0.15, alpha: 1)),
        (NSColor(srgbRed: 0.50, green: 0.42, blue: 0.30, alpha: 1), NSColor(srgbRed: 0.44, green: 0.37, blue: 0.27, alpha: 1), NSColor(srgbRed: 0.30, green: 0.25, blue: 0.17, alpha: 1), NSColor(srgbRed: 0.42, green: 0.36, blue: 0.26, alpha: 1)),
        (NSColor(srgbRed: 0.16, green: 0.17, blue: 0.19, alpha: 1), NSColor(srgbRed: 0.13, green: 0.14, blue: 0.16, alpha: 1), NSColor(srgbRed: 0.08, green: 0.08, blue: 0.09, alpha: 1), NSColor(srgbRed: 0.10, green: 0.10, blue: 0.11, alpha: 1)),
        (NSColor(srgbRed: 0.36, green: 0.33, blue: 0.25, alpha: 1), NSColor(srgbRed: 0.21, green: 0.24, blue: 0.17, alpha: 1), NSColor(srgbRed: 0.22, green: 0.20, blue: 0.14, alpha: 1), NSColor(srgbRed: 0.25, green: 0.27, blue: 0.18, alpha: 1)),
        (NSColor(srgbRed: 0.30, green: 0.22, blue: 0.17, alpha: 1), NSColor(srgbRed: 0.18, green: 0.20, blue: 0.24, alpha: 1), NSColor(srgbRed: 0.17, green: 0.18, blue: 0.13, alpha: 1), NSColor(srgbRed: 0.33, green: 0.30, blue: 0.22, alpha: 1)),
    ]
    private static let skins: [NSColor] = [
        NSColor(srgbRed: 0.78, green: 0.60, blue: 0.48, alpha: 1), NSColor(srgbRed: 0.62, green: 0.44, blue: 0.33, alpha: 1),
        NSColor(srgbRed: 0.45, green: 0.31, blue: 0.23, alpha: 1), NSColor(srgbRed: 0.30, green: 0.21, blue: 0.16, alpha: 1),
    ]

    init(at position: V3, sentry: Bool = false) {
        self.position = position
        self.home = position
        self.target = position
        self.sentry = sentry
        self.yaw = Float.random(in: 0...(2 * .pi))
        self.scale = Float.random(in: 0.95...1.06)

        let model = NPC.prototype.clone()
        let outfit = NPC.outfits.randomElement()!
        let skin = NPC.skins.randomElement()!
        var found: [String: SCNNode] = [:]
        model.enumerateHierarchy { node, _ in
            if let name = node.name, NPC.jointNames.contains(name), found[name] == nil {
                found[name] = node
            }
            guard let geo = node.geometry?.copy() as? SCNGeometry else { return }
            geo.materials = geo.materials.map { original in
                let m = original.copy() as! SCNMaterial
                switch m.name ?? "" {
                case let n where n.contains("shirt"): m.diffuse.contents = outfit.shirt
                case let n where n.contains("pants"): m.diffuse.contents = outfit.pants
                case let n where n.contains("vest"): m.diffuse.contents = outfit.vest
                case let n where n.contains("pack"): m.diffuse.contents = outfit.vest.blended(withFraction: 0.35, of: outfit.shirt) ?? outfit.vest
                case let n where n.contains("helmet"): m.diffuse.contents = outfit.helmet
                case let n where n.contains("skin"): m.diffuse.contents = skin
                default: break
                }
                return m
            }
            node.geometry = geo
        }
        joints = found
        gunRest = found["npcgun"]?.simdPosition ?? .zero
        pivot.addChildNode(model)
        root.addChildNode(pivot)
        root.simdScale = V3(repeating: scale)
        root.name = "npc"
        if sentry { state = .engage; engageTimer = 0 }
        apply()
        pose(dt: 0)
    }

    // MARK: Behaviour

    func update(dt: Float, env: NPCEnvironment) {
        if state == .dead {
            deadTime += dt
            simulateDeath(dt: dt, env: env)
            return
        }
        flinch *= exp(-9 * dt)
        let toPlayer = env.playerEye - headPosition
        let distance = simd_length(toPlayer)

        // Periodic sight check; a close, visible player draws attention.
        sightTimer -= dt
        if sightTimer <= 0 {
            sightTimer = Float.random(in: 0.35...0.6)
            hasSight = env.playerAlive && distance < 330 && env.world.lineOfSight(from: headPosition, to: env.playerEye)
            // Sentries idle in .engage with no timer, so refresh the timer rather than only switching state.
            if hasSight && distance < 55 && state != .scatter {
                state = .engage
                engageTimer = max(engageTimer, 20)
            }
        }

        switch state {
        case .idle:
            speed = 0
            timer -= dt
            yaw += sin(phase * 0.3) * 0.25 * dt
            phase += dt
            if timer <= 0 { pickWaypoint(radius: 26) ; state = .patrol }
        case .patrol:
            speed = 1.35
            if move(dt: dt, env: env) {
                state = .idle
                timer = Float.random(in: 2...7)
            }
        case .scatter:
            speed = 4.4
            timer -= dt
            if move(dt: dt, env: env) || timer <= 0 {
                state = .engage
                fireTimer = Float.random(in: 0.4...1.4)
            }
        case .engage:
            engageTimer -= dt
            if engageTimer <= 0 || !env.playerAlive {
                if !sentry {
                    state = .idle
                    timer = Float.random(in: 1...3)
                    home = position
                }
            }
            let desired = atan2(-toPlayer.x, -toPlayer.z)
            yaw = turn(yaw, toward: desired, maxStep: 5 * dt)
            let advancing = !sentry && (!hasSight || distance > 140) && distance > 30
            if advancing {
                speed = 2.8
                target = position + simd_normalize(V3(toPlayer.x, 0, toPlayer.z)) * 6
                _ = move(dt: dt, env: env, faceTravel: false)
            } else {
                speed = 0
            }
            if burstLeft > 0 {
                burstTimer -= dt
                if burstTimer <= 0 {
                    burstLeft -= 1
                    burstTimer = 0.11
                    env.npcFired(self, from: muzzle)
                }
            } else {
                fireTimer -= dt
                if fireTimer <= 0 && hasSight && aim > 0.8 && engageTimer > 0 {
                    burstLeft = Int.random(in: 1...3)
                    burstTimer = 0
                    fireTimer = Float.random(in: 1.4...3.2)
                }
            }
        case .dead:
            break
        }
        apply()
        pose(dt: dt)
    }

    /// Called when the player respawns so nobody keeps firing at the new spawn point.
    func standDown() {
        guard state != .dead else { return }
        burstLeft = 0
        engageTimer = 0
        if !sentry {
            state = .idle
            timer = Float.random(in: 1...4)
            home = position
        }
    }

    /// Called when a round lands close by or a comrade is hit.
    func alert(threat: V3) {
        guard state != .dead else { return }
        engageTimer = Float.random(in: 22...34)
        if sentry { return }
        if state == .engage || state == .scatter { return }
        let away = simd_normalize(V3(position.x - threat.x, 0, position.z - threat.z) + V3(Float.random(in: -1...1), 0, Float.random(in: -1...1)) * 0.8)
        target = position + away * Float.random(in: 5...12)
        state = .scatter
        timer = Float.random(in: 1.2...2.6)
    }

    private func pickWaypoint(radius: Float) {
        let a = Float.random(in: 0...(2 * .pi))
        let r = Float.random(in: 5...radius)
        target = home + V3(cos(a), 0, sin(a)) * r
        let limit: Float = 190
        if simd_length(V3(target.x, 0, target.z)) > limit { target = home }
    }

    /// Steps toward the current target. Returns true on arrival or when blocked.
    private func move(dt: Float, env: NPCEnvironment, faceTravel: Bool = true) -> Bool {
        var d = target - position
        d.y = 0
        let dist = simd_length(d)
        if dist < 0.6 { return true }
        let dir = d / dist
        if faceTravel { yaw = turn(yaw, toward: atan2(-dir.x, -dir.z), maxStep: 6 * dt) }

        probeTimer -= dt
        if probeTimer <= 0 {
            probeTimer = 0.2
            let from = position + V3(0, 0.8, 0)
            if let hit = env.world.raycast(from: from, to: from + dir * 1.6), hit.normal.y < 0.6 {
                if state == .patrol { pickWaypoint(radius: 20) } else {
                    let side = simd_cross(dir, V3(0, 1, 0)) * (Bool.random() ? 1 : -1)
                    target = position + side * 5 + dir * 1.5
                }
                return state == .patrol ? false : true
            }
        }
        let next = position + dir * speed * dt
        guard let ground = env.world.groundHeight(x: next.x, z: next.z, fromY: position.y + 1.1, depth: 4) else { return true }
        if ground - position.y > 0.55 { return true }
        position = V3(next.x, ground, next.z)
        phase += speed * dt * (speed > 3 ? 2.1 : 3.4)
        return false
    }

    private func turn(_ current: Float, toward desired: Float, maxStep: Float) -> Float {
        var delta = (desired - current).truncatingRemainder(dividingBy: 2 * .pi)
        if delta > .pi { delta -= 2 * .pi }
        if delta < -.pi { delta += 2 * .pi }
        return current + max(-maxStep, min(maxStep, delta))
    }

    private var muzzle: V3 {
        if let gun = joints["npcgun"] {
            return gun.simdConvertPosition(V3(0, 0.72, 0.01), to: nil)
        }
        return chest
    }

    // MARK: Damage

    /// Tests a world-space segment against this figure's body parts.
    func hitTest(from a: V3, to b: V3) -> NPCHit? {
        guard state != .dead else { return nil }
        // Cheap reject: closest approach of the segment to the torso.
        let ab = b - a
        let t = max(0, min(1, simd_dot(chest - a, ab) / max(simd_length_squared(ab), 1e-6)))
        if simd_distance(a + ab * t, chest) > 1.6 { return nil }

        let la = root.simdConvertPosition(a, from: nil)
        let lb = root.simdConvertPosition(b, from: nil)
        let results = root.hitTestWithSegment(from: SCNVector3(la), to: SCNVector3(lb), options: [
            SCNHitTestOption.searchMode.rawValue: SCNHitTestSearchMode.closest.rawValue,
            SCNHitTestOption.backFaceCulling.rawValue: false,
        ])
        guard let r = results.first else { return nil }
        var node: SCNNode? = r.node
        var part = "torso"
        while let n = node {
            if let name = n.name, NPC.jointNames.contains(name) { part = name; break }
            node = n.parent
        }
        let zone: HitZone
        switch part {
        case "head": zone = .head
        case "torso", "pelvis": zone = .body
        default: zone = .limb
        }
        return NPCHit(position: r.worldCoordinates.v3, zone: zone, normal: r.worldNormal.v3, part: r.node)
    }

    /// World position of the carried rifle, while it is still in hand.
    var gunPosition: V3? {
        guard !gunDropped, let gun = joints["npcgun"] else { return nil }
        return gun.simdConvertPosition(V3(0, 0.35, 0), to: nil)
    }

    #if DEBUG
    /// Test staging: stand still at `p`, facing `target`.
    func debugStage(at p: V3, facing target: V3) {
        position = p
        home = p
        yaw = atan2(-(target.x - p.x), -(target.z - p.z))
        state = .idle
        timer = 999
        apply()
        pose(dt: 0)
    }
    #endif

    /// Where the chest ends up once the body is down.
    var restingChest: V3 {
        position + V3(sin(yaw), 0, cos(yaw)) * fallDirection * 0.6 * scale
    }

    func dropGun() {
        gunDropped = true
        joints["npcgun"]?.isHidden = true
    }

    /// Applies damage; returns true if this hit was fatal.
    func takeHit(zone: HitZone, damage: Float, direction: V3) -> Bool {
        guard state != .dead else { return false }
        let multiplier: Float
        switch zone {
        case .head: multiplier = 5
        case .body: multiplier = 1
        case .limb: multiplier = 0.55
        }
        health -= damage * multiplier
        let facing = V3(-sin(yaw), 0, -cos(yaw))
        let right = V3(cos(yaw), 0, -sin(yaw))
        let fromFront = simd_dot(facing, direction) < 0
        let side = simd_dot(direction, right)
        if health <= 0 {
            die(zone: zone, damage: damage * multiplier, fromFront: fromFront, side: side)
            return true
        }
        // Survivable hit: a sharp jolt away from the round.
        let jolt = min(1.6, 0.5 + damage / 40)
        flinch += V3((fromFront ? -11 : 9) * jolt, 0, -side * 10 * jolt)
        if zone == .head { flinch.x += fromFront ? -10 : 8 }
        return false
    }

    private func die(zone: HitZone, damage: Float, fromFront: Bool, side: Float) {
        state = .dead
        deadTime = 0
        burstLeft = 0
        // Shot from the front falls backward (+1); from behind, forward (-1). Heavy shots sometimes
        // drop a man forward anyway as his legs go.
        fallDirection = fromFront ? 1 : -1
        if zone == .head || Float.random(in: 0...1) < 0.2 {
            // Instant loss of control: the knees fold first and the body crumples onto them.
            kneeTarget = Float.random(in: 0.75...1)
            kneeRate = Float.random(in: 5...7)
            tiltVelocity = Float.random(in: 0.2...0.6)
            if Float.random(in: 0...1) < 0.45 { fallDirection = -fallDirection }
        } else {
            // Torso hit: the round's momentum and the stagger start the fall.
            kneeTarget = Float.random(in: 0.25...0.65)
            kneeRate = Float.random(in: 2...3.5)
            tiltVelocity = min(2.8, 0.7 + damage / 55) * Float.random(in: 0.8...1.2)
        }
        rollTarget = max(-0.7, min(0.7, side * 0.8 * fallDirection)) + Float.random(in: -0.3...0.3)
        tilt = 0.02
        roll = 0
        knee = 0
        bounces = 0
        landed = false
        groundChecked = false

        // Each limb starts from its live pose and heads for a random slack resting pose.
        func start(_ name: String, rest: V3) {
            limbs[name] = Limb(angle: angles[name] ?? .zero, velocity: .zero, rest: rest)
        }
        // Arms come to rest on the ground: lying on the back "forward" is the sky, face down it is the dirt,
        // so the forward swing stays small either way and the spread goes out to the sides.
        let lift: ClosedRange<Float> = fallDirection > 0 ? (-15)...25 : (-35)...5
        start("upperarm_L", rest: V3(.random(in: lift), 0, .random(in: (-85)...(-25))))
        start("upperarm_R", rest: V3(.random(in: lift), 0, .random(in: 25...85)))
        start("forearm_L", rest: V3(.random(in: 5...55), 0, 0))
        start("forearm_R", rest: V3(.random(in: 5...55), 0, 0))
        start("head", rest: V3(.random(in: (-25)...25), .random(in: (-30)...30), .random(in: (-30)...30)))
        start("torso", rest: V3(.random(in: (-6)...8), 0, .random(in: (-10)...10)))
    }

    /// Advances the fall. Physics in body space: tilt is the lean about the feet, roll the turn onto a side.
    private func simulateDeath(dt: Float, env: NPCEnvironment) {
        guard dt > 0 else { return }
        if !groundChecked {
            groundChecked = true
            // Lie along the slope: find the ground where the head will land.
            let away = V3(sin(yaw), 0, cos(yaw)) * fallDirection
            let probe = position + away * 1.3
            if let g = env.world.groundHeight(x: probe.x, z: probe.z, fromY: position.y + 2.5, depth: 6) {
                let slope = atan2(g - position.y, 1.3)
                groundTilt = max(1.05, min(1.95, .pi / 2 - slope - 0.04))
            }
        }

        // Knees fold toward their target; a folded body is shorter and falls faster.
        knee += (kneeTarget - knee) * min(1, dt * kneeRate)
        let length: Float = 0.95 * (1 - 0.4 * knee)
        if !landed || abs(tiltVelocity) > 0.01 {
            tiltVelocity += (9.81 / length) * sin(max(tilt, 0.02)) * dt
            tiltVelocity *= exp(-0.4 * dt)
            tilt += tiltVelocity * dt
        }
        if tilt >= groundTilt {
            tilt = groundTilt
            let impact = tiltVelocity
            if !landed {
                landed = true
                env.npcLanded(self, impact: impact)
                // Legs settle out straighter once the weight is off them.
                kneeTarget = min(kneeTarget, Float.random(in: 0.04...0.2))
                kneeRate = 2.5
            }
            if impact > 0.9 && bounces < 2 {
                bounces += 1
                tiltVelocity = -impact * 0.2
                // The landing throws the slack limbs.
                for (name, var limb) in limbs {
                    limb.velocity += V3(.random(in: -1...1), .random(in: -0.4...0.4), .random(in: -1...1)) * impact * 160
                    limbs[name] = limb
                }
            } else {
                tiltVelocity = 0
            }
        }
        let progress = max(0, min(1, tilt / groundTilt))
        roll += (rollTarget * progress * progress - roll) * min(1, dt * 6)

        // Loose springs: limbs lag the body's rotation, then sag to rest once down.
        let lag = fallDirection * tiltVelocity * 9
        for (name, var limb) in limbs {
            var target = limb.rest * (landed ? 1 : 0.35 + 0.65 * progress)
            if name.hasPrefix("upperarm") { target.x += lag }
            if name == "head" { target.x -= lag * 0.6 }
            let stiffness: Float = name == "torso" ? 90 : 38
            limb.velocity += ((target - limb.angle) * stiffness - limb.velocity * 7) * dt
            limb.angle += limb.velocity * dt
            limbs[name] = limb
            set(name, limb.angle.x, limb.angle.y, limb.angle.z)
        }
        // Knees: hips flex forward while the shins fold back.
        let k = knee * 70
        set("thigh_L", k + 4, 0, -6)
        set("thigh_R", k * 0.85 - 2, 0, 8)
        set("shin_L", -k * 1.7)
        set("shin_R", -k * 1.5)

        // Folding the legs shortens the figure, so pull it down along its own axis to keep the feet
        // on the ground, and lift it by half the body depth as it comes to lie flat.
        let q = simd_quatf(angle: fallDirection * tilt, axis: V3(1, 0, 0)) * simd_quatf(angle: roll, axis: V3(0, 1, 0))
        pivot.simdOrientation = q
        let legs: Float = 0.9 * (1 - cos(knee * 70 * .pi / 180))
        var offset = q.act(V3(0, -legs, 0)) + V3(0, 0.11 * sin(tilt), 0)
        // Sink out of sight shortly before the body is recycled.
        if deadTime > 14 { offset.y -= (deadTime - 14) * 0.25 }
        pivot.simdPosition = offset
    }

    // MARK: Pose

    private func apply() {
        root.simdPosition = position
        root.simdEulerAngles = V3(0, yaw, 0)
    }

    private func set(_ joint: String, _ x: Float, _ y: Float = 0, _ z: Float = 0) {
        angles[joint] = V3(x, y, z)
        guard let node = joints[joint] else { return }
        let r = Float.pi / 180
        let q = simd_quatf(angle: z * r, axis: V3(0, 0, 1)) * simd_quatf(angle: y * r, axis: V3(0, 1, 0)) * simd_quatf(angle: x * r, axis: V3(1, 0, 0))
        node.simdOrientation = q
    }

    private func pose(dt: Float) {
        guard state != .dead else { return }
        pivot.simdEulerAngles = .zero
        let moving = speed > 0.1
        let running = speed > 3
        let amp: Float = moving ? (running ? 46 : 27) : 0
        let knee: Float = running ? 75 : 42
        let s = sin(phase), c = cos(phase)
        set("thigh_L", amp * s + (running ? 8 : 0))
        set("thigh_R", -amp * s + (running ? 8 : 0))
        set("shin_L", moving ? -(8 + knee * max(0, c)) : 0)
        set("shin_R", moving ? -(8 + knee * max(0, -c)) : 0)
        pivot.simdPosition = V3(0, moving ? abs(s) * (running ? 0.05 : 0.025) - 0.02 : 0, 0)

        let wantAim: Float = state == .engage ? 1 : 0
        aim += (wantAim - aim) * min(1, dt * 6)
        if dt == 0 { aim = wantAim }
        let a = aim
        set("torso", (running ? 10 : 2) + 2 * a + flinch.x, 0, (moving ? 3 * s : 0) + flinch.z)
        set("head", (running ? -6 : 0) + flinch.x * 0.8, 0, flinch.z * 0.6)
        // Low-ready carry blends into a shouldered aim.
        set("upperarm_R", 30 + 38 * a, 0, -12)
        set("forearm_R", 78 - 30 * a, 0, 38 - 10 * a)
        set("upperarm_L", 52 + 26 * a, 0, 22)
        set("forearm_L", 46 - 22 * a, 0, -42 + 12 * a)
        if let gun = joints["npcgun"] {
            gun.simdPosition = gunRest + V3(-0.03 * a, 0.02 * a, 0.13 * a)
            let r = Float.pi / 180
            gun.simdOrientation = simd_quatf(angle: (-14 * (1 - a) + (burstLeft > 0 ? 3 : 0)) * r, axis: V3(1, 0, 0))
        }
    }
}
#endif
