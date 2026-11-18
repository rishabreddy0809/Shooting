#if os(macOS)
import SwiftUI

private let ink = Color(red: 0.95, green: 0.93, blue: 0.87)
private let dim = Color(red: 0.95, green: 0.93, blue: 0.87).opacity(0.55)

private func label(_ size: CGFloat, _ weight: Font.Weight = .medium) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
}

struct HUDView: View {
    @ObservedObject var hud: HUDState

    var body: some View {
        let s = hud.s
        ZStack {
            if s.scoped {
                ScopeOverlay(s: s)
            } else if s.mode == .playing {
                if (s.reticle == .dot || s.reticle == .holo) && s.ads > 0.9 {
                    ZStack {
                        Circle()
                            .fill(Color(red: 1, green: 0.16, blue: 0.1))
                            .frame(width: 4, height: 4)
                        if s.reticle == .holo {
                            // Holographic: 65 MOA ring around a 1 MOA dot.
                            Circle()
                                .stroke(Color(red: 1, green: 0.2, blue: 0.12), lineWidth: 1.4)
                                .frame(width: 58, height: 58)
                        }
                    }
                    .shadow(color: Color(red: 1, green: 0.1, blue: 0.05).opacity(0.9), radius: 3)
                } else if s.ads < 0.35 {
                    Crosshair(gap: CGFloat(s.spread))
                        .opacity(Double(1 - s.ads * 2.5))
                }
            }
            if s.hitAge < 0.35 {
                HitMarker()
                    .stroke(s.hitKill ? Color(red: 0.95, green: 0.3, blue: 0.2) : ink, lineWidth: s.hitKill ? 2.2 : 1.5)
                    .frame(width: 26, height: 26)
                    .opacity(Double(1 - s.hitAge / 0.35))
            }
            DamageLayer(s: s)
            if s.mode == .playing || s.mode == .paused {
                StatusLayer(s: s, map: hud.mapImage)
            }
            if s.mode == .playing, let name = s.pickupPrompt {
                PickupPrompt(name: name, rarity: s.pickupRarity)
                    .offset(y: 150)
            }
            switch s.mode {
            case .ready:
                Card(title: "RIDGELINE", subtitle: "Long-range overwatch above a hostile outpost",
                     prompt: "Click to deploy", showControls: true)
            case .paused:
                Card(title: "PAUSED", subtitle: nil, prompt: "Click to resume", showControls: true)
            case .down:
                Card(title: "YOU ARE DOWN",
                     subtitle: "\(s.kills) hostiles down · \(s.headshots) headshots · longest \(Int(s.longest)) m",
                     prompt: "Click to redeploy", showControls: false)
            case .playing:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Hip-fire crosshair and hit marker

private struct Crosshair: View {
    let gap: CGFloat

    var body: some View {
        Canvas { ctx, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let len: CGFloat = 7
            var p = Path()
            for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
                p.move(to: CGPoint(x: c.x + dx * gap, y: c.y + dy * gap))
                p.addLine(to: CGPoint(x: c.x + dx * (gap + len), y: c.y + dy * (gap + len)))
            }
            ctx.stroke(p, with: .color(.black.opacity(0.5)), lineWidth: 3)
            ctx.stroke(p, with: .color(ink.opacity(0.9)), lineWidth: 1.2)
            ctx.fill(Path(ellipseIn: CGRect(x: c.x - 1, y: c.y - 1, width: 2, height: 2)), with: .color(ink.opacity(0.8)))
        }
    }
}

private struct HitMarker: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let inner: CGFloat = 0.28, outer: CGFloat = 0.5
        for (sx, sy) in [(1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
            p.move(to: CGPoint(x: rect.midX + sx * rect.width * inner, y: rect.midY + sy * rect.height * inner))
            p.addLine(to: CGPoint(x: rect.midX + sx * rect.width * outer, y: rect.midY + sy * rect.height * outer))
        }
        return p
    }
}

// MARK: - Scope picture

private struct ScopeOverlay: View {
    let s: HUDSnapshot

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            let radius = min(size.width, size.height) * 0.47
            ZStack {
                Canvas { ctx, size in
                    draw(ctx: &ctx, size: size, radius: radius)
                }
                readouts
                    .frame(width: max(120, size.width / 2 - radius - 36), alignment: .leading)
                    .position(x: max(80, (size.width / 2 - radius) / 2), y: size.height / 2)
            }
        }
    }

    private var readouts: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(s.opticName).font(label(10, .semibold)).foregroundStyle(dim)
            Text(String(format: "%.1f×", s.zoom)).font(label(22, .regular)).foregroundStyle(ink)
            Rectangle().fill(dim.opacity(0.4)).frame(width: 64, height: 1)
            row("RANGE", s.range.map { String(format: "%.0f m", $0) } ?? "— m")
            row("ZERO", "\(s.zeroRange) m  ↑↓")
            Rectangle().fill(dim.opacity(0.4)).frame(width: 64, height: 1)
            Text("HOLD").font(label(9, .semibold)).foregroundStyle(dim)
            ForEach(s.holdovers, id: \.range) { h in
                row("\(h.range) m", String(format: "%.1f mil", h.mils))
            }
            Rectangle().fill(dim.opacity(0.4)).frame(width: 64, height: 1)
            row("WIND", String(format: "%.1f m/s", s.windSpeed))
            // Hold into the wind: a crosswind toward the right needs the reticle moved left.
            row("CROSS", abs(s.crossWind) < 0.3 ? "—" : (s.crossWind > 0 ? "← " : "→ ") + String(format: "%.1f mil", s.windHold))
            Rectangle().fill(dim.opacity(0.4)).frame(width: 64, height: 1)
            Text(s.holding ? "HOLDING" : "BREATH").font(label(9, .semibold)).foregroundStyle(s.holding ? ink : dim)
            ZStack(alignment: .leading) {
                Rectangle().fill(dim.opacity(0.25)).frame(width: 64, height: 2)
                Rectangle().fill(s.breath < 0.3 ? Color(red: 0.9, green: 0.35, blue: 0.25) : ink)
                    .frame(width: 64 * CGFloat(s.breath), height: 2)
            }
        }
    }

    private func row(_ name: String, _ value: String) -> some View {
        HStack(spacing: 8) {
            Text(name).font(label(9, .semibold)).foregroundStyle(dim).frame(width: 44, alignment: .leading)
            Text(value).font(label(11)).foregroundStyle(ink)
        }
    }

    private func draw(ctx: inout GraphicsContext, size: CGSize, radius R: CGFloat) {
        let c = CGPoint(x: size.width / 2, y: size.height / 2)
        let circle = Path(ellipseIn: CGRect(x: c.x - R, y: c.y - R, width: 2 * R, height: 2 * R))

        var inner = ctx
        inner.clip(to: circle)
        switch s.reticle {
        case .milDot: drawMilReticle(&inner, c: c, R: R)
        case .chevron: drawChevron(&inner, c: c, R: R)
        case .dot, .holo, .iron, .bead: break
        }
        // Scope shadow: the dark edge of the eyebox, sliding as the rifle moves.
        let limit = R * 0.2
        let off = CGPoint(x: max(-limit, min(limit, s.shadow.width)), y: max(-limit, min(limit, s.shadow.height)))
        let shadow = Gradient(stops: [
            .init(color: .clear, location: 0),
            .init(color: .clear, location: 0.74),
            .init(color: .black.opacity(0.45), location: 0.88),
            .init(color: .black, location: 0.985),
        ])
        inner.fill(Path(CGRect(origin: .zero, size: size)),
                   with: .radialGradient(shadow, center: CGPoint(x: c.x + off.x, y: c.y + off.y), startRadius: 0, endRadius: R * 1.03))
        // A faint cool cast toward the lens edge.
        let tint = Gradient(stops: [
            .init(color: .clear, location: 0.55),
            .init(color: Color(red: 0.2, green: 0.3, blue: 0.45).opacity(0.10), location: 1),
        ])
        inner.fill(circle, with: .radialGradient(tint, center: c, startRadius: 0, endRadius: R))

        var outside = Path(CGRect(origin: .zero, size: size))
        outside.addPath(circle)
        ctx.fill(outside, with: .color(.black), style: FillStyle(eoFill: true))
        ctx.stroke(circle, with: .color(Color(white: 0.09)), lineWidth: 3)
    }

    private func drawMilReticle(_ ctx: inout GraphicsContext, c: CGPoint, R: CGFloat) {
        let p = CGFloat(s.pxPerMil)
        let line = Color.black.opacity(0.92)
        let gap = max(3, p * 0.3)
        var fine = Path()
        var heavy = Path()
        let postStart = min(R * 0.62, max(R * 0.34, p * 11))
        for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
            fine.move(to: CGPoint(x: c.x + dx * gap, y: c.y + dy * gap))
            fine.addLine(to: CGPoint(x: c.x + dx * R, y: c.y + dy * R))
            if dy >= 0 || dx != 0 {
                heavy.move(to: CGPoint(x: c.x + dx * postStart, y: c.y + dy * postStart))
                heavy.addLine(to: CGPoint(x: c.x + dx * R, y: c.y + dy * R))
            }
        }
        // Mil hashes: every mil when magnified enough, otherwise every five.
        var ticks = Path()
        let every = p >= 5.5 ? 1 : 5
        for i in stride(from: every, through: 10, by: every) {
            let d = CGFloat(i) * p
            if d > postStart - 2 { break }
            let half = (i % 5 == 0 ? max(5, p * 0.5) : max(2.5, p * 0.25))
            for sign in [-1.0, 1.0] {
                ticks.move(to: CGPoint(x: c.x + sign * d, y: c.y - half))
                ticks.addLine(to: CGPoint(x: c.x + sign * d, y: c.y + half))
                ticks.move(to: CGPoint(x: c.x - half, y: c.y + sign * d))
                ticks.addLine(to: CGPoint(x: c.x + half, y: c.y + sign * d))
            }
            if p >= 9 && i % 2 == 0 {
                ctx.draw(Text("\(i)").font(.system(size: 9, weight: .medium, design: .monospaced)).foregroundColor(line),
                         at: CGPoint(x: c.x + max(9, p * 0.5) + 8, y: c.y + d))
            }
        }
        if p >= 22 {
            for i in 0..<10 {
                let d = (CGFloat(i) + 0.5) * p
                if d > postStart - 2 { break }
                for sign in [-1.0, 1.0] {
                    ticks.addEllipse(in: CGRect(x: c.x + sign * d - 0.9, y: c.y - 0.9, width: 1.8, height: 1.8))
                    ticks.addEllipse(in: CGRect(x: c.x - 0.9, y: c.y + sign * d - 0.9, width: 1.8, height: 1.8))
                }
            }
        }
        ctx.stroke(fine, with: .color(line), lineWidth: 1)
        ctx.stroke(ticks, with: .color(line), lineWidth: 1)
        ctx.stroke(heavy, with: .color(line), lineWidth: 4.5)
        ctx.fill(Path(ellipseIn: CGRect(x: c.x - 1.1, y: c.y - 1.1, width: 2.2, height: 2.2)), with: .color(line))
    }

    private func drawChevron(_ ctx: inout GraphicsContext, c: CGPoint, R: CGFloat) {
        let p = max(CGFloat(s.pxPerMil), 2)
        let glow = Color(red: 0.92, green: 0.2, blue: 0.08)
        let w = max(7, p * 2.4), h = max(9, p * 3.2)
        var chevron = Path()
        chevron.move(to: CGPoint(x: c.x - w, y: c.y + h))
        chevron.addLine(to: c)
        chevron.addLine(to: CGPoint(x: c.x + w, y: c.y + h))
        ctx.stroke(chevron, with: .color(glow.opacity(0.35)), style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .miter))
        ctx.stroke(chevron, with: .color(glow), style: StrokeStyle(lineWidth: 2.2, lineCap: .butt, lineJoin: .miter))

        // Bullet-drop ladder: each rung is as wide as a pair of shoulders at that range.
        var ladder = Path()
        let top = c.y + h + 4
        var bottom = top
        for hold in s.holdovers where hold.range >= 300 {
            let y = c.y + max(CGFloat(hold.mils) * p, h + 8 + CGFloat(hold.range - 300) / 100 * 9)
            let half = max(3.5, 0.48 / CGFloat(hold.range) * 1000 * p / 2)
            ladder.move(to: CGPoint(x: c.x - half, y: y))
            ladder.addLine(to: CGPoint(x: c.x + half, y: y))
            bottom = max(bottom, y)
            ctx.draw(Text("\(hold.range / 100)").font(.system(size: 9, weight: .semibold, design: .monospaced)).foregroundColor(.black.opacity(0.85)),
                     at: CGPoint(x: c.x + half + 9, y: y))
        }
        ladder.move(to: CGPoint(x: c.x, y: top))
        ladder.addLine(to: CGPoint(x: c.x, y: min(bottom + 26, c.y + R)))
        ctx.stroke(ladder, with: .color(.black.opacity(0.9)), lineWidth: 1.3)
    }
}

// MARK: - Damage

private struct DamageLayer: View {
    let s: HUDSnapshot

    var body: some View {
        let hurt = Double(max(s.damageFlash * 0.55, (1 - s.health / 100) * 0.4))
        ZStack {
            if hurt > 0.01 {
                RadialGradient(colors: [.clear, Color(red: 0.45, green: 0.02, blue: 0.0).opacity(hurt)],
                               center: .center, startRadius: 180, endRadius: 760)
            }
            if s.damageFlash > 0.05 {
                Capsule()
                    .fill(Color(red: 0.9, green: 0.22, blue: 0.14).opacity(Double(s.damageFlash)))
                    .frame(width: 64, height: 4)
                    .offset(y: -150)
                    .rotationEffect(.radians(Double(-s.damageAngle)))
            }
        }
    }
}

// MARK: - Status

private func rarityColor(_ r: Int) -> Color {
    let c = (Rarity(rawValue: r) ?? .common).rgb
    return Color(red: c.r, green: c.g, blue: c.b)
}

private struct PickupPrompt: View {
    let name: String
    let rarity: Int

    var body: some View {
        HStack(spacing: 10) {
            Text("E")
                .font(label(12, .bold)).foregroundStyle(.black)
                .frame(width: 22, height: 22)
                .background(RoundedRectangle(cornerRadius: 3).fill(ink))
            VStack(alignment: .leading, spacing: 1) {
                Text((Rarity(rawValue: rarity) ?? .common).name).font(label(9, .semibold)).foregroundStyle(rarityColor(rarity))
                Text(name).font(label(13, .semibold)).foregroundStyle(ink)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .background(Color.black.opacity(0.55))
        .overlay(Rectangle().fill(rarityColor(rarity)).frame(height: 2), alignment: .bottom)
    }
}

/// Inventory bar: five slots, the one in hand raised and outlined.
private struct SlotBar: View {
    let slots: [SlotInfo?]
    let current: Int

    var body: some View {
        HStack(alignment: .bottom, spacing: 5) {
            ForEach(0..<slots.count, id: \.self) { i in
                let slot = slots[i]
                let selected = i == current
                VStack(spacing: 2) {
                    Text(slot?.short ?? "").font(label(9, .semibold)).foregroundStyle(slot == nil ? dim : ink)
                    Text(slot.map { "\($0.ammo)" } ?? "").font(label(9)).foregroundStyle(dim)
                }
                .frame(width: 62, height: selected ? 44 : 36)
                .background(
                    LinearGradient(colors: [Color.black.opacity(0.45), (slot.map { rarityColor($0.rarity) } ?? .clear).opacity(0.35)],
                                   startPoint: .top, endPoint: .bottom)
                )
                .overlay(Rectangle().stroke(selected ? ink : ink.opacity(0.15), lineWidth: selected ? 1.5 : 1))
                .overlay(alignment: .topLeading) {
                    Text("\(i + 1)").font(label(8, .semibold)).foregroundStyle(dim).padding(3)
                }
            }
        }
    }
}

/// Rotating radar: the map turns so your heading is always up.
private struct Minimap: View {
    let s: HUDSnapshot
    let map: NSImage?
    let size: CGFloat = 190
    /// Metres from the centre to the edge of the disc.
    let range: CGFloat = 85

    var body: some View {
        Canvas { ctx, sz in
            let c = CGPoint(x: sz.width / 2, y: sz.height / 2)
            let r = sz.width / 2
            let disc = Path(ellipseIn: CGRect(x: 0, y: 0, width: sz.width, height: sz.height))
            ctx.fill(disc, with: .color(Color(red: 0.08, green: 0.09, blue: 0.07)))
            var world = ctx
            world.clip(to: disc)
            let ppm = r / range
            world.translateBy(x: c.x, y: c.y)
            world.rotate(by: .radians(Double(s.mapYaw)))
            world.scaleBy(x: ppm, y: ppm)
            world.translateBy(x: CGFloat(-s.mapX), y: CGFloat(-s.mapZ))
            if let map {
                let h = CGFloat(World.mapHalfSize)
                var m = world
                m.opacity = 0.85
                m.draw(Image(nsImage: map), in: CGRect(x: -h, y: -h, width: 2 * h, height: 2 * h))
            }
            // Grid every 50 m, so distance reads at a glance.
            var grid = Path()
            for i in stride(from: -200, through: 200, by: 50) {
                let v = CGFloat(i)
                grid.move(to: CGPoint(x: v, y: -200)); grid.addLine(to: CGPoint(x: v, y: 200))
                grid.move(to: CGPoint(x: -200, y: v)); grid.addLine(to: CGPoint(x: 200, y: v))
            }
            world.stroke(grid, with: .color(.white.opacity(0.08)), lineWidth: 1 / ppm)
            for b in s.blips {
                let p = CGPoint(x: CGFloat(b.x), y: CGFloat(b.z))
                switch b.kind {
                case .hostile:
                    let d = 3.2 / ppm
                    world.fill(Path(ellipseIn: CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)), with: .color(Color(red: 0.95, green: 0.18, blue: 0.12)))
                    world.stroke(Path(ellipseIn: CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)), with: .color(.black.opacity(0.6)), lineWidth: 1 / ppm)
                case .pickup(let rarity):
                    let d = 2.4 / ppm
                    world.fill(Path(CGRect(x: p.x - d, y: p.y - d, width: 2 * d, height: 2 * d)), with: .color(rarityColor(rarity)))
                }
            }
            // North marker on the rim.
            let north = CGPoint(x: c.x + sin(-CGFloat(s.mapYaw)) * (r - 11) * -1, y: c.y - cos(CGFloat(s.mapYaw)) * (r - 11))
            ctx.draw(Text("N").font(label(10, .bold)).foregroundColor(ink), at: north)
            // You: an arrow pointing up.
            var arrow = Path()
            arrow.move(to: CGPoint(x: c.x, y: c.y - 8))
            arrow.addLine(to: CGPoint(x: c.x + 5.5, y: c.y + 6))
            arrow.addLine(to: CGPoint(x: c.x, y: c.y + 3))
            arrow.addLine(to: CGPoint(x: c.x - 5.5, y: c.y + 6))
            arrow.closeSubpath()
            ctx.fill(arrow, with: .color(.white))
            ctx.stroke(arrow, with: .color(.black.opacity(0.6)), lineWidth: 1)
            ctx.stroke(disc, with: .color(.black.opacity(0.7)), lineWidth: 3)
            ctx.stroke(Path(ellipseIn: CGRect(x: 1.5, y: 1.5, width: sz.width - 3, height: sz.height - 3)), with: .color(ink.opacity(0.35)), lineWidth: 1)
        }
        .frame(width: size, height: size)
        .drawingGroup()
    }
}

private struct StatusLayer: View {
    let s: HUDSnapshot
    let map: NSImage?

    var body: some View {
        VStack {
            HStack(alignment: .top) {
                HStack(spacing: 18) {
                    stat("HOSTILES", "\(s.hostiles)")
                    stat("DOWN", "\(s.kills)")
                    stat("HEADSHOTS", "\(s.headshots)")
                    stat("LONGEST", s.longest > 0 ? "\(Int(s.longest)) m" : "—")
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 4) {
                    ForEach(s.feed) { item in
                        HStack(spacing: 10) {
                            Text(item.text.uppercased()).font(label(11, .semibold)).foregroundStyle(ink)
                            Text(item.detail).font(label(11)).foregroundStyle(dim)
                        }
                        .opacity(Double(min(1, (5 - item.age) / 1.2)))
                    }
                }
            }
            Spacer()
            HStack(alignment: .bottom) {
                VStack(alignment: .leading, spacing: 6) {
                    Minimap(s: s, map: map)
                        .padding(.bottom, 4)
                    HStack(spacing: 8) {
                        Text("VITALS").font(label(9, .semibold)).foregroundStyle(dim)
                        Text("\(Int(s.health.rounded()))").font(label(12)).foregroundStyle(ink)
                        if s.crouched { Text("CROUCHED").font(label(9, .semibold)).foregroundStyle(dim) }
                    }
                    ZStack(alignment: .leading) {
                        Rectangle().fill(ink.opacity(0.2)).frame(width: 190, height: 3)
                        Rectangle().fill(s.health < 35 ? Color(red: 0.9, green: 0.3, blue: 0.2) : Color(red: 0.45, green: 0.8, blue: 0.4))
                            .frame(width: 190 * CGFloat(max(0, s.health) / 100), height: 3)
                    }
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 3) {
                    SlotBar(slots: s.slots, current: s.currentSlot)
                        .padding(.bottom, 8)
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(s.reloading ? "--" : String(format: "%02d", s.ammo))
                            .font(.system(size: 34, weight: .light, design: .monospaced)).foregroundStyle(ink)
                        Text("/ \(s.magSize)").font(label(12)).foregroundStyle(dim)
                    }
                    Text(s.reloading ? "RELOADING" : (s.ammo == 0 ? "EMPTY · R TO RELOAD" : "\(s.opticName) · \(s.fireMode)"))
                        .font(label(9, .semibold)).foregroundStyle(s.reloading || s.ammo == 0 ? dim : rarityColor(s.rarity))
                }
            }
        }
        .padding(.horizontal, 30)
        .padding(.top, 44)
        .padding(.bottom, 24)
        .shadow(color: .black.opacity(0.6), radius: 2, y: 1)
    }

    private func stat(_ name: String, _ value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name).font(label(9, .semibold)).foregroundStyle(dim)
            Text(value).font(label(14)).foregroundStyle(ink)
        }
    }
}

// MARK: - Cards

private struct Card: View {
    let title: String
    let subtitle: String?
    let prompt: String
    let showControls: Bool

    private let controls: [(String, String)] = [
        ("W A S D", "Move"), ("Shift", "Sprint · hold breath when aiming"),
        ("Space / C", "Jump / crouch"), ("Left click", "Fire"),
        ("Right click or Q", "Aim through the optic"), ("Scroll or + / −", "Scope magnification"),
        ("1 – 5 / Scroll", "Switch weapon slot"), ("E", "Pick up · swap the gun in hand"),
        ("R", "Reload"), ("↑ / ↓", "Scope zero 100–600 m"),
        ("G / P", "Graphics quality · performance stats"), ("Esc", "Release the cursor"),
    ]

    var body: some View {
        ZStack {
            Color.black.opacity(0.45)
            VStack(alignment: .leading, spacing: 18) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(title).font(.system(size: 30, weight: .light, design: .serif)).tracking(6).foregroundStyle(ink)
                    if let subtitle {
                        Text(subtitle).font(.system(size: 13, design: .serif)).foregroundStyle(dim)
                    }
                }
                if showControls {
                    Rectangle().fill(ink.opacity(0.2)).frame(height: 1)
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(controls, id: \.0) { key, action in
                            HStack(alignment: .firstTextBaseline, spacing: 14) {
                                Text(key).font(label(11, .semibold)).foregroundStyle(ink).frame(width: 132, alignment: .leading)
                                Text(action).font(.system(size: 12)).foregroundStyle(dim)
                            }
                        }
                    }
                }
                Rectangle().fill(ink.opacity(0.2)).frame(height: 1)
                Text(prompt.uppercased()).font(label(11, .semibold)).tracking(2).foregroundStyle(ink)
            }
            .padding(34)
            .frame(width: 470, alignment: .leading)
            .background(Color(red: 0.07, green: 0.075, blue: 0.07).opacity(0.86))
            .overlay(Rectangle().stroke(ink.opacity(0.18), lineWidth: 1))
        }
    }
}
#endif
