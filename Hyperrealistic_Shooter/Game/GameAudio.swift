#if os(macOS)
import AVFoundation
import AudioToolbox

/// Procedurally synthesized sound effects, so the game ships without audio files.
/// Gunshots come from `GunSynth` (stereo, several takes each); everything else is synthesized below.
final class GameAudio {
    private let engine = AVAudioEngine()
    private var players: [AVAudioPlayerNode] = []
    private var stereoPlayers: [AVAudioPlayerNode] = []
    private var buffers: [String: AVAudioPCMBuffer] = [:]
    private var gunBuffers: [String: [AVAudioPCMBuffer]] = [:]
    private var next = 0
    private var nextStereo = 0
    private let format = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 1)!
    private let stereo = AVAudioFormat(standardFormatWithSampleRate: 44100, channels: 2)!
    private var running = false

    init(enabled: Bool = true) {
        guard enabled else { return }
        // Everything is summed on a bus and run through a peak limiter, so stacked full-auto
        // reports and their echoes stay loud without clipping into fizz.
        let bus = AVAudioMixerNode()
        engine.attach(bus)
        let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
            componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_PeakLimiter,
            componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
        engine.attach(limiter)
        engine.connect(bus, to: limiter, format: stereo)
        engine.connect(limiter, to: engine.mainMixerNode, format: stereo)
        for _ in 0..<16 {
            let p = AVAudioPlayerNode()
            engine.attach(p)
            engine.connect(p, to: bus, format: format)
            players.append(p)
        }
        // Gun tails run 1.5–3 s; at 850 rpm that is a couple of dozen overlapping shots.
        for _ in 0..<28 {
            let p = AVAudioPlayerNode()
            engine.attach(p)
            engine.connect(p, to: bus, format: stereo)
            stereoPlayers.append(p)
        }
        engine.mainMixerNode.outputVolume = 0.9
        buildSounds()
        do {
            try engine.start()
            running = true
        } catch {
            print("Audio unavailable: \(error)")
        }
        // Gunshots take a moment to render; do it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            let rendered = GunSynth.renderAll(variants: 3)
            DispatchQueue.main.async { [weak self] in self?.install(rendered) }
        }
    }

    private func install(_ rendered: [(name: String, left: [Float], right: [Float])]) {
        for take in rendered {
            let count = take.left.count
            guard let buffer = AVAudioPCMBuffer(pcmFormat: stereo, frameCapacity: AVAudioFrameCount(count)) else { continue }
            buffer.frameLength = AVAudioFrameCount(count)
            take.left.withUnsafeBufferPointer { buffer.floatChannelData![0].update(from: $0.baseAddress!, count: count) }
            take.right.withUnsafeBufferPointer { buffer.floatChannelData![1].update(from: $0.baseAddress!, count: count) }
            gunBuffers[take.name, default: []].append(buffer)
        }
    }

    func play(_ name: String, volume: Float = 1, delay: Double = 0, pan: Float = 0) {
        guard running, volume > 0.004 else { return }
        let stereoTake = gunBuffers[name]?.randomElement()
        guard let buffer = stereoTake ?? buffers[name] else { return }
        let isStereo = stereoTake != nil
        // Small pitch-free level variation keeps repeated shots from sounding pasted.
        let level = isStereo ? volume * Float.random(in: 0.9...1) : volume
        let fire = { [weak self] in
            guard let self, self.engine.isRunning else { return }
            let p: AVAudioPlayerNode
            if isStereo {
                p = self.stereoPlayers[self.nextStereo]
                self.nextStereo = (self.nextStereo + 1) % self.stereoPlayers.count
            } else {
                p = self.players[self.next]
                self.next = (self.next + 1) % self.players.count
            }
            p.stop()
            p.volume = min(level, 1)
            p.pan = max(-1, min(1, pan))
            p.scheduleBuffer(buffer, at: nil, options: [], completionHandler: nil)
            p.play()
        }
        if delay > 0.01 {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: fire)
        } else {
            fire()
        }
    }

    // MARK: Synthesis

    private func make(_ name: String, seconds: Double, _ sample: (_ t: Float, _ i: Int) -> Float) {
        let count = Int(seconds * 44100)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return }
        buffer.frameLength = AVAudioFrameCount(count)
        let out = buffer.floatChannelData![0]
        var peak: Float = 0.0001
        for i in 0..<count {
            let v = sample(Float(i) / 44100, i)
            out[i] = v
            peak = max(peak, abs(v))
        }
        let gain = 0.9 / peak
        let fade = min(count, 400)
        for i in 0..<count {
            var v = out[i] * gain
            if i > count - fade { v *= Float(count - i) / Float(fade) }
            out[i] = v
        }
        buffers[name] = buffer
    }

    private func buildSounds() {
        var rng = SystemRandomNumberGenerator()
        func noise() -> Float { Float.random(in: -1...1, using: &rng) }

        var lp: Float = 0, lp2: Float = 0
        make("impact", seconds: 0.22) { t, _ in
            lp += (noise() - lp) * 0.2
            return lp * exp(-t * 30) + sin(2 * .pi * 140 * t) * exp(-t * 40) * 0.6
        }
        lp = 0
        make("hit_flesh", seconds: 0.18) { t, _ in
            lp += (noise() - lp) * 0.07
            return lp * exp(-t * 28) * 2 + sin(2 * .pi * 90 * t) * exp(-t * 35)
        }
        var phase: Float = 0
        lp = 0
        make("whiz", seconds: 0.28) { t, _ in
            let f = 2600 - 6500 * t
            phase += 2 * .pi * max(f, 500) / 44100
            lp += (noise() - lp) * 0.4
            let env = sin(.pi * min(t / 0.28, 1))
            return (sin(phase) * 0.35 + lp * 0.5) * env * env
        }
        make("click", seconds: 0.06) { t, _ in
            (sin(2 * .pi * 3100 * t) + noise() * 0.5) * exp(-t * 140)
        }
        make("bolt", seconds: 0.5) { t, _ in
            func tick(_ at: Float, _ f: Float) -> Float {
                let d = t - at
                return d > 0 ? (sin(2 * .pi * f * d) + noise() * 0.6) * exp(-d * 70) : 0
            }
            let slide = (t > 0.08 && t < 0.3) ? noise() * 0.12 : 0
            return tick(0.02, 1800) + tick(0.16, 1300) * 0.8 + tick(0.33, 2100) + slide
        }
        make("reload", seconds: 1.5) { t, _ in
            func tick(_ at: Float, _ f: Float, _ g: Float) -> Float {
                let d = t - at
                return d > 0 ? (sin(2 * .pi * f * d) + noise() * 0.7) * exp(-d * 55) * g : 0
            }
            return tick(0.05, 900, 0.8) + tick(0.55, 700, 1) + tick(0.7, 1500, 0.6) + tick(1.2, 1900, 1) + tick(1.32, 1200, 0.7)
        }
        lp = 0
        make("step", seconds: 0.14) { t, _ in
            lp += (noise() - lp) * 0.12
            return lp * exp(-t * 38)
        }
        lp = 0
        make("hurt", seconds: 0.3) { t, _ in
            lp += (noise() - lp) * 0.04
            return lp * exp(-t * 14) * 2 + sin(2 * .pi * 60 * t) * exp(-t * 16)
        }
        make("confirm", seconds: 0.09) { t, _ in
            sin(2 * .pi * 1250 * t) * exp(-t * 60)
        }

        // Pump: slide back, slide forward.
        make("pump", seconds: 0.4) { t, _ in
            func clack(_ at: Float, _ f: Float) -> Float {
                let d = t - at
                return d > 0 ? (sin(2 * .pi * f * d) + noise() * 0.8) * exp(-d * 60) : 0
            }
            let slide = (t > 0.02 && t < 0.14) || (t > 0.2 && t < 0.3) ? noise() * 0.15 : 0
            return clack(0.0, 900) * 0.7 + clack(0.14, 1300) + clack(0.31, 1700) + slide
        }
        make("shell", seconds: 0.18) { t, _ in
            let d1 = t, d2 = t - 0.07
            let a = (sin(2 * .pi * 1100 * d1) + noise() * 0.6) * exp(-d1 * 80)
            let b = d2 > 0 ? (sin(2 * .pi * 1600 * d2) + noise() * 0.4) * exp(-d2 * 90) : 0
            return a * 0.6 + b
        }
        make("pickup", seconds: 0.35) { t, _ in
            func tick(_ at: Float, _ f: Float) -> Float {
                let d = t - at
                return d > 0 ? (sin(2 * .pi * f * d) + noise() * 0.5) * exp(-d * 75) : 0
            }
            return tick(0, 700) * 0.6 + tick(0.12, 1500) + tick(0.2, 2200) * 0.7
        }
        make("draw", seconds: 0.3) { t, _ in
            let rustle = t < 0.18 ? noise() * 0.12 * sin(.pi * t / 0.18) : 0
            let d = t - 0.2
            return rustle + (d > 0 ? (sin(2 * .pi * 1900 * d) + noise() * 0.5) * exp(-d * 90) : 0)
        }
        // A body hitting the ground: heavy, soft, with gear rattle.
        lp = 0; lp2 = 0
        make("thud", seconds: 0.45) { t, _ in
            let n = noise()
            lp += (n - lp) * 0.03
            lp2 += (n - lp2) * 0.3
            let gear = t > 0.04 ? lp2 * exp(-(t - 0.04) * 30) * 0.25 : 0
            return lp * exp(-t * 12) * 3 + sin(2 * .pi * 55 * t) * exp(-t * 18) * 1.4 + gear
        }
    }
}
#endif
