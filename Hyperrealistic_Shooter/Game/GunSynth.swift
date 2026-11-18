import Foundation

/// Physically-motivated gunshot synthesis, rendered once at launch.
///
/// A real outdoor report is several overlapping events, and each one is modelled here:
/// - the supersonic bullet's N-wave crack and the muzzle's broadband transient (first few ms);
/// - the muzzle blast: hot gas venting, a band-limited roar of a few tens of ms;
/// - the low "boom" felt in the chest, a pressure pulse that drops in pitch;
/// - mechanical action (bolt carrier, slide) a few ms later, heard by the shooter;
/// - the environment: discrete slap-back echoes off nearby ground and hills, then a long
///   low-passed rolling tail. This is most of what makes a shot sound real rather than synthetic.
/// The blast is soft-clipped as real recordings are, and channels get decorrelated echoes
/// so the tail opens up in stereo.
nonisolated enum GunSynth {
    static let rate: Float = 44100

    struct Voice {
        var length: Float = 2
        /// Supersonic N-wave (rifles); 0 for subsonic rounds.
        var nwave: Float = 0
        var nwaveDuration: Float = 0.0005
        /// Bright muzzle transient.
        var transient: Float = 0.6
        var blastCutoff: Float = 2500
        var blastDecay: Float = 0.025
        var boomStart: Float = 130, boomEnd: Float = 50
        var boomDecay: Float = 0.05
        var boom: Float = 1
        /// Soft-clip drive applied to the dry report.
        var drive: Float = 3
        var mechDelay: Float = 0.03
        var mech: Float = 0
        var mechPitch: Float = 1
        /// Environment.
        var tail: Float = 0.4
        var tailLength: Float = 1.8
        var tailCutoff: Float = 1400
        var echoes: Float = 0.35
    }

    static func voice(for name: String) -> Voice? {
        var v = Voice()
        switch name {
        case "shot_pistol":
            v.length = 1.5; v.transient = 0.9; v.blastCutoff = 2800; v.blastDecay = 0.016
            v.boomStart = 170; v.boomEnd = 75; v.boomDecay = 0.03; v.boom = 0.75; v.drive = 3.2
            v.mechDelay = 0.02; v.mech = 0.16; v.mechPitch = 1.15
            v.tail = 0.3; v.tailLength = 1.2; v.tailCutoff = 1700; v.echoes = 0.3
        case "shot_smg":
            // Suppressed: the can strips the blast, leaving a cough, the bolt's clatter and a little tail.
            v.length = 0.7; v.transient = 0.12; v.blastCutoff = 850; v.blastDecay = 0.02
            v.boomStart = 140; v.boomEnd = 65; v.boomDecay = 0.022; v.boom = 0.8; v.drive = 1.8
            v.mechDelay = 0.006; v.mech = 0.5; v.mechPitch = 0.9
            v.tail = 0.08; v.tailLength = 0.45; v.tailCutoff = 900; v.echoes = 0.12
        case "shot_ar":
            v.length = 2.0; v.nwave = 1.1; v.transient = 1; v.blastCutoff = 3400; v.blastDecay = 0.028
            v.boomStart = 125; v.boomEnd = 48; v.boomDecay = 0.045; v.boom = 1.1; v.drive = 4
            v.mechDelay = 0.028; v.mech = 0.13; v.mechPitch = 1
            v.tail = 0.42; v.tailLength = 1.9; v.tailCutoff = 1500; v.echoes = 0.38
        case "shot_shotgun":
            v.length = 2.4; v.transient = 0.55; v.blastCutoff = 1600; v.blastDecay = 0.055
            v.boomStart = 95; v.boomEnd = 36; v.boomDecay = 0.1; v.boom = 1.7; v.drive = 5
            v.tail = 0.5; v.tailLength = 2.2; v.tailCutoff = 1100; v.echoes = 0.42
        case "shot":
            // Marksman rifle, full-power cartridge.
            v.length = 2.4; v.nwave = 1.3; v.transient = 1; v.blastCutoff = 2900; v.blastDecay = 0.036
            v.boomStart = 105; v.boomEnd = 42; v.boomDecay = 0.065; v.boom = 1.4; v.drive = 4.5
            v.mechDelay = 0.032; v.mech = 0.09; v.mechPitch = 0.85
            v.tail = 0.5; v.tailLength = 2.3; v.tailCutoff = 1300; v.echoes = 0.42
        case "shot_heavy":
            // Bolt-action magnum: the biggest crack and the longest roll across the valley.
            v.length = 3.0; v.nwave = 1.5; v.nwaveDuration = 0.0008; v.transient = 1; v.blastCutoff = 2500
            v.blastDecay = 0.05; v.boomStart = 85; v.boomEnd = 34; v.boomDecay = 0.09; v.boom = 1.8; v.drive = 5
            v.tail = 0.6; v.tailLength = 2.9; v.tailCutoff = 1100; v.echoes = 0.45
        case "shot_mid":
            // Someone else's rifle 40–120 m away: highs soaked up by the air, more of the valley in it.
            v.length = 2.0; v.nwave = 0.5; v.transient = 0.3; v.blastCutoff = 1500; v.blastDecay = 0.03
            v.boomStart = 110; v.boomEnd = 50; v.boomDecay = 0.05; v.boom = 0.9; v.drive = 2.5
            v.tail = 0.7; v.tailLength = 1.9; v.tailCutoff = 1000; v.echoes = 0.5
        case "shot_far":
            // Far away: a dull thump followed by the rolling echo, which carries further than the shot.
            v.length = 2.2; v.transient = 0; v.blastCutoff = 650; v.blastDecay = 0.035
            v.boomStart = 90; v.boomEnd = 45; v.boomDecay = 0.06; v.boom = 0.8; v.drive = 1.6
            v.tail = 1.0; v.tailLength = 2.1; v.tailCutoff = 650; v.echoes = 0.6
        default:
            return nil
        }
        return v
    }

    static let names = ["shot_pistol", "shot_smg", "shot_ar", "shot_shotgun", "shot", "shot_heavy", "shot_mid", "shot_far"]

    /// Every gun sound, `variants` takes each, as interleaved-free stereo pairs.
    static func renderAll(variants: Int) -> [(name: String, left: [Float], right: [Float])] {
        var out: [(String, [Float], [Float])] = []
        for name in names {
            guard let v = voice(for: name) else { continue }
            for k in 0..<variants {
                let stable = name.unicodeScalars.reduce(UInt64(5381)) { $0 &* 33 &+ UInt64($1.value) }
                let (l, r) = render(v, seed: UInt64(k + 1) &* 0x9E37_79B9 &+ stable)
                out.append((name, l, r))
            }
        }
        return out
    }

    // MARK: DSP

    struct Noise {
        var s: UInt64
        mutating func next() -> Float {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17
            return Float(Int64(bitPattern: s) >> 40) / Float(1 << 23)
        }
        mutating func range(_ a: Float, _ b: Float) -> Float { a + (b - a) * (next() * 0.5 + 0.5) }
    }

    /// RBJ biquad.
    struct Biquad {
        var b0: Float = 1, b1: Float = 0, b2: Float = 0, a1: Float = 0, a2: Float = 0
        var x1: Float = 0, x2: Float = 0, y1: Float = 0, y2: Float = 0

        static func lowpass(_ f: Float, q: Float = 0.707) -> Biquad { make(f, q, kind: 0) }
        static func highpass(_ f: Float, q: Float = 0.707) -> Biquad { make(f, q, kind: 1) }
        static func bandpass(_ f: Float, q: Float) -> Biquad { make(f, q, kind: 2) }

        private static func make(_ f: Float, _ q: Float, kind: Int) -> Biquad {
            let w = 2 * Float.pi * min(f, GunSynth.rate * 0.45) / GunSynth.rate
            let alpha = sin(w) / (2 * q), c = cos(w)
            var b = Biquad()
            let a0 = 1 + alpha
            switch kind {
            case 0: b.b0 = (1 - c) / 2; b.b1 = 1 - c; b.b2 = (1 - c) / 2
            case 1: b.b0 = (1 + c) / 2; b.b1 = -(1 + c); b.b2 = (1 + c) / 2
            default: b.b0 = alpha; b.b1 = 0; b.b2 = -alpha
            }
            b.b0 /= a0; b.b1 /= a0; b.b2 /= a0
            b.a1 = -2 * c / a0; b.a2 = (1 - alpha) / a0
            return b
        }

        mutating func run(_ x: Float) -> Float {
            let y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2
            x2 = x1; x1 = x; y2 = y1; y1 = y
            return y
        }
    }

    static func render(_ base: Voice, seed: UInt64) -> ([Float], [Float]) {
        var rng = Noise(s: seed | 1)
        // Each take differs a little, like real rounds do.
        var v = base
        v.blastCutoff *= rng.range(0.9, 1.1)
        v.blastDecay *= rng.range(0.9, 1.12)
        v.boomStart *= rng.range(0.94, 1.06)
        v.boomDecay *= rng.range(0.9, 1.1)
        v.mechDelay *= rng.range(0.92, 1.08)

        let n = Int(v.length * rate)
        // 1. Dry report (mono): transient, N-wave, blast, boom.
        var dry = [Float](repeating: 0, count: n)
        var hpT = Biquad.highpass(1800, q: 0.6)
        var lpB = Biquad.lowpass(v.blastCutoff, q: 0.9)
        var lpB2 = Biquad.lowpass(v.blastCutoff * 1.4, q: 0.6)
        var lpChest = Biquad.lowpass(180, q: 0.8)
        var phase: Float = 0
        let dryLength = min(n, Int(0.45 * rate))
        for i in 0..<dryLength {
            let t = Float(i) / rate
            let attack = 1 - exp(-t / 0.00035)
            var x: Float = 0
            // Transient: broadband snap, a few ms.
            x += hpT.run(rng.next()) * v.transient * 2.2 * attack * exp(-t / 0.0035)
            // N-wave: a sharp overpressure ramping to underpressure.
            if t < v.nwaveDuration {
                x += v.nwave * 3 * (1 - 2 * t / v.nwaveDuration)
            }
            // Muzzle blast: band-limited gas roar.
            let blastNoise = lpB2.run(lpB.run(rng.next()))
            x += blastNoise * 4.2 * attack * (exp(-t / v.blastDecay) + 0.18 * exp(-t / (v.blastDecay * 3.2)))
            // Boom: falling-pitch pressure pulse plus chest-band noise.
            let f = v.boomEnd + (v.boomStart - v.boomEnd) * exp(-t / 0.025)
            phase += 2 * .pi * f / rate
            let boomEnv = (1 - exp(-t / 0.0015)) * exp(-t / v.boomDecay)
            x += (sin(phase) * 0.9 + lpChest.run(rng.next()) * 5) * v.boom * boomEnv
            dry[i] = x
        }
        // Soft clip, as the recording chain of a real gunshot does.
        var peak: Float = 1e-6
        for i in 0..<dryLength { peak = max(peak, abs(dry[i])) }
        let norm = tanh(v.drive)
        for i in 0..<dryLength { dry[i] = tanh(dry[i] / peak * v.drive) / norm }

        // 2. Per-channel: mechanics, echoes, rolling tail.
        func channel(_ side: Float, _ r: inout Noise) -> [Float] {
            var out = dry
            // Mechanical action: a few inharmonic metal partials and a click.
            if v.mech > 0 {
                let start = Int(v.mechDelay * rate)
                let partials: [(Float, Float)] = [(2150, 0.018), (3420, 0.012), (5230, 0.008), (1280, 0.03)]
                var click = Biquad.highpass(3000)
                for i in start..<min(n, start + Int(0.12 * rate)) {
                    let t = Float(i - start) / rate
                    var m: Float = 0
                    for (f, d) in partials { m += sin(2 * .pi * f * v.mechPitch * t + side) * exp(-t / d) }
                    m += click.run(r.next()) * 2.5 * exp(-t / 0.002)
                    // Second event: the carrier slamming home.
                    let t2 = t - 0.045
                    if t2 > 0 { for (f, d) in partials { m += 0.7 * sin(2 * .pi * f * 0.93 * v.mechPitch * t2) * exp(-t2 / d) } }
                    out[i] += m * v.mech * 0.35
                }
            }
            // Slap-back echoes off the ground and hills: delayed, duller copies.
            let taps: [(Float, Float, Float)] = [
                (0.011 + 0.004 * side, 0.32, 5000),   // ground bounce
                (0.085 + 0.02 * r.next(), 0.55, 2200),
                (0.19 + 0.04 * r.next(), 0.42, 1500),
                (0.36 + 0.06 * r.next(), 0.32, 1000),
                (0.62 + 0.1 * r.next(), 0.22, 750),
                (0.95 + 0.15 * r.next(), 0.14, 600),
            ]
            for (delay, gain, cut) in taps {
                var lp = Biquad.lowpass(cut * v.tailCutoff / 1400, q: 0.6)
                let d = Int(delay * rate)
                let g = gain * v.echoes * r.range(0.8, 1.2)
                for i in 0..<dryLength where i + d < n {
                    out[i + d] += lp.run(dry[i]) * g
                }
            }
            // Rolling tail: low rumble that swells briefly and then rolls off unevenly.
            var lp1 = Biquad.lowpass(v.tailCutoff, q: 0.7), lp2 = Biquad.lowpass(v.tailCutoff * 0.8, q: 0.7)
            var hp = Biquad.highpass(70)
            let rate1 = r.range(2.5, 5), rate2 = r.range(0.7, 1.6), ph1 = r.range(0, 6.28), ph2 = r.range(0, 6.28)
            let tau = v.tailLength / 4
            for i in Int(0.02 * rate)..<n {
                let t = Float(i) / rate - 0.02
                let swell = 1 - exp(-t / 0.06)
                let roll = 0.55 + 0.3 * sin(2 * .pi * rate1 * t + ph1) + 0.15 * sin(2 * .pi * rate2 * t + ph2)
                out[i] += hp.run(lp2.run(lp1.run(r.next()))) * v.tail * 3.2 * swell * exp(-t / tau) * roll
            }
            // Clean up: no DC, gentle fade to silence.
            var dc = Biquad.highpass(28)
            let fade = Int(0.25 * rate)
            for i in 0..<n {
                out[i] = dc.run(out[i])
                if i > n - fade { out[i] *= Float(n - i) / Float(fade) }
            }
            return out
        }
        var rl = Noise(s: rng.s ^ 0xA5A5), rr = Noise(s: rng.s ^ 0x5A5A_1234)
        var left = channel(-0.4, &rl), right = channel(0.4, &rr)
        var p: Float = 1e-6
        for i in 0..<n { p = max(p, abs(left[i]), abs(right[i])) }
        let g = 0.97 / p
        for i in 0..<n { left[i] *= g; right[i] *= g }
        return (left, right)
    }
}
