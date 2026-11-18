#if os(macOS)
import SceneKit
import AppKit
import simd
import Metal

typealias V3 = SIMD3<Float>

extension SCNVector3 {
    init(_ v: V3) { self.init(CGFloat(v.x), CGFloat(v.y), CGFloat(v.z)) }
    var v3: V3 { V3(Float(x), Float(y), Float(z)) }
}

/// Locates and loads the game's bundled assets (USDZ models exported from Blender, sky maps, layout).
enum Assets {
    /// Set by the offline snapshot harness; the app itself reads from its bundle.
    static var overrideDir: URL?

    static func url(_ name: String, _ ext: String) -> URL? {
        if let d = overrideDir { return d.appendingPathComponent("\(name).\(ext)") }
        return Bundle.main.url(forResource: name, withExtension: ext)
            ?? Bundle.main.url(forResource: name, withExtension: ext, subdirectory: "GameAssets")
    }

    static func model(_ name: String) -> SCNNode {
        let container = SCNNode()
        container.name = name
        guard let url = url(name, "usdz"), let scene = try? SCNScene(url: url, options: nil) else {
            print("Missing model: \(name)")
            return container
        }
        for child in scene.rootNode.childNodes { container.addChildNode(child) }
        container.enumerateHierarchy { node, _ in
            guard let geo = node.geometry else { return }
            for m in geo.materials { tune(m) }
        }
        return container
    }

    private static func tune(_ m: SCNMaterial) {
        m.lightingModel = .physicallyBased
        // Height maps from the source materials would push the drawn surface off the collision surface.
        m.displacement.contents = nil
        for p in [m.diffuse, m.normal, m.roughness, m.metalness, m.ambientOcclusion] {
            p.wrapS = .repeat
            p.wrapT = .repeat
            p.mipFilter = .linear
            p.maxAnisotropy = 8
        }
        let name = (m.name ?? "").lowercased()
        if name.contains("leaves") {
            // Alpha-tested foliage: opaque pass with discard, so leaves sort and shadow correctly.
            m.transparent.contents = nil
            m.transparency = 1
            m.isDoubleSided = true
            m.blendMode = .replace
            m.writesToDepthBuffer = true
            m.shaderModifiers = [.surface: "#pragma body\nif (_surface.diffuse.a < 0.35) { discard_fragment(); }\n_surface.diffuse.a = 1.0;"]
        } else if name.contains("glass") {
            m.transparency = 0.12
            m.blendMode = .alpha
            m.writesToDepthBuffer = false
        } else {
            m.transparent.contents = nil
            m.transparency = 1
        }
    }
}

struct RayHit {
    var position: V3
    var normal: V3
    /// What was hit: "terrain", "buildings", a prop name, or "tree".
    var tag: String
    var distance: Float
}

/// The static environment: sky, sun, terrain, buildings, and props placed from the Blender layout.
final class World {
    let scene = SCNScene()
    let staticRoot = SCNNode()
    let sun = SCNNode()
    /// Unit vector pointing from the ground toward the sun.
    static let sunDirection = simd_normalize(V3(0.718, 0.383, 0.581))
    /// Ray-cast geometry for everything static, independent of SceneKit's render-locked physics world.
    let collision = CollisionWorld()

    /// Loaded prop models and their ray-cast meshes, shared by every placed copy.
    var prototypes: [String: SCNNode] = [:]
    var propMeshes: [String: MeshBVH] = [:]
    /// Ground positions (x, z) of everything placed so far, so new cover keeps clear of it.
    private(set) var occupied: [SIMD2<Float>] = []
    /// Centres of the generated cover sites (see Cover.swift).
    var coverSites: [SIMD2<Float>] = []

    init() {
        staticRoot.name = "static"
        scene.rootNode.addChildNode(staticRoot)
        setupSky()
        setupTerrain()
        setupProps()
        setupCover()
    }

    // MARK: Sky and light

    private func setupSky() {
        if let bg = Assets.url("sky_bg", "jpg") { scene.background.contents = bg }
        if let env = Assets.url("sky_light", "hdr") { scene.lightingEnvironment.contents = env }
        scene.lightingEnvironment.intensity = 1.0
        scene.background.intensity = 1.0
        // Turn the sky half a revolution so the sun sits behind the starting overlook.
        let turn = SCNMatrix4MakeRotation(.pi, 0, 1, 0)
        scene.background.contentsTransform = turn
        scene.lightingEnvironment.contentsTransform = turn

        let light = SCNLight()
        light.type = .directional
        light.intensity = 1700
        light.temperature = 5400
        light.castsShadow = true
        light.shadowMode = .deferred
        light.shadowMapSize = CGSize(width: 4096, height: 4096)
        light.shadowCascadeCount = 4
        light.shadowCascadeSplittingFactor = 0.35
        light.maximumShadowDistance = 260
        light.automaticallyAdjustsShadowProjection = true
        light.shadowSampleCount = 8
        light.shadowRadius = 2.5
        light.shadowBias = 2
        light.shadowColor = NSColor(white: 0, alpha: 0.82)
        sun.light = light
        sun.simdPosition = World.sunDirection * 400
        sun.simdLook(at: .zero)
        scene.rootNode.addChildNode(sun)

        scene.fogColor = NSColor(calibratedRed: 0.72, green: 0.78, blue: 0.84, alpha: 1)
        scene.fogStartDistance = 120
        scene.fogEndDistance = 1500
        scene.fogDensityExponent = 1.0
    }

    /// Sun shadow cost is the biggest single knob after foliage; driven by the graphics preset.
    func setShadowQuality(mapSize: CGFloat, cascades: Int, samples: Int) {
        guard let light = sun.light else { return }
        light.shadowMapSize = CGSize(width: mapSize, height: mapSize)
        light.shadowCascadeCount = cascades
        light.shadowSampleCount = samples
    }

    /// Half the side of the square the minimap image covers, centred on the world origin.
    static let mapHalfSize: Float = 215

    /// Renders the map from straight above once, for the minimap. North (-Z) is up, +X is right.
    func renderMapImage(pixels: Int = 1024) -> NSImage? {
        guard let device = MTLCreateSystemDefaultDevice() else { return nil }
        let camera = SCNCamera()
        camera.usesOrthographicProjection = true
        camera.orthographicScale = Double(World.mapHalfSize)
        camera.zNear = 1
        camera.zFar = 400
        camera.wantsHDR = true
        camera.exposureOffset = -0.2
        let eye = SCNNode()
        eye.camera = camera
        eye.simdPosition = V3(0, 160, 0)
        eye.simdEulerAngles = V3(-.pi / 2, 0, 0)
        scene.rootNode.addChildNode(eye)
        // Fog is tuned for eye level and would wash out the whole map from above.
        let fog = (scene.fogStartDistance, scene.fogEndDistance)
        scene.fogStartDistance = 5000
        scene.fogEndDistance = 6000
        defer {
            scene.fogStartDistance = fog.0
            scene.fogEndDistance = fog.1
            eye.removeFromParentNode()
        }
        let renderer = SCNRenderer(device: device, options: nil)
        renderer.scene = scene
        renderer.pointOfView = eye
        return renderer.snapshot(atTime: 0, with: CGSize(width: pixels, height: pixels), antialiasingMode: .multisampling4X)
    }

    // MARK: Terrain and buildings

    private func setupTerrain() {
        let terrain = Assets.model("terrain")
        terrain.enumerateHierarchy { node, _ in
            guard let geo = node.geometry else { return }
            for m in geo.materials {
                // Break up the 2.5 m texture tiling with large-scale tint and brightness variation.
                m.shaderModifiers = [.surface: """
                #pragma body
                float4 wp = scn_frame.inverseViewTransform * float4(_surface.position, 1.0);
                float2 p = wp.xz;
                float n1 = sin(p.x * 0.071 + sin(p.y * 0.053) * 2.0) * cos(p.y * 0.067 + sin(p.x * 0.047) * 2.0);
                float n2 = sin(p.x * 0.013 + 1.7) * cos(p.y * 0.017 + sin(p.x * 0.009) * 3.0);
                float n3 = sin(p.x * 0.31 + sin(p.y * 0.27) * 1.5) * cos(p.y * 0.29);
                float dist = length(_surface.position);
                float3 base = mix(_surface.diffuse.rgb, float3(0.1542, 0.1173, 0.0474), smoothstep(35.0, 220.0, dist) * 0.72);
                float3 c = base * (1.0 + 0.17 * n1 + 0.20 * n2 + 0.06 * n3);
                // Sun-bleached dry grass, matched to the field in the sky panorama.
                float lum = dot(c, float3(0.3, 0.6, 0.1));
                c = mix(c, float3(lum) * float3(1.18, 1.05, 0.76), 0.38) * 1.9;
                c = mix(c, c * float3(1.08, 1.0, 0.84), clamp(n2 * 0.5 + 0.5, 0.0, 1.0));
                _surface.diffuse.rgb = c;
                """]
            }
            node.castsShadow = false
        }
        staticRoot.addChildNode(terrain)
        addCollision(terrain, tag: "terrain")

        let buildings = Assets.model("buildings")
        staticRoot.addChildNode(buildings)
        addCollision(buildings, tag: "buildings")
    }

    // MARK: Props

    private struct Placement: Decodable {
        let m: String
        let p: [Float]
        let r: Float
        let s: Float
    }

    private func setupProps() {
        guard let url = Assets.url("layout", "json"),
              let data = try? Data(contentsOf: url),
              let items = try? JSONDecoder().decode([Placement].self, from: data) else {
            print("Missing layout.json")
            return
        }
        for item in items {
            placeProp(item.m, at: V3(item.p[0], item.p[1], item.p[2]), yaw: item.r, scale: item.s)
        }
    }

    /// Adds one copy of a prop model to the level, with collision. Trees block only at the trunk.
    @discardableResult
    func placeProp(_ name: String, at position: V3, yaw: Float, scale: Float, tilt: V3 = .zero) -> SCNNode {
        let proto: SCNNode
        if let cached = prototypes[name] {
            proto = cached
        } else {
            proto = Assets.model(name)
            if name.hasPrefix("tree") {
                World.addFoliageLOD(proto)
            } else if let mesh = MeshBVH(triangles: CollisionWorld.triangles(of: proto)) {
                propMeshes[name] = mesh
            }
            prototypes[name] = proto
        }
        let node = proto.clone()
        node.name = name
        node.simdPosition = position
        node.simdOrientation = simd_quatf(angle: yaw, axis: V3(0, 1, 0))
            * simd_quatf(angle: tilt.x, axis: V3(1, 0, 0)) * simd_quatf(angle: tilt.z, axis: V3(0, 0, 1))
        node.simdScale = V3(repeating: scale)
        staticRoot.addChildNode(node)
        occupied.append(SIMD2(position.x, position.z))
        if name.hasPrefix("tree") {
            // Bullets pass through foliage; only the trunk blocks.
            collision.addTrunk(x: position.x, z: position.z, radius: 0.16 * scale, from: position.y - 0.5, to: position.y + 3.2 * scale)
        } else if let mesh = propMeshes[name] {
            collision.add(mesh, transform: node.simdWorldTransform, tag: name)
        }
        return node
    }

    private func addCollision(_ root: SCNNode, tag: String) {
        if let mesh = MeshBVH(triangles: CollisionWorld.triangles(of: root)) {
            collision.add(mesh, transform: root.simdWorldTransform, tag: tag)
        }
    }

    // MARK: Foliage LOD

    /// Each tree is ~118k alpha-tested, double-sided triangles, drawn again into every shadow cascade.
    /// Distant trees get thinned copies of the same mesh (shared vertex buffers and materials).
    private static func addFoliageLOD(_ root: SCNNode) {
        root.enumerateHierarchy { node, _ in
            guard let geo = node.geometry, geo.levelsOfDetail == nil else { return }
            let isLeaves = geo.materials.contains { ($0.name ?? "").lowercased().contains("leaves") }
            let steps: [(keep: Int, radius: CGFloat)] = isLeaves ? [(3, 150), (9, 45)] : [(2, 150), (5, 45)]
            var levels: [SCNLevelOfDetail] = []
            for step in steps {
                guard let thin = thinned(geo, keepEvery: step.keep) else { return }
                levels.append(SCNLevelOfDetail(geometry: thin, screenSpaceRadius: step.radius))
            }
            geo.levelsOfDetail = levels
        }
    }

    /// Copy of `geo` that keeps one triangle pair in every `keepEvery` (leaf cards are quads).
    private static func thinned(_ geo: SCNGeometry, keepEvery: Int) -> SCNGeometry? {
        var elements: [SCNGeometryElement] = []
        for el in geo.elements {
            guard el.primitiveType == .triangles, el.bytesPerIndex == 2 || el.bytesPerIndex == 4 else { return nil }
            let width = el.bytesPerIndex
            let count = el.primitiveCount
            guard el.data.count >= count * 3 * width else { return nil }
            var out = Data()
            out.reserveCapacity(el.data.count / keepEvery + 3 * width)
            el.data.withUnsafeBytes { raw in
                for t in 0..<count where (t / 2) % keepEvery == 0 {
                    out.append(contentsOf: raw[(t * 3 * width)..<((t + 1) * 3 * width)])
                }
            }
            elements.append(SCNGeometryElement(data: out, primitiveType: .triangles,
                                               primitiveCount: out.count / (3 * width), bytesPerIndex: width))
        }
        let thin = SCNGeometry(sources: geo.sources, elements: elements)
        thin.materials = geo.materials
        return thin
    }

    // MARK: Queries

    /// Closest hit against the static world along a segment.
    func raycast(from a: V3, to b: V3) -> RayHit? {
        guard let h = collision.raycast(from: a, to: b) else { return nil }
        let pos = a + (b - a) * h.t
        return RayHit(position: pos, normal: h.normal, tag: h.tag, distance: simd_distance(a, pos))
    }

    /// Height of the walkable surface under a point, searching downward from `fromY`.
    func groundHeight(x: Float, z: Float, fromY: Float, depth: Float = 60) -> Float? {
        raycast(from: V3(x, fromY, z), to: V3(x, fromY - depth, z))?.position.y
    }

    func lineOfSight(from a: V3, to b: V3) -> Bool {
        raycast(from: a, to: b) == nil
    }
}

extension SIMD4 where Scalar == Float {
    var xyz: SIMD3<Float> { SIMD3(x, y, z) }
}
#endif
