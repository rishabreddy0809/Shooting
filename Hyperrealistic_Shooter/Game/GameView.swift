#if os(macOS)
import SwiftUI
import SceneKit
import AppKit
import Combine

#if DEBUG
/// Counts frames SceneKit actually draws (on its render thread), for the perf log.
final class RenderCounter: NSObject, SCNSceneRendererDelegate {
    nonisolated(unsafe) private static var frames = 0
    nonisolated static func take() -> Int { defer { frames = 0 }; return frames }
    nonisolated func renderer(_ renderer: any SCNSceneRenderer, didRenderScene scene: SCNScene, atTime time: TimeInterval) {
        RenderCounter.frames += 1
    }
}
#endif

/// SceneKit view that captures mouse and keyboard and drives the game loop from the display link.
final class GameSCNView: SCNView {
    #if DEBUG
    private let renderCounter = RenderCounter()
    #endif
    let game: Game
    let input = InputState()
    private var link: CADisplayLink?
    private var lastTime: CFTimeInterval = 0
    private(set) var captured = false
    /// Control-click aim is tracked separately so releasing fire doesn't drop right-click aim.
    private var controlAim = false

    init(game: Game) {
        self.game = game
        super.init(frame: NSRect(x: 0, y: 0, width: 1280, height: 720), options: nil)
        scene = game.world.scene
        pointOfView = game.cameraNode
        rendersContinuously = true
        applyQuality(game.quality)
        allowsCameraControl = false
        backgroundColor = .black
        isPlaying = true
        #if DEBUG
        if ProcessInfo.processInfo.environment["RIDGELINE_PERF"] != nil { delegate = renderCounter }
        #endif
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not supported") }

    override var acceptsFirstResponder: Bool { true }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        link?.invalidate()
        link = nil
        guard let window else { release(); return }
        window.acceptsMouseMovedEvents = true
        window.makeFirstResponder(self)
        let l = displayLink(target: self, selector: #selector(tick(_:)))
        l.add(to: .main, forMode: .common)
        link = l
        NotificationCenter.default.removeObserver(self, name: NSWindow.didResignKeyNotification, object: nil)
        NotificationCenter.default.addObserver(self, selector: #selector(lostFocus), name: NSWindow.didResignKeyNotification, object: window)
    }

    @objc private func tick(_ link: CADisplayLink) {
        let now = link.timestamp
        let dt = lastTime == 0 ? 1.0 / 60 : now - lastTime
        lastTime = now
        #if DEBUG
        runDemo(dt: dt)
        let t0 = CACurrentMediaTime()
        #endif
        game.update(dt: Float(dt), input: input, viewHeight: Float(bounds.height))
        if game.mode == .down && captured { release() }
        #if DEBUG
        perf(update: CACurrentMediaTime() - t0, dt: dt)
        #endif
    }

    #if DEBUG
    private var perfTicks = 0
    private var perfUpdate: Double = 0
    private var perfWorst: Double = 0
    private var perfClock: Double = 0

    /// RIDGELINE_PERF=1: every two seconds, log the game-loop rate, update cost and worst frame gap.
    private func perf(update: Double, dt: Double) {
        guard ProcessInfo.processInfo.environment["RIDGELINE_PERF"] != nil else { return }
        perfTicks += 1
        perfUpdate += update
        perfWorst = max(perfWorst, dt)
        perfClock += dt
        if perfClock >= 2 {
            let frames = RenderCounter.take()
            fputs(String(format: "PERF loop %.1f fps  render %.1f fps  update %.2f ms  worst gap %.1f ms\n",
                         Double(perfTicks) / perfClock, Double(frames) / perfClock,
                         perfUpdate / Double(perfTicks) * 1000, perfWorst * 1000), stderr)
            perfTicks = 0; perfUpdate = 0; perfWorst = 0; perfClock = 0
        }
    }
    #endif

    private func applyQuality(_ q: GraphicsQuality) {
        antialiasingMode = q.antialiasing
        preferredFramesPerSecond = q.framesPerSecond
    }

    #if DEBUG
    private var demoTime: Double = 0
    private var demoShot = false
    private var demoSnapped = false

    /// Screenshot aid, driven by RIDGELINE_DEMO="slot=3,ads=1,stage=14,shoot=1.5,head=0":
    /// starts playing with every gun, selects a slot, optionally aims, and can stage a hostile and shoot him.
    private func runDemo(dt: Double) {
        guard let spec = ProcessInfo.processInfo.environment["RIDGELINE_DEMO"] else { return }
        var opts: [String: Double] = [:]
        for part in spec.split(separator: ",") {
            let kv = part.split(separator: "=")
            if kv.count == 2, let v = Double(kv[1]) { opts[String(kv[0])] = v }
        }
        if game.mode == .ready {
            game.begin()
            game.debugGiveAll()
            game.debugSelect(Int(opts["slot"] ?? 1) - 1)
            if let d = opts["stage"] { game.debugStage(distance: Float(d)) }
            if let c = opts["cover"] { game.debugViewCover(Int(c), distance: Float(opts["dist"] ?? 9)) }
        }
        demoTime += dt
        if (opts["ads"] ?? 0) > 0 { input.adsDown = true }
        if let t = opts["fire"] { input.fireDown = demoTime > t && demoTime < t + (opts["firefor"] ?? 1.2) }
        if let t = opts["snap"], demoTime > t, !demoSnapped, let path = ProcessInfo.processInfo.environment["RIDGELINE_SNAP"] {
            demoSnapped = true
            fputs("POSE \(game.debugPose)\n", stderr)
            if let tiff = snapshot().tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
               let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.85]) {
                // The sandboxed app cannot write where tools can read, so the image goes out through the log.
                fputs("SNAPB64 \(jpg.base64EncodedString())\n", stderr)
            }
        }
        if let t = opts["shoot"], demoTime > t, !demoShot {
            demoShot = true
            game.debugShoot(head: (opts["head"] ?? 0) > 0)
        }
    }
    #endif

    @objc private func lostFocus() {
        if captured { release(); game.pause() }
    }

    // MARK: Cursor capture

    private func capture() {
        guard !captured else { return }
        captured = true
        CGAssociateMouseAndMouseCursorPosition(0)
        NSCursor.hide()
        input.keys.removeAll()
        game.begin()
    }

    private func release() {
        guard captured else { return }
        captured = false
        CGAssociateMouseAndMouseCursorPosition(1)
        NSCursor.unhide()
        input.keys.removeAll()
        input.fireDown = false
        input.adsDown = false
        controlAim = false
    }

    // MARK: Events

    override func keyDown(with event: NSEvent) {
        if event.keyCode == Key.escape {
            if captured { release(); game.pause() }
            return
        }
        // Settings keys work whether or not the cursor is captured.
        if !event.isARepeat && event.keyCode == Key.g { applyQuality(game.cycleQuality()); return }
        if !event.isARepeat && event.keyCode == Key.p { showsStatistics.toggle(); return }
        guard captured else {
            if event.keyCode == 36 || event.keyCode == Key.space { capture() }
            return
        }
        if !event.isARepeat { input.pressed.insert(event.keyCode) }
        input.keys.insert(event.keyCode)
    }

    override func keyUp(with event: NSEvent) {
        input.keys.remove(event.keyCode)
    }

    override func flagsChanged(with event: NSEvent) {
        input.shift = event.modifierFlags.contains(.shift)
    }

    override func mouseDown(with event: NSEvent) {
        window?.makeFirstResponder(self)
        guard captured else { capture(); return }
        // Control-click doubles as aim for single-button trackpads.
        if event.modifierFlags.contains(.control) { input.adsDown = true; controlAim = true; return }
        input.fireDown = true
        input.firePressed = true
    }

    override func mouseUp(with event: NSEvent) {
        input.fireDown = false
        if controlAim { input.adsDown = false; controlAim = false }
    }

    override func rightMouseDown(with event: NSEvent) {
        guard captured else { return }
        input.adsDown = true
    }

    override func rightMouseUp(with event: NSEvent) {
        input.adsDown = false
    }

    private func look(_ event: NSEvent) {
        guard captured else { return }
        input.mouseDX += Float(event.deltaX)
        input.mouseDY += Float(event.deltaY)
    }

    override func mouseMoved(with event: NSEvent) { look(event) }
    override func mouseDragged(with event: NSEvent) { look(event) }
    override func rightMouseDragged(with event: NSEvent) { look(event) }

    override func scrollWheel(with event: NSEvent) {
        guard captured else { return }
        let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaY * 0.08 : event.scrollingDeltaY
        input.scroll += Float(delta)
    }
}

struct GameViewRepresentable: NSViewRepresentable {
    let game: Game

    func makeNSView(context: Context) -> GameSCNView { GameSCNView(game: game) }
    func updateNSView(_ nsView: GameSCNView, context: Context) {}
}

/// Owns the game for the lifetime of the window.
final class GameHolder: ObservableObject {
    let game = Game()
}

struct GameScreen: View {
    @StateObject private var holder = GameHolder()

    var body: some View {
        ZStack {
            GameViewRepresentable(game: holder.game)
            // The HUD shares the 3D view's full frame so reticles sit exactly on the camera axis.
            HUDView(hud: holder.game.hud)
                .allowsHitTesting(false)
        }
        .ignoresSafeArea()
        .background(Color.black.ignoresSafeArea())
        .frame(minWidth: 1100, minHeight: 680)
    }
}
#endif
