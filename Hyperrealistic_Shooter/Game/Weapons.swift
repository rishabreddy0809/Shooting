#if os(macOS)
import SceneKit
import AppKit
import simd

// MARK: - Weapon catalogue

enum WeaponKind: Int, CaseIterable {
    case pistol, smg, assaultRifle, shotgun, marksman, sniper

    /// Relative odds of each kind turning up as loot.
    private static let lootWeights: [Float] = [18, 22, 28, 18, 9, 5]

    static func randomLoot() -> WeaponKind {
        var roll = Float.random(in: 0..<lootWeights.reduce(0, +))
        for (i, w) in lootWeights.enumerated() {
            if roll < w { return WeaponKind(rawValue: i)! }
            roll -= w
        }
        return .assaultRifle
    }
}

enum Rarity: Int, CaseIterable {
    case common, uncommon, rare, epic, legendary

    var name: String { ["COMMON", "UNCOMMON", "RARE", "EPIC", "LEGENDARY"][rawValue] }
    /// Display colour as sRGB components (shared by SceneKit glows and the SwiftUI HUD).
    var rgb: (r: Double, g: Double, b: Double) {
        [(0.72, 0.72, 0.70), (0.36, 0.78, 0.30), (0.25, 0.58, 0.98), (0.70, 0.36, 0.95), (1.0, 0.68, 0.18)][rawValue]
    }
    var color: NSColor { NSColor(srgbRed: rgb.r, green: rgb.g, blue: rgb.b, alpha: 1) }
    var damageScale: Float { [1, 1.06, 1.12, 1.19, 1.26][rawValue] }
    var reloadScale: Float { [1, 0.96, 0.92, 0.88, 0.84][rawValue] }

    private static let weights: [Float] = [42, 30, 17, 8, 3]

    static func roll() -> Rarity {
        var roll = Float.random(in: 0..<weights.reduce(0, +))
        for (i, w) in weights.enumerated() {
            if roll < w { return Rarity(rawValue: i)! }
            roll -= w
        }
        return .common
    }
}

enum WeaponAction {
    case none, bolt, pump
}

struct WeaponSpec {
    let name: String
    let short: String
    /// USDZ model in GameAssets; the marksman and sniper share the rifle and differ by optic.
    let model: String
    let optic: String?
    let reticle: Reticle
    let zoomMin: Float
    let zoomMax: Float
    /// Height of the sight line above the bore (the model origin), in metres.
    let sightHeight: Float
    /// How far ahead of the eye the model origin sits when aiming.
    let aimDepth: Float
    let hip: V3
    /// True when aiming replaces the weapon view with a full scope picture.
    let overlay: Bool
    let automatic: Bool
    let rpm: Float
    let damage: Float
    let pellets: Int
    /// Half-angle of the pellet cone (shotgun), in radians.
    let pelletSpread: Float
    let hipSpread: Float
    let magSize: Int
    let kick: Float
    /// Full reload time, or the time per shell for shell-fed weapons.
    let reloadTime: Float
    let shellFed: Bool
    let action: WeaponAction
    let velocity: Float
    /// Muzzle position ahead of the model origin.
    let muzzle: Float
    let sound: String
    /// Hostiles within this radius hear the shot.
    let loudness: Float
    let fireMode: String
    /// Fixed zero in metres; nil when the player dials it.
    let fixedZero: Int?

    static func of(_ kind: WeaponKind) -> WeaponSpec { table[kind.rawValue] }

    private static let table: [WeaponSpec] = [
        WeaponSpec(name: "PISTOL", short: "PISTOL", model: "pistol", optic: nil, reticle: .iron, zoomMin: 1.2, zoomMax: 1.2,
                   sightHeight: 0.026, aimDepth: 0.48, hip: V3(0.10, -0.14, -0.42), overlay: false, automatic: false,
                   rpm: 420, damage: 30, pellets: 1, pelletSpread: 0, hipSpread: 0.018, magSize: 15, kick: 0.75,
                   reloadTime: 1.6, shellFed: false, action: .none, velocity: 370, muzzle: 0.155,
                   sound: "shot_pistol", loudness: 40, fireMode: "SEMI", fixedZero: 25),
        WeaponSpec(name: "SUPPRESSED SMG", short: "SMG", model: "smg", optic: nil, reticle: .dot, zoomMin: 1.3, zoomMax: 1.3,
                   sightHeight: 0.051, aimDepth: 0.20, hip: V3(0.12, -0.16, -0.38), overlay: false, automatic: true,
                   rpm: 850, damage: 21, pellets: 1, pelletSpread: 0, hipSpread: 0.022, magSize: 30, kick: 0.32,
                   reloadTime: 2.0, shellFed: false, action: .none, velocity: 400, muzzle: 0.40,
                   sound: "shot_smg", loudness: 16, fireMode: "AUTO", fixedZero: 50),
        WeaponSpec(name: "ASSAULT RIFLE", short: "AR", model: "ar", optic: nil, reticle: .holo, zoomMin: 1.5, zoomMax: 1.5,
                   sightHeight: 0.0675, aimDepth: 0.17, hip: V3(0.12, -0.17, -0.42), overlay: false, automatic: true,
                   rpm: 680, damage: 34, pellets: 1, pelletSpread: 0, hipSpread: 0.018, magSize: 30, kick: 0.5,
                   reloadTime: 2.2, shellFed: false, action: .none, velocity: 900, muzzle: 0.60,
                   sound: "shot_ar", loudness: 50, fireMode: "AUTO", fixedZero: 100),
        WeaponSpec(name: "PUMP SHOTGUN", short: "SHOTGUN", model: "shotgun", optic: nil, reticle: .bead, zoomMin: 1.15, zoomMax: 1.15,
                   sightHeight: 0.028, aimDepth: 0.28, hip: V3(0.12, -0.16, -0.38), overlay: false, automatic: false,
                   rpm: 70, damage: 13, pellets: 9, pelletSpread: 0.042, hipSpread: 0.01, magSize: 6, kick: 2.2,
                   reloadTime: 0.48, shellFed: true, action: .pump, velocity: 400, muzzle: 0.72,
                   sound: "shot_shotgun", loudness: 55, fireMode: "PUMP", fixedZero: 25),
        WeaponSpec(name: "MARKSMAN 4×", short: "DMR", model: "rifle", optic: "optic_acog", reticle: .chevron, zoomMin: 4, zoomMax: 4,
                   sightHeight: 0.092, aimDepth: 0.12, hip: V3(0.10, -0.15, -0.33), overlay: true, automatic: false,
                   rpm: 320, damage: 52, pellets: 1, pelletSpread: 0, hipSpread: 0.016, magSize: 20, kick: 0.8,
                   reloadTime: 2.3, shellFed: false, action: .none, velocity: 820, muzzle: 0.97,
                   sound: "shot", loudness: 45, fireMode: "SEMI", fixedZero: nil),
        WeaponSpec(name: "SNIPER 6–24×", short: "SNIPER", model: "rifle", optic: "optic_sniper", reticle: .milDot, zoomMin: 6, zoomMax: 24,
                   sightHeight: 0.096, aimDepth: 0.12, hip: V3(0.10, -0.15, -0.33), overlay: true, automatic: false,
                   rpm: 46, damage: 130, pellets: 1, pelletSpread: 0, hipSpread: 0.016, magSize: 8, kick: 1.7,
                   reloadTime: 3.0, shellFed: false, action: .bolt, velocity: 820, muzzle: 0.97,
                   sound: "shot_heavy", loudness: 45, fireMode: "BOLT", fixedZero: nil),
    ]

    static let modelNames = ["pistol", "smg", "ar", "shotgun", "rifle"]
    static let rifleOptics = ["optic_reddot", "optic_acog", "optic_sniper"]
}

/// One gun in the inventory or on the ground.
struct Weapon {
    let kind: WeaponKind
    let rarity: Rarity
    var ammo: Int

    init(_ kind: WeaponKind, _ rarity: Rarity, ammo: Int? = nil) {
        self.kind = kind
        self.rarity = rarity
        self.ammo = ammo ?? WeaponSpec.of(kind).magSize
    }

    var spec: WeaponSpec { WeaponSpec.of(kind) }
    var title: String { "\(rarity.name) \(spec.name)" }

    static func randomLoot() -> Weapon { Weapon(.randomLoot(), .roll()) }
}

/// Inventory slot as the HUD shows it.
struct SlotInfo: Equatable {
    let short: String
    let rarity: Int
    let ammo: Int
}

// MARK: - Pickups

/// A gun lying in the world, marked with a rarity-coloured glow.
final class Pickup {
    let node = SCNNode()
    let weapon: Weapon
    let position: V3
    var age: Float = 0

    private static var prototypes: [String: SCNNode] = [:]
    private static var glowImages: [Int: NSImage] = [:]
    private static var beamImage: NSImage = Pickup.makeBeamImage()

    init(_ weapon: Weapon, at ground: V3, yaw: Float = .random(in: 0...(2 * .pi))) {
        self.weapon = weapon
        self.position = ground
        let spec = weapon.spec
        let gun = Pickup.prototype(spec.model).clone()
        if spec.model == "rifle" {
            for name in WeaponSpec.rifleOptics {
                gun.childNode(withName: name, recursively: true)?.isHidden = name != spec.optic
            }
        }
        // Lying on its side, a little above the grass so it doesn't sink into the slope.
        gun.simdOrientation = simd_quatf(angle: yaw, axis: V3(0, 1, 0)) * simd_quatf(angle: .pi / 2, axis: V3(0, 0, 1))
        gun.simdPosition = V3(0, 0.035, 0)
        node.addChildNode(gun)

        let glow = SCNNode(geometry: Pickup.glowPlane(weapon.rarity))
        glow.simdEulerAngles = V3(-.pi / 2, 0, 0)
        glow.simdPosition = V3(0, 0.02, 0)
        glow.castsShadow = false
        node.addChildNode(glow)

        let beamGeo = SCNPlane(width: 0.22, height: 2.4)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = NSColor.black
        m.emission.contents = Pickup.beamImage
        m.multiply.contents = weapon.rarity.color
        m.emission.intensity = 2.2
        m.blendMode = .add
        m.writesToDepthBuffer = false
        m.isDoubleSided = true
        beamGeo.materials = [m]
        let beam = SCNNode(geometry: beamGeo)
        beam.simdPosition = V3(0, 1.2, 0)
        let billboard = SCNBillboardConstraint()
        billboard.freeAxes = .Y
        beam.constraints = [billboard]
        beam.castsShadow = false
        beam.opacity = CGFloat(0.55 + 0.1 * Float(weapon.rarity.rawValue))
        node.addChildNode(beam)
        glow.runAction(.repeatForever(.sequence([.fadeOpacity(to: 0.55, duration: 1.1), .fadeOpacity(to: 1, duration: 1.1)])))

        node.simdPosition = ground
        node.name = "pickup"
    }

    private static func prototype(_ model: String) -> SCNNode {
        if let p = prototypes[model] { return p }
        let p = Assets.model(model)
        p.enumerateHierarchy { n, _ in
            if n.name == "fp_arms" || n.name == "reddot_lens" { n.isHidden = true }
        }
        prototypes[model] = p
        return p
    }

    private static func glowPlane(_ rarity: Rarity) -> SCNGeometry {
        let plane = SCNPlane(width: 1.1, height: 1.1)
        let m = SCNMaterial()
        m.lightingModel = .constant
        m.diffuse.contents = NSColor.black
        if glowImages[rarity.rawValue] == nil {
            glowImages[rarity.rawValue] = Game.softDisc(color: rarity.color)
        }
        m.emission.contents = glowImages[rarity.rawValue]
        m.blendMode = .add
        m.writesToDepthBuffer = false
        plane.materials = [m]
        return plane
    }

    /// Vertical light shaft: bright at the ground, fading upward and toward the edges.
    private static func makeBeamImage() -> NSImage {
        NSImage(size: NSSize(width: 32, height: 128), flipped: false) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            for x in 0..<32 {
                let edge = 1 - abs(CGFloat(x) - 15.5) / 16
                let colors = [NSColor(white: edge * edge, alpha: 1).cgColor, NSColor(white: 0, alpha: 1).cgColor] as CFArray
                guard let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: colors, locations: [0, 1]) else { continue }
                ctx.saveGState()
                ctx.clip(to: CGRect(x: CGFloat(x), y: 0, width: 1, height: rect.height))
                ctx.drawLinearGradient(g, start: .zero, end: CGPoint(x: 0, y: rect.height), options: [])
                ctx.restoreGState()
            }
            return true
        }
    }
}
#endif
