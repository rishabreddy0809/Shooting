#if os(macOS)
import SceneKit
import AppKit
import Combine
import simd

// MARK: - Input

/// Raw input gathered by the view between frames.
final class InputState {
    var keys = Set<UInt16>()
    var pressed = Set<UInt16>()
    var mouseDX: Float = 0
    var mouseDY: Float = 0
    var fireDown = false
    var firePressed = false
    var adsDown = false
    var shift = false
    var scroll: Float = 0

    func endFrame() {
        pressed.removeAll()
        mouseDX = 0
        mouseDY = 0
        firePressed = false
        scroll = 0
    }
}

enum Key {
    static let a: UInt16 = 0, s: UInt16 = 1, d: UInt16 = 2, w: UInt16 = 13
    static let q: UInt16 = 12, r: UInt16 = 15, c: UInt16 = 8
    static let one: UInt16 = 18, two: UInt16 = 19, three: UInt16 = 20, four: UInt16 = 21, five: UInt16 = 23
    static let e: UInt16 = 14
    static let space: UInt16 = 49, escape: UInt16 = 53
    static let equal: UInt16 = 24, minus: UInt16 = 27
    static let g: UInt16 = 5, p: UInt16 = 35
    static let up: UInt16 = 126, down: UInt16 = 125
}

/// Render presets. The view applies anti-aliasing and frame rate; the game applies camera and shadow settings.
enum GraphicsQuality: Int, CaseIterable {
    case low, medium, high

    var label: String { ["LOW", "MEDIUM", "HIGH"][rawValue] }
    var next: GraphicsQuality { GraphicsQuality(rawValue: (rawValue + 1) % 3) ?? .medium }
    var framesPerSecond: Int { self == .high ? 120 : 60 }
    var antialiasing: SCNAntialiasingMode {
        switch self {
        case .low: return .none
        case .medium: return .multisampling2X
        case .high: return .multisampling4X
        }
    }
}

// MARK: - HUD model

enum Reticle {
    /// dot: red dot; holo: ring and dot; iron/bead: the model's own sights, nothing drawn.
    case dot, holo, iron, bead, chevron, milDot
}

/// A mark on the minimap, in world metres.
struct Blip: Equatable {
    enum Kind: Equatable { case hostile, pickup(Int) }
    let x: Float
    let z: Float
    let kind: Kind
}

struct FeedItem: Identifiable, Equatable {
    let id = UUID()
    let text: String
    let detail: String
    var age: Float = 0
}

/// Elevation to hold over the crosshair for a target at `range`, given the current zero.
struct Holdover: Equatable {
    let range: Int
    let mils: Float
}

struct HUDSnapshot: Equatable {
    enum Mode {
        case ready, playing, paused, down
    }
    var mode: Mode = .ready
    var ammo = 0
    var magSize = 0
    var reloading = false
    var health: Float = 100
    var kills = 0
    var headshots = 0
    var longest: Float = 0
    var opticName = ""
    var fireMode = ""
    var reticle: Reticle = .dot
    var ads: Float = 0
    var scoped = false
    var zoom: Float = 1
    var pxPerMil: Float = 1
    var range: Float?
    var breath: Float = 1
    var holding = false
    var shadow: CGSize = .zero
    var spread: Float = 0
    var hitAge: Float = 9
    var hitKill = false
    var damageFlash: Float = 0
    var damageAngle: Float = 0
    var feed: [FeedItem] = []
    var holdovers: [Holdover] = []
    var zeroRange = 100
    /// Wind speed in m/s, the part blowing across the line of sight (+ = toward the right), and the 300 m correction in mils.
    var windSpeed: Float = 0
    var crossWind: Float = 0
    var windHold: Float = 0
    var crouched = false
    var hostiles = 0
    var rarity = 0
    var slots: [SlotInfo?] = []
    var currentSlot = 0
    var pickupPrompt: String?
    var pickupRarity = 0
    /// Player position and heading for the minimap (quantised so an idle HUD stops publishing).
    var mapX: Float = 0
    var mapZ: Float = 0
    var mapYaw: Float = 0
    var blips: [Blip] = []
}

final class HUDState: ObservableObject {
    @Published var s = HUDSnapshot()
    /// Top-down render of the map; set once at start.
    var mapImage: NSImage?
}

private struct Bullet {
    var position: V3
    var velocity: V3
    var age: Float = 0
    let damage: Float
    let origin: V3
    /// Rifle-calibre round: bigger wound and exit spray.
    let heavy: Bool
}

// MARK: - Game

final class Game: NPCEnvironment {
    let world = World()
    let hud = HUDState()
    let cameraNode = SCNNode()
    private let camera = SCNCamera()
    private let audio: GameAudio

    // Player
    private let spawnPoint = V3(10, 12.1, 150)
    private var position: V3
    private var velocity = V3.zero
    private var yaw: Float = 0
    private var pitch: Float = -0.07
    private var grounded = true
    private var crouch: Float = 0
    private var crouching = false
    private var health: Float = 100
    private var sinceDamage: Float = 99
    private var stepDistance: Float = 0
    private var bobPhase: Float = 0
    private(set) var mode: HUDSnapshot.Mode = .ready

    // Weapons: five inventory slots, like a battle-royale loadout.
    static let slotCount = 5
    private static let startingLoadout: [Weapon?] = [Weapon(.pistol, .common), Weapon(.sniper, .rare), nil, nil, nil]
    private var slots: [Weapon?] = Game.startingLoadout
    private var current = 1
    private var scopeZoom: Float = 10
    private let weaponHolder = SCNNode()
    private var viewModels: [String: SCNNode] = [:]
    private var rifleOptics: [String: SCNNode] = [:]
    private let muzzleFlash = SCNNode()
    /// Raising a freshly selected weapon; it can't fire until this reaches zero.
    private var drawLeft: Float = 0
    private let drawTime: Float = 0.45
    private var pumpPending = false
    private var scrollAccumulator: Float = 0

    // Loot on the ground
    private var pickups: [Pickup] = []
    private let maxPickups = 40
    private var nearPickup: Pickup?
    private lazy var blood = BloodFX(world: world)
    private var ads: Float = 0
    private var adsToggle = false
    /// Seconds the assault rifle keeps its sight raised after the trigger is released.
    private var fireAimHold: Float = 0
    private var sinceShot: Float = 9
    private var reloadLeft: Float = 0
    private var boltPending = false
    private var recoil = SIMD2<Float>.zero
    private var weaponKick: Float = 0
    private var swayTime: Float = 0
    private var sway = SIMD2<Float>.zero
    private var breath: Float = 1
    private var winded = false
    private var holding = false
    private var lookDelta = SIMD2<Float>.zero

    // Ballistics
    private let muzzleVelocity: Float = 820
    private let drag: Float = 0.00055
    /// Bore elevation per weapon, so each is zeroed for its own muzzle velocity.
    private var zeroAngles: [WeaponKind: Float] = [:]
    private var zeroRange = 100
    private let zeroSteps = [100, 200, 300, 400, 500, 600]
    private var holdovers: [Holdover] = []
    /// Lateral drift per m/s of crosswind at 300 m, in mils.
    private var driftPerWind: Float = 0
    private var bullets: [Bullet] = []

    // Wind: a steady base that gusts and veers slowly.
    private let windBase: Float = Float.random(in: 1.5...5.5)
    private let windHeading: Float = Float.random(in: 0...(2 * .pi))
    private var windTime: Float = 0
    private var wind = V3.zero

    // Rendering
    private(set) var quality: GraphicsQuality = .medium
    private lazy var flashGeometry: SCNGeometry = Game.makeFlashGeometry()

    // World state
    private var npcs: [NPC] = []
    private let npcCount = 16
    private var kills = 0
    private var headshots = 0
    private var longest: Float = 0
    private var feed: [FeedItem] = []
    private var hitAge: Float = 9
    private var hitKill = false
    private var damageFlash: Float = 0
    private var damageAngle: Float = 0
    private var rangeReading: Float?
    private var rangeTimer: Float = 0
    private var hudTimer: Float = 0
    private var viewHeight: Float = 800
    private let baseFOV: Float = 62
    private lazy var puffImage: NSImage = Game.softDisc()

    var playerEye: V3 { position + V3(0, eyeHeight, 0) }
    var playerAlive: Bool { mode != .down }
    private var eyeHeight: Float { 1.68 - 0.62 * crouch }

    /// The weapon in hand. The current slot is never empty: pickups only fill or swap.
    private var weapon: Weapon {
        get { slots[current] ?? Weapon(.pistol, .common) }
        set { slots[current] = newValue }
    }
    private var spec: WeaponSpec { weapon.spec }

    init(audioEnabled: Bool = true) {
        audio = GameAudio(enabled: audioEnabled)
        position = spawnPoint
        setupCamera()
        applyQuality()
        setupWeapon()
        computeBallistics()
        updateWind(dt: 0)
        // Render the minimap before anything moves into the scene.
        hud.mapImage = world.renderMapImage()
        spawnInitialNPCs()
        spawnInitialPickups()
        placeCamera()
        pushHUD()
    }

    // MARK: Setup

    private func setupCamera() {
        camera.zNear = 0.03
        camera.zFar = 4000
        camera.fieldOfView = CGFloat(baseFOV)
        camera.wantsHDR = true
        camera.wantsExposureAdaptation = false
        camera.exposureOffset = -0.1
        camera.bloomIntensity = 0.25
        camera.bloomThreshold = 1.0
        camera.bloomBlurRadius = 8
        camera.screenSpaceAmbientOcclusionIntensity = 0.7
        camera.screenSpaceAmbientOcclusionRadius = 1.4
        camera.vignettingIntensity = 0.35
        camera.vignettingPower = 0.6
        camera.contrast = 0.12
        camera.saturation = 1.04
        camera.wantsDepthOfField = false
        cameraNode.camera = camera
        cameraNode.name = "player_camera"
        world.scene.rootNode.addChildNode(cameraNode)
    }

    /// Steps to the next graphics preset and returns it so the view can match its own settings.
    func cycleQuality() -> GraphicsQuality {
        quality = quality.next
        applyQuality()
        announce("Graphics", quality.label.capitalized)
        return quality
    }

    private func applyQuality() {
        // Full-resolution SSAO and the largest shadow maps are the most expensive passes on a Retina display.
        switch quality {
        case .low:
            camera.screenSpaceAmbientOcclusionIntensity = 0
            camera.bloomIntensity = 0
            world.setShadowQuality(mapSize: 2048, cascades: 2, samples: 2)
        case .medium:
            camera.screenSpaceAmbientOcclusionIntensity = 0
            camera.bloomIntensity = 0.25
            world.setShadowQuality(mapSize: 2048, cascades: 3, samples: 4)
        case .high:
            camera.screenSpaceAmbientOcclusionIntensity = 0.7
            camera.bloomIntensity = 0.25
            world.setShadowQuality(mapSize: 4096, cascades: 4, samples: 8)
        }
    }

    func announce(_ text: String, _ detail: String) {
        feed.append(FeedItem(text: text, detail: detail))
        if feed.count > 4 { feed.removeFirst() }
        pushHUD()
    }

    private func setupWeapon() {
        for name in WeaponSpec.modelNames {
            let model = Assets.model(name)
            model.enumerateHierarchy { node, _ in
                node.castsShadow = false
                if node.name == "fp_arms" || node.name == "reddot_lens" { node.isHidden = true }
                // Reflex and holo windows: the HUD draws the reticle, so the glass only needs to vanish.
                if name == "smg" || name == "ar", let geo = node.geometry {
                    let copy = geo.copy() as! SCNGeometry
                    copy.materials = geo.materials.map { m in
                        guard (m.name ?? "").contains("glass") else { return m }
                        let clear = m.copy() as! SCNMaterial
                        clear.transparency = 0
                        return clear
                    }
                    node.geometry = copy
                }
            }
            model.isHidden = true
            viewModels[name] = model
            weaponHolder.addChildNode(model)
        }
        if let rifle = viewModels["rifle"] {
            for name in WeaponSpec.rifleOptics {
                rifleOptics[name] = rifle.childNode(withName: name, recursively: true)
            }
        }
        cameraNode.addChildNode(weaponHolder)

        let flash = SCNPlane(width: 0.16, height: 0.16)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = NSColor.black
        m.emission.contents = Game.softDisc(color: NSColor(calibratedRed: 1, green: 0.85, blue: 0.55, alpha: 1))
        m.blendMode = .add
        m.writesToDepthBuffer = false
        m.isDoubleSided = true
        flash.materials = [m]
        muzzleFlash.geometry = flash
        muzzleFlash.simdPosition = V3(0, 0, -1.0)
        muzzleFlash.isHidden = true
        muzzleFlash.castsShadow = false
        weaponHolder.addChildNode(muzzleFlash)
        equip(current, announce: false)
    }

    /// Takes out the weapon in `slot`: shows its model, resets aim and reload, and raises it.
    private func equip(_ slot: Int, announce: Bool = true) {
        guard slots.indices.contains(slot), slots[slot] != nil else { return }
        if slot == current && announce { return }
        current = slot
        let s = spec
        for (name, node) in viewModels { node.isHidden = name != s.model }
        for (name, node) in rifleOptics { node.isHidden = name != s.optic }
        muzzleFlash.simdPosition = V3(0, 0, -s.muzzle - 0.03)
        let kind = weapon.kind
        let flashSize: CGFloat = kind == .pistol ? 0.11 : (kind == .shotgun ? 0.24 : 0.16)
        (muzzleFlash.geometry as? SCNPlane)?.width = flashSize
        (muzzleFlash.geometry as? SCNPlane)?.height = flashSize
        // The suppressor hides most of the flash.
        muzzleFlash.opacity = kind == .smg ? 0.25 : 1
        scopeZoom = max(s.zoomMin, min(s.zoomMax, scopeZoom))
        reloadLeft = 0
        boltPending = false
        pumpPending = false
        ads = 0
        adsToggle = false
        drawLeft = announce ? drawTime : 0
        if announce { audio.play("draw", volume: 0.55) }
    }

    /// Flight of the round relative to a level line of sight: height (m) and time of flight (s) at a given range.
    private func flight(angle: Float, range: Float, velocity: Float? = nil) -> (height: Float, time: Float) {
        var p = SIMD2<Float>(0, 0)
        var v = SIMD2<Float>(cos(angle), sin(angle)) * (velocity ?? muzzleVelocity)
        let dt: Float = 1.0 / 600
        var t: Float = 0
        while p.x < range && v.x > 50 {
            v.y -= 9.81 * dt
            v -= v * (drag * simd_length(v) * dt)
            p += v * dt
            t += dt
        }
        return (p.y, t)
    }

    private func computeBallistics() {
        // Zero the rifle at the dialled range, then tabulate holdovers for the reticles.
        // Short-range guns carry a fixed battle zero; the scoped rifles use the dialled one.
        for kind in WeaponKind.allCases {
            let s = WeaponSpec.of(kind)
            let zero = Float(s.fixedZero ?? zeroRange)
            var angle: Float = 0
            for _ in 0..<5 {
                angle -= atan(flight(angle: angle, range: zero, velocity: s.velocity).height / zero)
            }
            zeroAngles[kind] = angle
        }
        let zeroAngle = zeroAngles[.sniper] ?? 0
        holdovers = [200, 300, 400, 500, 600].map { r in
            let h = flight(angle: zeroAngle, range: Float(r)).height
            return Holdover(range: r, mils: max(0, -h / Float(r) * 1000))
        }
        // Crosswind drift follows the lag time: time of flight minus the time in a vacuum.
        let tof = flight(angle: zeroAngle, range: 300).time
        driftPerWind = (tof - 300 / muzzleVelocity) / 300 * 1000
    }

    private func dialZero(_ step: Int) {
        let index = (zeroSteps.firstIndex(of: zeroRange) ?? 0) + step
        guard zeroSteps.indices.contains(index) else { return }
        zeroRange = zeroSteps[index]
        computeBallistics()
        audio.play("click", volume: 0.35)
    }

    private func updateWind(dt: Float) {
        windTime += dt
        let t = windTime
        let speed = max(0, windBase * (1 + 0.35 * sin(t * 0.21) + 0.15 * sin(t * 0.83 + 1.1)))
        let heading = windHeading + 0.35 * sin(t * 0.05)
        wind = V3(sin(heading), 0, cos(heading)) * speed
    }

    // MARK: NPC spawning

    private func spawnPosition(minPlayerDistance: Float) -> V3 {
        for _ in 0..<40 {
            var x: Float, z: Float
            if Float.random(in: 0...1) < 0.6 {
                x = Float.random(in: -33...28)
                z = Float.random(in: -32...30)
            } else {
                let a = Float.random(in: 0...(2 * .pi))
                let r = Float.random(in: 45...135)
                x = cos(a) * r
                z = sin(a) * r
            }
            guard let hit = world.raycast(from: V3(x, 80, z), to: V3(x, -20, z)) else { continue }
            guard hit.tag == "terrain", hit.normal.y > 0.85 else { continue }
            let p = hit.position
            if simd_distance(p, position) < minPlayerDistance { continue }
            // Keep clear of walls so nobody starts wedged in geometry.
            let chest = p + V3(0, 1, 0)
            var clear = true
            for d in [V3(1, 0, 0), V3(-1, 0, 0), V3(0, 0, 1), V3(0, 0, -1)] where world.raycast(from: chest, to: chest + d * 0.8) != nil {
                clear = false
            }
            if clear { return p }
        }
        return V3(0, 0, 0)
    }

    private func spawnInitialNPCs() {
        // Physics queries need the static bodies registered; they are as soon as nodes join the scene.
        let sentry = NPC(at: V3(18, 6.3, -22), sentry: true)
        add(sentry)
        for _ in 0..<npcCount {
            add(NPC(at: spawnPosition(minPlayerDistance: 60)))
        }
    }

    private func add(_ npc: NPC) {
        npcs.append(npc)
        world.scene.rootNode.addChildNode(npc.root)
    }

    // MARK: Loot

    private func spawnInitialPickups() {
        // A couple at the overlook so the player has a choice from the start, the rest scattered.
        let starters: [Weapon] = [Weapon(.assaultRifle, .uncommon), Weapon(.shotgun, .common), Weapon(.smg, .common)]
        for (i, w) in starters.enumerated() {
            let a = Float(i) * 0.9 - 0.9
            let p = spawnPoint + V3(sin(a) * 3.2, 0, -cos(a) * 3.2 + 1)
            if let y = world.groundHeight(x: p.x, z: p.z, fromY: spawnPoint.y + 3, depth: 40) {
                addPickup(w, at: V3(p.x, y, p.z))
            }
        }
        for _ in 0..<16 {
            let p = spawnPosition(minPlayerDistance: 25)
            if p != .zero { addPickup(.randomLoot(), at: p) }
        }
    }

    private func addPickup(_ weapon: Weapon, at ground: V3) {
        let pickup = Pickup(weapon, at: ground)
        pickups.append(pickup)
        world.scene.rootNode.addChildNode(pickup.node)
        if pickups.count > maxPickups {
            // Retire the oldest loot nobody has touched.
            let old = pickups.removeFirst()
            old.node.runAction(.sequence([.fadeOut(duration: 0.6), .removeFromParentNode()]))
        }
    }

    /// Finds the gun the player is looking at within reach, and handles E to take it.
    private func handlePickups(input: InputState) {
        let forward = viewOrientation.act(V3(0, 0, -1))
        var best: Pickup?
        var bestScore: Float = .infinity
        for p in pickups {
            let to = p.position - playerEye
            let d = simd_length(V3(to.x, 0, to.z))
            guard d < 2.6, abs(p.position.y - position.y) < 1.6 else { continue }
            let facing = simd_dot(simd_normalize(to), forward)
            // Anything at your feet counts; farther ones need a look.
            guard d < 1.1 || facing > 0.82 else { continue }
            let score = d - facing * 1.5
            if score < bestScore { bestScore = score; best = p }
        }
        nearPickup = best
        guard let pickup = best, input.pressed.contains(Key.e) else { return }
        take(pickup)
    }

    private func take(_ pickup: Pickup) {
        guard let index = pickups.firstIndex(where: { $0 === pickup }) else { return }
        pickups.remove(at: index)
        pickup.node.removeFromParentNode()
        nearPickup = nil
        if let empty = slots.firstIndex(where: { $0 == nil }) {
            slots[empty] = pickup.weapon
            equip(empty)
        } else {
            // Full: swap with the gun in hand, which drops where the new one lay.
            let dropped = weapon
            weapon = pickup.weapon
            equip(current, announce: false)
            drawLeft = drawTime
            addPickup(dropped, at: pickup.position)
        }
        audio.play("pickup", volume: 0.7)
        announce(pickup.weapon.rarity.name, pickup.weapon.spec.name)
    }

    // MARK: Frame update

    func begin() {
        if mode == .down { respawn() }
        mode = .playing
        pushHUD()
    }

    func pause() {
        if mode == .playing { mode = .paused }
        pushHUD()
    }

    private func respawn() {
        // Back to the starting kit; anything picked up stays where you fell, for the taking.
        let kit = Game.startingLoadout.compactMap { $0 }
        let found = slots.compactMap { $0 }.filter { w in !kit.contains { $0.kind == w.kind && $0.rarity == w.rarity } }
        for (i, w) in found.enumerated() {
            let a = Float(i) * 2.1
            let p = position + V3(cos(a), 0, sin(a)) * 0.8
            let y = world.groundHeight(x: p.x, z: p.z, fromY: position.y + 1, depth: 4) ?? position.y
            addPickup(w, at: V3(p.x, y, p.z))
        }
        position = spawnPoint
        velocity = .zero
        yaw = 0
        pitch = -0.07
        health = 100
        crouching = false
        crouch = 0
        slots = Game.startingLoadout
        equip(1, announce: false)
        reloadLeft = 0
        bullets.removeAll()
        damageFlash = 0
        sinceDamage = 99
        // NPCs freeze while the player is down; without this they resume firing at the spawn point.
        for npc in npcs { npc.standDown() }
    }

    func update(dt rawDT: Float, input: InputState, viewHeight: Float) {
        let dt = min(rawDT, 0.05)
        self.viewHeight = max(viewHeight, 100)
        if mode == .playing {
            handleLook(input)
            handleMovement(dt: dt, input: input)
            handleWeapon(dt: dt, input: input)
            handlePickups(input: input)
            updateWind(dt: dt)
            updateBullets(dt: dt)
            updateNPCs(dt: dt)
            updateVitals(dt: dt)
        }
        placeCamera()
        hitAge += dt
        damageFlash = max(0, damageFlash - dt * 1.4)
        for i in feed.indices { feed[i].age += dt }
        feed.removeAll { $0.age > 5 }
        hudTimer -= dt
        if hudTimer <= 0 {
            hudTimer = 1.0 / 40
            pushHUD()
        }
        input.endFrame()
    }

    private var currentZoom: Float {
        let target = spec.zoomMax > spec.zoomMin ? scopeZoom : spec.zoomMin
        let t = ads * ads * (3 - 2 * ads)
        return 1 + (target - 1) * t
    }

    private func handleLook(_ input: InputState) {
        let sensitivity: Float = 0.0021 / currentZoom
        lookDelta = SIMD2(input.mouseDX, input.mouseDY) * sensitivity
        yaw -= lookDelta.x
        pitch -= lookDelta.y
        pitch = max(-1.45, min(1.45, pitch))
    }

    private func handleMovement(dt: Float, input: InputState) {
        if input.pressed.contains(Key.c) { crouching.toggle() }
        crouch += ((crouching ? 1 : 0) - crouch) * min(1, dt * 9)

        let forward = V3(-sin(yaw), 0, -cos(yaw))
        let right = V3(cos(yaw), 0, -sin(yaw))
        var wish = V3.zero
        if input.keys.contains(Key.w) { wish += forward }
        if input.keys.contains(Key.s) { wish -= forward }
        if input.keys.contains(Key.d) { wish += right }
        if input.keys.contains(Key.a) { wish -= right }
        let moving = simd_length_squared(wish) > 0.01
        if moving { wish = simd_normalize(wish) }
        let sprinting = input.shift && ads < 0.3 && !crouching && input.keys.contains(Key.w)
        let speed: Float = crouching ? 1.7 : (ads > 0.5 ? 1.9 : (sprinting ? 5.8 : 3.5))
        let accel: Float = grounded ? 11 : 2
        let targetVel = wish * speed
        velocity.x += (targetVel.x - velocity.x) * min(1, accel * dt)
        velocity.z += (targetVel.z - velocity.z) * min(1, accel * dt)

        var step = V3(velocity.x, 0, velocity.z) * dt
        for _ in 0..<2 {
            let len = simd_length(step)
            if len < 1e-5 { break }
            let dir = step / len
            var blocked = false
            for h in [Float(0.5), 1.0, eyeHeight - 0.15] {
                let from = position + V3(0, h, 0)
                if let hit = world.raycast(from: from, to: from + dir * (len + 0.38)), hit.normal.y < 0.65 {
                    var n = V3(hit.normal.x, 0, hit.normal.z)
                    n = simd_length(n) > 0.01 ? simd_normalize(n) : -dir
                    let into = simd_dot(step, n)
                    if into < 0 { step -= n * into }
                    if hit.distance < 0.36 { step += n * (0.36 - hit.distance) * 0.5 }
                    blocked = true
                    break
                }
            }
            if !blocked { break }
        }
        position += step
        let radius = simd_length(V3(position.x, 0, position.z))
        if radius > 202 { position *= V3(202 / radius, 1, 202 / radius) }

        let ground = world.groundHeight(x: position.x, z: position.z, fromY: position.y + 0.6, depth: 40)
        if grounded {
            if input.pressed.contains(Key.space) && !crouching {
                velocity.y = 4.4
                grounded = false
            } else if let g = ground, position.y - g < 0.45 {
                position.y += (g - position.y) * min(1, dt * 18)
            } else {
                grounded = false
                velocity.y = 0
            }
        }
        if !grounded {
            velocity.y -= 14 * dt
            position.y += velocity.y * dt
            if let g = ground, position.y <= g, velocity.y <= 0 {
                position.y = g
                grounded = true
                velocity.y = 0
                audio.play("step", volume: 0.5)
            }
        }

        let horizontal = simd_length(V3(velocity.x, 0, velocity.z))
        if grounded && horizontal > 0.5 {
            stepDistance += horizontal * dt
            bobPhase += horizontal * dt * 3.3
            if stepDistance > (sprinting ? 2.3 : 1.7) {
                stepDistance = 0
                audio.play("step", volume: crouching ? 0.12 : (sprinting ? 0.4 : 0.25))
            }
        }
    }

    private func handleWeapon(dt: Float, input: InputState) {
        for (i, key) in [Key.one, Key.two, Key.three, Key.four, Key.five].enumerated() where input.pressed.contains(key) {
            equip(i)
        }
        if input.pressed.contains(Key.q) { adsToggle.toggle() }
        if input.pressed.contains(Key.up) { dialZero(1) }
        if input.pressed.contains(Key.down) { dialZero(-1) }
        let s = spec
        let variableZoom = s.zoomMax > s.zoomMin
        if variableZoom {
            var z = scopeZoom
            if ads > 0.5 && abs(input.scroll) > 0.01 { z *= pow(1.06, input.scroll) }
            if input.pressed.contains(Key.equal) { z *= 1.35 }
            if input.pressed.contains(Key.minus) { z /= 1.35 }
            scopeZoom = max(s.zoomMin, min(s.zoomMax, z))
        }
        // The wheel cycles weapons, except while it is working a variable scope.
        if !(variableZoom && ads > 0.5) {
            scrollAccumulator += input.scroll
            if abs(scrollAccumulator) >= 1.5 {
                cycleWeapon(scrollAccumulator > 0 ? -1 : 1)
                scrollAccumulator = 0
            }
        } else {
            scrollAccumulator = 0
        }

        sinceShot += dt
        drawLeft = max(0, drawLeft - dt)
        // The assault rifle shoots from its sight: holding the trigger raises it, and it stays up a moment after.
        if weapon.kind == .assaultRifle && input.fireDown && drawLeft <= 0 { fireAimHold = 0.35 } else { fireAimHold = max(0, fireAimHold - dt) }
        let wantsADS = (input.adsDown || adsToggle || fireAimHold > 0) && (reloadLeft <= 0 || s.shellFed) && drawLeft <= 0
        let adsSpeed: Float = s.overlay ? 5.5 : 8
        ads = max(0, min(1, ads + (wantsADS ? adsSpeed : -adsSpeed) * dt))

        let reloadTime = s.reloadTime * weapon.rarity.reloadScale
        if reloadLeft > 0 {
            reloadLeft -= dt
            if reloadLeft <= 0 {
                if s.shellFed {
                    // One shell at a time; keep feeding until full.
                    weapon.ammo += 1
                    audio.play("shell", volume: 0.6)
                    if weapon.ammo < s.magSize { reloadLeft = reloadTime }
                } else {
                    weapon.ammo = s.magSize
                }
            }
        } else if input.pressed.contains(Key.r) && weapon.ammo < s.magSize && drawLeft <= 0 {
            startReload()
        }
        if boltPending && sinceShot > 0.3 {
            boltPending = false
            audio.play("bolt", volume: 0.6)
        }
        if pumpPending && sinceShot > 0.22 {
            pumpPending = false
            audio.play("pump", volume: 0.75)
        }

        let interval = 60 / s.rpm
        let trigger = s.automatic ? input.fireDown : input.firePressed
        // A shell-fed gun can interrupt its reload to fire what is already loaded.
        let canFire = drawLeft <= 0 && (reloadLeft <= 0 || (s.shellFed && weapon.ammo > 0))
        if trigger && sinceShot >= interval && canFire {
            if weapon.ammo > 0 {
                reloadLeft = 0
                fire()
            } else if input.firePressed {
                audio.play("click", volume: 0.7)
                startReload(delay: 0.15)
            }
        }

        // Breath control steadies the scope for a few seconds.
        let horizontal = simd_length(V3(velocity.x, 0, velocity.z))
        holding = input.shift && ads > 0.6 && !winded && horizontal < 0.5
        if holding {
            breath -= dt / 6
            if breath <= 0 { breath = 0; winded = true }
        } else {
            breath = min(1, breath + dt / (winded ? 5 : 3.5))
            if winded && breath > 0.45 { winded = false }
        }
        swayTime += dt * (winded ? 1.7 : 1)
        var amplitude: Float = 0.0021 * (1 - 0.5 * crouch) * (1 + horizontal * 1.4)
        if holding { amplitude *= 0.1 }
        if winded { amplitude *= 2.1 }
        amplitude *= ads
        let t = swayTime
        sway = SIMD2(
            sin(t * 0.83) + 0.45 * sin(t * 2.1 + 1.3) + 0.2 * sin(t * 4.7),
            cos(t * 0.67 + 0.5) + 0.45 * sin(t * 1.7) + 0.2 * cos(t * 5.3)
        ) * amplitude

        recoil -= recoil * min(1, dt * 7)
        weaponKick -= weaponKick * min(1, dt * 14)
        if sinceShot > 0.045 { muzzleFlash.isHidden = true }
    }

    private func startReload(delay: Double = 0) {
        let s = spec
        reloadLeft = s.reloadTime * weapon.rarity.reloadScale + (s.shellFed ? 0.25 : 0)
        audio.play(s.shellFed ? "click" : "reload", volume: 0.7, delay: delay)
    }

    private func cycleWeapon(_ step: Int) {
        let filled = slots.indices.filter { slots[$0] != nil }
        guard filled.count > 1, let at = filled.firstIndex(of: current) else { return }
        equip(filled[(at + step + filled.count) % filled.count])
    }

    /// Spread of the hip-fire cone, also drawn as the crosshair gap.
    private var hipSpread: Float {
        let moving = simd_length(V3(velocity.x, 0, velocity.z))
        return (1 - ads) * (spec.hipSpread + moving * 0.006) + (grounded ? 0 : 0.03)
    }

    private func fire() {
        let s = spec
        weapon.ammo -= 1
        sinceShot = 0
        let q = viewOrientation
        let forward = q.act(V3(0, 0, -1))
        let up = q.act(V3(0, 1, 0))
        let right = q.act(V3(1, 0, 0))
        let elevation = tan(zeroAngles[weapon.kind] ?? 0)
        // One aim error for the shot, plus each pellet's own scatter for the shotgun.
        let a = Float.random(in: 0...(2 * .pi))
        let r = hipSpread * sqrt(Float.random(in: 0...1))
        let aim = right * (cos(a) * r) + up * (sin(a) * r + elevation)
        let damage = s.damage * weapon.rarity.damageScale
        for _ in 0..<s.pellets {
            var scatter = V3.zero
            if s.pelletSpread > 0 {
                let pa = Float.random(in: 0...(2 * .pi))
                let pr = s.pelletSpread * sqrt(Float.random(in: 0...1))
                scatter = right * (cos(pa) * pr) + up * (sin(pa) * pr)
            }
            let dir = simd_normalize(forward + aim + scatter)
            let v = s.velocity * Float.random(in: 0.985...1.015)
            bullets.append(Bullet(position: playerEye, velocity: dir * v, damage: damage, origin: playerEye, heavy: s.velocity > 700))
        }

        let k = s.kick * (1 - 0.35 * crouch) * .pi / 180
        recoil += SIMD2(Float.random(in: -0.35...0.35) * k, k)
        // Part of every kick stays as muzzle climb the shooter has to pull down.
        pitch += k * 0.22
        weaponKick += 0.035 + s.kick * 0.012
        muzzleFlash.isHidden = ads > 0.8 && s.overlay
        muzzleFlash.simdEulerAngles = V3(0, 0, Float.random(in: 0...6))
        audio.play(s.sound, volume: 0.95)
        if s.action == .bolt { boltPending = true }
        if s.action == .pump { pumpPending = true }
        // The report carries: hostiles within earshot notice.
        for npc in npcs where npc.isAlive && simd_distance(npc.position, position) < s.loudness {
            npc.alert(threat: position)
        }
    }

    private var viewOrientation: simd_quatf {
        let y = simd_quatf(angle: yaw + sway.x + recoil.x, axis: V3(0, 1, 0))
        let p = simd_quatf(angle: pitch + sway.y + recoil.y, axis: V3(1, 0, 0))
        return y * p
    }

    private func placeCamera() {
        cameraNode.simdPosition = playerEye + V3(0, sin(bobPhase * 2) * 0.012 * (1 - ads), 0)
        cameraNode.simdOrientation = viewOrientation
        let half = tan(baseFOV * .pi / 360) / currentZoom
        camera.fieldOfView = CGFloat(atan(half) * 360 / .pi)

        // Weapon: hip position blends to the sight line.
        let s = spec
        let hip = s.hip
        let aim = V3(0, -s.sightHeight, -s.aimDepth)
        let t = ads * ads * (3 - 2 * ads)
        var p = hip + (aim - hip) * t
        let bob = (1 - t) * 0.006
        p += V3(cos(bobPhase) * bob, abs(sin(bobPhase)) * bob, weaponKick)
        p += V3(-lookDelta.x * 0.6, lookDelta.y * 0.6, 0) * (1 - t * 0.7)
        // Magazine changes dip the gun; shell loading only tilts it a little.
        let fullReload = s.reloadTime * weapon.rarity.reloadScale
        var lower: Float = reloadLeft > 0 ? (s.shellFed ? 0.35 : min(1, min(reloadLeft, fullReload - reloadLeft) * 5)) : 0
        // A newly drawn weapon swings up from below.
        let draw = drawLeft / drawTime
        lower = max(lower, draw * draw * 2.2)
        p += V3(0, -0.09 * lower, 0)
        // Working the pump slides the gun back briefly.
        if s.action == .pump && sinceShot > 0.18 && sinceShot < 0.5 {
            p.z += sin((sinceShot - 0.18) / 0.32 * .pi) * 0.045
        }
        weaponHolder.simdPosition = p
        weaponHolder.simdEulerAngles = V3(weaponKick * 0.9 - 0.5 * lower, (1 - t) * -0.03, lower * 0.35)
        weaponHolder.isHidden = s.overlay && ads > 0.86
    }

    // MARK: Bullets

    private func updateBullets(dt: Float) {
        var remaining: [Bullet] = []
        var bloodied = Set<ObjectIdentifier>()
        for var b in bullets {
            b.age += dt
            let start = b.position
            b.velocity.y -= 9.81 * dt
            // Drag acts on the round's speed through the air, so a crosswind carries it sideways.
            let air = b.velocity - wind
            b.velocity -= air * (drag * simd_length(air) * dt)
            let end = start + b.velocity * dt

            var nearest: Float = .infinity
            let worldHit = world.raycast(from: start, to: end)
            if let h = worldHit { nearest = h.distance }
            var struck: (npc: NPC, hit: NPCHit)?
            for npc in npcs {
                if let h = npc.hitTest(from: start, to: end) {
                    let d = simd_distance(start, h.position)
                    if d < nearest {
                        nearest = d
                        struck = (npc, h)
                    }
                }
            }
            if let s = struck {
                // Shotgun pellets arrive together: one full blood burst per target per frame.
                let first = bloodied.insert(ObjectIdentifier(s.npc)).inserted
                resolveHit(on: s.npc, hit: s.hit, bullet: b, effects: first)
            } else if let h = worldHit {
                impact(at: h.position, normal: h.normal)
            } else if b.age < 3 && end.y > -40 {
                b.position = end
                remaining.append(b)
            }
        }
        bullets = remaining
    }

    private func resolveHit(on npc: NPC, hit: NPCHit, bullet: Bullet, effects: Bool) {
        let point = hit.position
        let zone = hit.zone
        let direction = simd_normalize(bullet.velocity)
        let distance = simd_distance(bullet.origin, point)
        let killed = npc.takeHit(zone: zone, damage: bullet.damage, direction: direction)
        if effects {
            blood.hit(at: point, direction: direction, normal: hit.normal, onto: hit.part, heavy: bullet.heavy, headshot: zone == .head)
            audio.play("hit_flesh", volume: max(0.08, min(0.6, 12 / distance)), delay: Double(distance / 343))
        }
        // A kill marker from this volley isn't downgraded by a later pellet.
        hitKill = killed || (hitKill && hitAge < 0.05)
        hitAge = 0
        if effects || killed { audio.play("confirm", volume: killed ? 0.5 : 0.28) }
        if killed {
            kills += 1
            if zone == .head { headshots += 1 }
            longest = max(longest, distance)
            feed.append(FeedItem(text: zone == .head ? "Headshot" : "Target down", detail: String(format: "%.0f m", distance)))
            if feed.count > 4 { feed.removeFirst() }
        }
        for other in npcs where other.isAlive && (simd_distance(other.position, npc.position) < 42 || other.sentry) {
            other.alert(threat: position)
        }
    }

    private func impact(at point: V3, normal: V3) {
        puff(at: point, normal: normal, color: NSColor(calibratedRed: 0.62, green: 0.55, blue: 0.42, alpha: 0.7), size: 0.16, count: 22, speed: 2.6)
        let d = simd_distance(point, playerEye)
        audio.play("impact", volume: max(0.03, min(0.5, 6 / d)), delay: Double(d / 343))
        for npc in npcs where npc.isAlive && simd_distance(npc.position, point) < 14 {
            npc.alert(threat: position)
        }
    }

    // MARK: NPCs

    private func updateNPCs(dt: Float) {
        for npc in npcs { npc.update(dt: dt, env: self) }
        for (i, npc) in npcs.enumerated() where !npc.isAlive && npc.deadTime > 18 {
            npc.root.removeFromParentNode()
            let replacement = npc.sentry ? NPC(at: V3(18, 6.3, -22), sentry: true) : NPC(at: spawnPosition(minPlayerDistance: 80))
            npcs[i] = replacement
            world.scene.rootNode.addChildNode(replacement.root)
        }
    }

    func npcLanded(_ npc: NPC, impact: Float) {
        let d = simd_distance(npc.position, playerEye)
        audio.play("thud", volume: max(0.03, min(0.7, 9 / d)) * min(1, 0.4 + impact * 0.3), delay: Double(d / 343))
        // The rifle falls from his hands and can be taken.
        if let gun = npc.gunPosition {
            npc.dropGun()
            if let y = world.groundHeight(x: gun.x, z: gun.z, fromY: gun.y + 1, depth: 4) {
                addPickup(.randomLoot(), at: V3(gun.x, y, gun.z))
            }
        }
        // Bleeding out beneath the chest.
        blood.pool(at: npc.restingChest)
    }

    func npcFired(_ npc: NPC, from muzzle: V3) {
        let toPlayer = playerEye - muzzle
        let distance = simd_length(toPlayer)
        flash(at: muzzle)
        let local = cameraNode.simdConvertPosition(muzzle, from: nil)
        let pan = max(-1, min(1, local.x / max(distance, 1) * 1.5))
        // Close by you hear the whole rifle; further out the air eats the highs and the echo takes over.
        let report = distance < 40 ? "shot_ar" : distance < 120 ? "shot_mid" : "shot_far"
        let loudness = distance < 40 ? min(0.8, 9 / max(distance, 1)) : max(0.08, min(0.85, 30 / distance))
        audio.play(report, volume: loudness, delay: Double(distance / 343), pan: pan * 0.8)

        var chance = max(0.012, min(0.34, 7.5 / distance))
        if crouching { chance *= 0.6 }
        if simd_length(velocity) > 3 { chance *= 0.65 }
        if Float.random(in: 0...1) < chance {
            damage(Float.random(in: 11...19), from: muzzle)
        } else {
            if Float.random(in: 0...1) < 0.6 { audio.play("whiz", volume: 0.5, delay: Double(distance / 800), pan: Float.random(in: -0.8...0.8)) }
            let a = Float.random(in: 0...(2 * .pi))
            let r = Float.random(in: 1.2...5)
            let x = position.x + cos(a) * r, z = position.z + sin(a) * r
            if let y = world.groundHeight(x: x, z: z, fromY: position.y + 2, depth: 8) {
                impact(at: V3(x, y, z), normal: V3(0, 1, 0))
            }
        }
    }

    private func damage(_ amount: Float, from source: V3) {
        guard mode == .playing else { return }
        health -= amount
        sinceDamage = 0
        damageFlash = 1
        let d = source - position
        damageAngle = atan2(-d.x, -d.z) - yaw
        recoil += SIMD2(Float.random(in: -0.012...0.012), 0.01)
        audio.play("hurt", volume: 0.8)
        if health <= 0 {
            health = 0
            mode = .down
            pushHUD()
        }
    }

    private func updateVitals(dt: Float) {
        sinceDamage += dt
        if sinceDamage > 5 && health < 100 { health = min(100, health + dt * 6) }
        rangeTimer -= dt
        if rangeTimer <= 0 {
            rangeTimer = 0.2
            rangeReading = ads > 0.5 ? lase() : nil
        }
    }

    /// Laser rangefinder along the sight line.
    private func lase() -> Float? {
        let from = playerEye
        let to = from + viewOrientation.act(V3(0, 0, -1)) * 1500
        var best: Float?
        if let h = world.raycast(from: from, to: to) { best = h.distance }
        for npc in npcs {
            if let h = npc.hitTest(from: from, to: to) {
                let d = simd_distance(from, h.position)
                if d < (best ?? .infinity) { best = d }
            }
        }
        return best
    }

    // MARK: Effects

    private func puff(at point: V3, normal: V3, color: NSColor, size: CGFloat, count: CGFloat, speed: CGFloat) {
        let ps = SCNParticleSystem()
        ps.loops = false
        ps.emissionDuration = 0.04
        ps.birthRate = count / 0.04
        ps.particleLifeSpan = 0.8
        ps.particleLifeSpanVariation = 0.3
        ps.particleVelocity = speed
        ps.particleVelocityVariation = speed * 0.7
        ps.spreadingAngle = 38
        ps.emittingDirection = SCNVector3(normal)
        ps.acceleration = SCNVector3(0, -2.2, 0)
        ps.dampingFactor = 2
        ps.particleSize = size
        ps.particleSizeVariation = size * 0.5
        ps.particleColor = color
        ps.particleImage = puffImage
        ps.blendMode = .alpha
        ps.isLightingEnabled = false
        ps.sortingMode = .distance
        let fade = CAKeyframeAnimation()
        fade.values = [1.0, 0.7, 0.0]
        ps.propertyControllers = [
            .opacity: SCNParticlePropertyController(animation: fade),
            .size: {
                let grow = CABasicAnimation()
                grow.fromValue = size
                grow.toValue = size * 4.5
                return SCNParticlePropertyController(animation: grow)
            }(),
        ]
        let node = SCNNode()
        node.simdPosition = point + normal * 0.03
        node.addParticleSystem(ps)
        world.scene.rootNode.addChildNode(node)
        node.runAction(.sequence([.wait(duration: 1.6), .removeFromParentNode()]))
    }

    /// Shared by every enemy muzzle flash, so firing never draws or uploads a new texture.
    private static func makeFlashGeometry() -> SCNGeometry {
        let plane = SCNPlane(width: 0.5, height: 0.5)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = NSColor.black
        m.emission.contents = Game.softDisc(color: NSColor(calibratedRed: 1, green: 0.8, blue: 0.5, alpha: 1))
        m.emission.intensity = 6
        m.blendMode = .add
        m.writesToDepthBuffer = false
        plane.materials = [m]
        return plane
    }

    private func flash(at point: V3) {
        let node = SCNNode(geometry: flashGeometry)
        node.constraints = [SCNBillboardConstraint()]
        node.simdPosition = point
        node.castsShadow = false
        world.scene.rootNode.addChildNode(node)
        node.runAction(.sequence([.wait(duration: 0.07), .removeFromParentNode()]))
    }

    static func softDisc(color: NSColor = .white) -> NSImage {
        let size = NSSize(width: 64, height: 64)
        return NSImage(size: size, flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            let colors = [color.cgColor, color.withAlphaComponent(0.35).cgColor, color.withAlphaComponent(0).cgColor] as CFArray
            guard let gradient = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 0.45, 1]) else { return false }
            let c = CGPoint(x: rect.midX, y: rect.midY)
            ctx.drawRadialGradient(gradient, startCenter: c, startRadius: 0, endCenter: c, endRadius: rect.width / 2, options: [])
            return true
        }
    }

    // MARK: Debug staging

    #if DEBUG
    private var stagedNPC: NPC?

    func debugGiveAll() {
        slots = [Weapon(.pistol, .uncommon), Weapon(.smg, .rare), Weapon(.assaultRifle, .epic), Weapon(.shotgun, .legendary), Weapon(.sniper, .rare)]
        equip(current, announce: false)
    }

    func debugSelect(_ slot: Int) { equip(slot, announce: false) }

    /// Puts the nearest hostile `distance` metres ahead on the ground, facing the player.
    func debugStage(distance: Float) {
        let forward = V3(-sin(yaw), 0, -cos(yaw))
        let p = position + forward * distance
        guard let y = world.groundHeight(x: p.x, z: p.z, fromY: position.y + 20, depth: 60),
              let npc = npcs.filter(\.isAlive).min(by: { simd_distance($0.position, p) < simd_distance($1.position, p) }) else { return }
        npc.debugStage(at: V3(p.x, y, p.z), facing: position)
        stagedNPC = npc
        // Look at his chest.
        let to = npc.chest - playerEye
        pitch = atan2(to.y, simd_length(V3(to.x, 0, to.z)))
    }

    var debugPose: String { "pos \(position) yaw \(yaw) pitch \(pitch) mode \(mode)" }

    /// Stands the player `distance` m from cover site `index`, looking at it.
    func debugViewCover(_ index: Int, distance: Float) {
        let sites = world.coverSites
        guard !sites.isEmpty else { return }
        let c = sites[index % sites.count]
        let away = simd_length(c) > 1 ? -simd_normalize(c) : SIMD2<Float>(0, 1)
        let p = c + away * distance
        guard let y = world.groundHeight(x: p.x, z: p.y, fromY: 90, depth: 140) else { return }
        position = V3(p.x, y, p.y)
        velocity = .zero
        let to = c - p
        yaw = atan2(-to.x, -to.y)
        pitch = -0.12
        fputs("COVER sites \(sites.count) viewing #\(index % sites.count) at \(c)\n", stderr)
    }

    /// Fires one aimed round of the weapon in hand at the staged hostile.
    func debugShoot(head: Bool) {
        guard let npc = stagedNPC else { return }
        let target = head ? npc.headPosition : npc.chest
        let dir = simd_normalize(target - playerEye)
        let s = spec
        bullets.append(Bullet(position: playerEye, velocity: dir * s.velocity, damage: s.damage * 6, origin: playerEye, heavy: s.velocity > 700))
        audio.play(s.sound, volume: 0.95)
    }
    #endif

    // MARK: HUD

    private func pushHUD() {
        var s = HUDSnapshot()
        s.mode = mode
        let w = weapon
        let spec = w.spec
        s.ammo = w.ammo
        s.magSize = spec.magSize
        s.reloading = reloadLeft > 0
        s.health = health
        s.kills = kills
        s.headshots = headshots
        s.longest = longest
        s.opticName = spec.name
        s.fireMode = spec.fireMode
        s.reticle = spec.reticle
        s.rarity = w.rarity.rawValue
        s.ads = ads
        s.scoped = spec.overlay && ads > 0.86
        s.slots = slots.map { $0.map { SlotInfo(short: $0.spec.short, rarity: $0.rarity.rawValue, ammo: $0.ammo) } }
        s.currentSlot = current
        if let p = nearPickup {
            s.pickupPrompt = p.weapon.spec.name
            s.pickupRarity = p.weapon.rarity.rawValue
        }
        // Minimap: hostiles show close by, or at any range once they are fighting; loot within 60 m.
        s.mapX = (position.x * 4).rounded() / 4
        s.mapZ = (position.z * 4).rounded() / 4
        s.mapYaw = (yaw * 200).rounded() / 200
        var blips: [Blip] = []
        for npc in npcs where npc.isAlive {
            let d = simd_distance(npc.position, position)
            if d < 70 || (npc.isEngaged && d < 260) {
                blips.append(Blip(x: (npc.position.x * 2).rounded() / 2, z: (npc.position.z * 2).rounded() / 2, kind: .hostile))
            }
        }
        for p in pickups where simd_distance(p.position, position) < 60 {
            blips.append(Blip(x: p.position.x, z: p.position.z, kind: .pickup(p.weapon.rarity.rawValue)))
        }
        s.blips = blips
        s.zoom = currentZoom
        let fov = Float(camera.fieldOfView) * .pi / 180
        s.pxPerMil = (viewHeight / 2) / tan(fov / 2) * 0.001
        s.range = rangeReading
        s.breath = breath
        s.holding = holding
        // The exit pupil drifts as the rifle moves, shading one side of the scope picture.
        if s.scoped {
            s.shadow = CGSize(width: CGFloat(-lookDelta.x * 900 + sway.x * 9000 + recoil.x * 1500),
                              height: CGFloat(lookDelta.y * 900 + sway.y * 9000 - recoil.y * 2500))
        }
        // Values that decay forever are quantised so an idle HUD stops publishing.
        let moving = simd_length(V3(velocity.x, 0, velocity.z))
        // Crosshair gap drawn at the real cone: hip spread plus the pellet pattern, in screen pixels.
        let cone = spec.hipSpread + spec.pelletSpread + moving * 0.006 + (grounded ? 0 : 0.03)
        s.spread = max(8, cone * s.pxPerMil * 1000 + recoil.y * 600).rounded()
        s.hitAge = min(hitAge, 1)
        s.hitKill = hitKill
        s.damageFlash = damageFlash
        s.damageAngle = damageAngle
        s.feed = feed
        s.holdovers = holdovers
        s.zeroRange = zeroRange
        let right = V3(cos(yaw), 0, -sin(yaw))
        s.windSpeed = (simd_length(wind) * 10).rounded() / 10
        s.crossWind = (simd_dot(wind, right) * 10).rounded() / 10
        s.windHold = (abs(s.crossWind) * driftPerWind * 10).rounded() / 10
        s.crouched = crouching
        s.hostiles = npcs.filter(\.isAlive).count
        // Publishing re-renders the whole SwiftUI HUD; skip it when nothing visible changed.
        if s != hud.s { hud.s = s }
    }
}
#endif
