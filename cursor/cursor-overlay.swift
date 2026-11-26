// DSH desktop cursor overlay — click-through, never activates the app, always on top
//
// Usage:
//   dsh-cursor-overlay [--fifo path] [--size 26] [--idle 60]
//   FIFO defaults to this user's private temp dir: $(getconf DARWIN_USER_TEMP_DIR)dsh-cursor.fifo (other accounts can't claim it; plugin and dsh-cu share the same algorithm)
// Control (write one line to the FIFO):
//   show <x> <y>     Show at once at screen coords (x,y) (Quartz global coords, top-left origin)
//   move <x> <y>     Glide smoothly to (x,y)
//   click [n]        One click (tip shrinks + a faint ripple ring; n=2 double-click, two rings)
//   down / up        Drag: press (shrink a bit + halo ring around the tip) / release
//   scroll <±1>      Scroll hint (a small circle up-right of the arrow, nudges toward the scroll direction)
//   label <text>     Nameplate expands from "DSH" to "DSH · click to send", retracts a moment later; empty text retracts at once
//   hide             Hide
//   lens <x> <y>     Show the "working" spinner at (x,y) (same assets as Codex's SkyLensView, 45 frames)
//   lenshide         Retract the spinner
//   fog on|off       Dim the desktop into focus (Codex's FogBackgroundEffect layer)
//   ping             Print one line of current state to stderr (for debugging)
//   quit             Quit
//
// The look is one set with the browser's in-page cursor (dsh-chrome-bridge's in-page-cursor.js):
//   same arrow, same blue, same motion. Two things set them apart — the desktop side is solid, nameplate with a monitor icon;
//   the browser side is translucent, nameplate with a globe icon.
// Motion stays restrained; both sides share one spring, one algorithm: glide along a slight arc, stretch gently along the velocity,
// tilt slightly, nameplate follows half a beat behind and overshoots by at most a couple of pixels on arrival; clicks shrink around the tip as pivot and bounce back with one faint ripple.
// With the system's "Reduce Motion" on, jump straight there and skip the animation.
//
// Key points:
//   * NSPanel + .nonactivatingPanel + orderFrontRegardless() → never steals the foreground
//   * ignoresMouseEvents = true → click-through, never blocks your input
//   * level = .screenSaver → always above every window
//   * setActivationPolicy(.accessory) → no Dock icon, no Cmd-Tab entry
//   * Drawn entirely with CALayer (no image assets); the panel holds a single layer tree, driven manually at 60fps

import AppKit
import Foundation
import QuartzCore

let args = CommandLine.arguments
func argValue(_ name: String, _ fallback: String) -> String {
    if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }
    return fallback
}

let fifoPath = argValue("--fifo", {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    let dir = confstr(_CS_DARWIN_USER_TEMP_DIR, &buf, buf.count) > 0 ? String(cString: buf) : NSTemporaryDirectory()
    return (dir as NSString).appendingPathComponent("dsh-cursor.fifo")
}())
/// The arrow is drawn inside a size×size box (same as the browser's 26px)
let cursorSize = CGFloat(Double(argValue("--size", "26")) ?? 26)
// How long to idle before exiting on its own (seconds). No resident process hogging memory — it gets relaunched when needed again.
let idleSeconds = Double(argValue("--idle", "60")) ?? 60
var lastActivity = Date()

func rgb(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

// ── Shape: the exact same path as the browser arrow (24×24 coords, tip at (4, 3))──────────────
//   M4 3.2v16.1c0 .8.95 1.2 1.5.62l3.86-4.02 3.07 6.3c.25.5.86.71 1.36.47l2.04-.98
//   c.5-.24.71-.84.47-1.34l-3.05-6.25 5.5-.2c.82-.03 1.2-1.03.6-1.6L5.65 2.5C5.06 1.95 4 2.37 4 3.2z
func arrowPath(scale k: CGFloat) -> CGPath {
    let p = CGMutablePath()
    var cur = CGPoint(x: 4, y: 3.2)
    func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x * k, y: y * k) }
    p.move(to: P(cur.x, cur.y))
    func l(_ dx: CGFloat, _ dy: CGFloat) { cur = CGPoint(x: cur.x + dx, y: cur.y + dy); p.addLine(to: P(cur.x, cur.y)) }
    func c(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat, _ dx: CGFloat, _ dy: CGFloat) {
        let a = P(cur.x + x1, cur.y + y1), b = P(cur.x + x2, cur.y + y2)
        cur = CGPoint(x: cur.x + dx, y: cur.y + dy)
        p.addCurve(to: P(cur.x, cur.y), control1: a, control2: b)
    }
    l(0, 16.1)
    c(0, 0.8, 0.95, 1.2, 1.5, 0.62)
    l(3.86, -4.02)
    l(3.07, 6.3)
    c(0.25, 0.5, 0.86, 0.71, 1.36, 0.47)
    l(2.04, -0.98)
    c(0.5, -0.24, 0.71, -0.84, 0.47, -1.34)
    l(-3.05, -6.25)
    l(5.5, -0.2)
    c(0.82, -0.03, 1.2, -1.03, 0.6, -1.6)
    cur = CGPoint(x: 5.65, y: 2.5); p.addLine(to: P(cur.x, cur.y))
    p.addCurve(to: P(4, 3.2), control1: P(5.06, 1.95), control2: P(4, 2.37))
    p.closeSubpath()
    return p
}

/// Nameplate shape: small corner radius at the top-left (points at the arrow), large radius elsewhere
func tagPath(_ r: CGRect) -> CGPath {
    let p = CGMutablePath()
    let tl = min(4, r.height / 2), o = min(11, r.height / 2, r.width / 2)
    p.move(to: CGPoint(x: r.minX + tl, y: r.minY))
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.maxY), radius: o)
    p.addArc(tangent1End: CGPoint(x: r.maxX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.maxY), radius: o)
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.maxY), tangent2End: CGPoint(x: r.minX, y: r.minY), radius: o)
    p.addArc(tangent1End: CGPoint(x: r.minX, y: r.minY), tangent2End: CGPoint(x: r.maxX, y: r.minY), radius: tl)
    p.closeSubpath()
    return p
}

/// Monitor icon (12×12); the browser side uses a globe
func monitorIcon() -> CGPath {
    let p = CGMutablePath()
    p.addRoundedRect(in: CGRect(x: 1, y: 1.6, width: 10, height: 6.8), cornerWidth: 1.2, cornerHeight: 1.2)
    p.move(to: CGPoint(x: 6, y: 8.4)); p.addLine(to: CGPoint(x: 6, y: 10.4))
    p.move(to: CGPoint(x: 4, y: 10.6)); p.addLine(to: CGPoint(x: 8, y: 10.6))
    return p
}

let lerp = { (a: CGFloat, b: CGFloat, t: CGFloat) -> CGFloat in a + (b - a) * t }
let easeOut = { (t: CGFloat) -> CGFloat in 1 - pow(1 - t, 3) }
let easeInOut = { (t: CGFloat) -> CGFloat in t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2 }

/// Position spring (Codex's scoot idea, tuned params: almost no bounce-back, stretch up to 7% like the browser)
final class Spring {
    var pos = CGPoint.zero      // Quartz coords (top-left origin, y down) — where the tip sits
    var vel = CGPoint.zero
    var target = CGPoint.zero
    var live = false

    let response = 0.34         // spring response (seconds)
    let damping = 0.86          // damping ratio: <1 gives a slight bounce, at most a couple of pixels over long moves

    func jump(to p: CGPoint) { pos = p; target = p; vel = .zero; live = true }
    func move(to p: CGPoint) {
        guard live else { jump(to: p); return }
        target = p
    }
    var resting: Bool { vel == .zero && pos == target }

    func step(_ dt: Double) {
        guard live, !resting else { return }
        let omega = 2 * Double.pi / response
        let k = omega * omega, c = 2 * damping * omega
        let ax = -k * Double(pos.x - target.x) - c * Double(vel.x)
        let ay = -k * Double(pos.y - target.y) - c * Double(vel.y)
        vel.x += CGFloat(ax * dt); vel.y += CGFloat(ay * dt)
        pos.x += vel.x * CGFloat(dt); pos.y += vel.y * CGFloat(dt)
        if hypot(vel.x, vel.y) < 3 && hypot(pos.x - target.x, pos.y - target.y) < 0.5 {
            pos = target; vel = .zero
        }
    }
}

final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

final class OverlayController: NSObject {
    // Panel layout (view coords, top-left origin): tip pinned at (M, M), margins around for ripple / stretch / shadow, nameplate at bottom-right
    static let M: CGFloat = 26
    static let W: CGFloat = 360
    static let H: CGFloat = 84
    let tip = CGPoint(x: M, y: M)

    let panel: NSPanel
    let root = CALayer()
    let arrow = CALayer()
    let tag = CALayer()
    let tagRing = CAShapeLayer()
    let tagBg = CAGradientLayer()
    let tagMask = CAShapeLayer()
    let tagClip = CALayer()
    let who = CATextLayer()
    let what = CATextLayer()
    let k = cursorSize / 24
    let scale = NSScreen.screens.map(\.backingScaleFactor).max() ?? 2   // draw at the highest scale factor across screens, crisp on any display

    let spring = Spring()
    var timer: Timer?
    var visible = false
    var last = Date()

    // Animation state
    var shownAt = Date.distantPast        // entrance animation start
    var pressAt = Date.distantPast        // click animation start
    var pressDur = 0.26
    var stretch: CGFloat = 1, tilt: CGFloat = 0, dir: CGFloat = 0
    var lag = CGPoint.zero                // how far the nameplate lags behind
    var wokeAt = Date()                   // last time something happened
    var dim: CGFloat = 1                  // dims when idle
    var labelUntil = Date.distantPast
    var whoW: CGFloat = 0, whatW: CGFloat = 0
    var tagW: CGFloat = 0                 // current nameplate width (chases the target frame by frame)
    var whatA: CGFloat = 0                // current opacity of the action text
    var lastOrigin: NSPoint?              // last frame's actual placed position / drawn value: skip if unchanged
    var lastKey: [CGFloat] = []
    var pressHeld = false                 // button held down during a drag
    var hold: CGFloat = 1
    var arcFrom = CGPoint.zero, arcTo = CGPoint.zero, arcBend: CGFloat = 0   // the current arc segment
    var prevDisp: CGPoint?                // last drawn position: true velocity (including the arc component) is derived from it
    var dispVel = CGPoint.zero
    var exiting = false
    let halo = CAShapeLayer()
    let wheel = CALayer()
    let chevron = CAShapeLayer()
    var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    let whoFont = NSFont.systemFont(ofSize: 11.5, weight: .semibold)
    let whatFont = NSFont.systemFont(ofSize: 11.5, weight: .medium)

    override init() {
        let rect = NSRect(x: 0, y: 0, width: OverlayController.W, height: OverlayController.H)
        panel = NSPanel(contentRect: rect, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        super.init()
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.ignoresMouseEvents = true
        panel.hidesOnDeactivate = false
        panel.level = .screenSaver
        panel.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
        panel.isMovable = false

        // layer-hosting: set the layer before wantsLayer and AppKit never touches our layer tree.
        // Sublayers all use a top-left origin (matching the browser): AppKit rewrites the root layer's
        // geometryFlipped from the view's isFlipped, so the view itself must be flipped; setting the layer alone isn't enough
        let view = FlippedView(frame: rect)
        root.frame = rect
        root.masksToBounds = false
        view.layer = root
        view.wantsLayer = true
        root.isGeometryFlipped = true
        panel.contentView = view
        buildArrow()
        buildTag()
        buildExtras()
    }

    /// Tip halo while dragging + the scroll-hint circle (same design as the browser side)
    func buildExtras() {
        halo.bounds = CGRect(x: 0, y: 0, width: 22, height: 22)
        halo.position = tip
        halo.path = CGPath(ellipseIn: halo.bounds.insetBy(dx: 0.75, dy: 0.75), transform: nil)
        halo.fillColor = rgb(0x4D6BFE, 0.22)
        halo.strokeColor = rgb(0x4D6BFE, 0.7)
        halo.lineWidth = 1.5
        halo.contentsScale = scale
        halo.opacity = 0
        halo.transform = CATransform3DMakeScale(0.4, 0.4, 1)
        root.insertSublayer(halo, below: arrow)

        wheel.frame = CGRect(x: tip.x + 20, y: tip.y - 26, width: 20, height: 20)
        wheel.backgroundColor = rgb(0x4D6BFE)
        wheel.cornerRadius = 10
        wheel.shadowColor = rgb(0x1E32A0)
        wheel.shadowOpacity = 0.35
        wheel.shadowRadius = 3
        wheel.shadowOffset = CGSize(width: 0, height: 2)
        wheel.opacity = 0
        chevron.frame = CGRect(x: 4, y: 4, width: 12, height: 12)
        chevron.fillColor = nil
        chevron.strokeColor = white
        chevron.lineWidth = 1.8
        chevron.lineCap = .round
        chevron.lineJoin = .round
        chevron.contentsScale = scale
        wheel.addSublayer(chevron)
        root.addSublayer(wheel)
    }

    func buildArrow() {
        let box = 24 * k
        let path = arrowPath(scale: k)
        arrow.bounds = CGRect(x: 0, y: 0, width: box, height: box)
        arrow.anchorPoint = CGPoint(x: 4.0 / 24, y: 3.0 / 24)   // pivot at the tip: the aim point stays put while scaling or tilting
        arrow.position = tip

        // White stroke (drawn under the fill so only the outer half shows — like SVG's paint-order: stroke) + drop shadow
        let edge = CAShapeLayer()
        edge.frame = arrow.bounds
        edge.path = path
        edge.fillColor = white
        edge.strokeColor = white
        edge.lineWidth = 1.6 * k
        edge.lineJoin = .round
        edge.shadowColor = rgb(0x101840)
        edge.shadowOpacity = 0.38
        edge.shadowRadius = 1.6
        edge.shadowOffset = CGSize(width: 0, height: 1.5)
        edge.contentsScale = scale

        // Solid blue gradient
        let fill = CAGradientLayer()
        fill.frame = arrow.bounds
        fill.colors = [rgb(0x6F8BFF), rgb(0x3552F2)]
        fill.startPoint = CGPoint(x: 0.15, y: 0.1)
        fill.endPoint = CGPoint(x: 0.85, y: 0.95)
        let mask = CAShapeLayer()
        mask.frame = arrow.bounds
        mask.path = path
        mask.contentsScale = scale
        fill.mask = mask

        arrow.addSublayer(edge)
        arrow.addSublayer(fill)
        root.addSublayer(arrow)
    }

    func buildTag() {
        tag.anchorPoint = .zero
        tag.position = CGPoint(x: tip.x + 17, y: tip.y + 21)

        tagRing.fillColor = rgb(0xFFFFFF, 0.55)       // outer 1px white rim
        tagRing.shadowColor = rgb(0x1E32A0)
        tagRing.shadowOpacity = 0.35
        tagRing.shadowRadius = 4
        tagRing.shadowOffset = CGSize(width: 0, height: 2)
        tagRing.contentsScale = scale

        tagBg.colors = [rgb(0x5B77FF), rgb(0x3E5CF5)]
        tagBg.startPoint = .zero
        tagBg.endPoint = CGPoint(x: 1, y: 1)
        tagMask.contentsScale = scale
        tagBg.mask = tagMask

        tagClip.masksToBounds = true
        let icon = CAShapeLayer()
        icon.frame = CGRect(x: 7, y: 5, width: 12, height: 12)
        icon.path = monitorIcon()
        icon.fillColor = nil
        icon.strokeColor = white
        icon.lineWidth = 1.3
        icon.lineCap = .round
        icon.contentsScale = scale

        let whoText = NSAttributedString(string: "DSH", attributes: [.font: whoFont, .foregroundColor: NSColor.white, .kern: 0.2])
        whoW = ceil(whoText.size().width)
        who.string = whoText
        who.contentsScale = scale
        let lineH = ceil(whoText.size().height)
        who.frame = CGRect(x: 24, y: (22 - lineH) / 2, width: whoW + 2, height: lineH)

        what.contentsScale = scale
        what.frame = CGRect(x: 24 + whoW + 6, y: (22 - lineH) / 2, width: 240, height: lineH)
        what.opacity = 0

        tagClip.addSublayer(icon)
        tagClip.addSublayer(who)
        tagClip.addSublayer(what)
        tag.addSublayer(tagRing)
        tag.addSublayer(tagBg)
        tag.addSublayer(tagClip)
        root.addSublayer(tag)
        tagW = collapsedW
        layoutTag()
    }

    var collapsedW: CGFloat { 24 + whoW + 8 }
    var targetW: CGFloat { Date() < labelUntil && whatW > 0 ? 24 + whoW + 6 + whatW + 8 : collapsedW }

    func layoutTag() {
        let r = CGRect(x: 0, y: 0, width: tagW, height: 22)
        tagRing.path = tagPath(r.insetBy(dx: -1, dy: -1))
        tagBg.frame = r
        tagMask.frame = r
        tagMask.path = tagPath(r)
        tagClip.frame = r
    }

    /// Quartz global coords (top-left origin) → panel origin (AppKit, bottom-left origin): places the tip (M, M) exactly at (x, y)
    func panelOrigin(_ p: CGPoint) -> NSPoint {
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        return NSPoint(x: p.x - tip.x, y: screenH - p.y + tip.y - OverlayController.H)
    }

    func wake() { wokeAt = Date() }

    func show(x: Double, y: Double, animate: Bool) {
        wake()
        let p = CGPoint(x: x.rounded(), y: y.rounded())
        if !visible {
            spring.jump(to: p)
            arcBend = 0; prevDisp = nil
            lastOrigin = panelOrigin(p)
            panel.setFrameOrigin(lastOrigin!)
            root.opacity = 1
            shownAt = reduceMotion ? .distantPast : Date()
            panel.orderFrontRegardless()       // show without activating this process
            visible = true
            startTicking()
            return
        }
        if animate && !reduceMotion {
            // Start a new arc from the position drawn right now (no jump when retargeting mid-flight); bending matches the browser
            let from = displayPos()
            spring.pos = from
            let d = hypot(p.x - from.x, p.y - from.y)
            arcFrom = from; arcTo = p
            arcBend = d < 2 ? 0 : min(44, d * 0.12) * (p.x - from.x >= 0 ? -1 : 1)
            spring.move(to: p)
        } else {
            spring.jump(to: p)
            arcBend = 0; prevDisp = nil
        }
    }

    /// The spring travels a straight line; when drawing, push it sideways by "how far along" it is — that yields a quadratic Bezier arc
    func displayPos() -> CGPoint {
        let p = spring.pos
        guard arcBend != 0 else { return p }
        let dx = arcTo.x - arcFrom.x, dy = arcTo.y - arcFrom.y
        let d = hypot(dx, dy)
        guard d > 1 else { return p }
        let ux = dx / d, uy = dy / d
        let s = max(0, min(1, ((p.x - arcFrom.x) * ux + (p.y - arcFrom.y) * uy) / d))
        let off = arcBend * 2 * s * (1 - s)
        return CGPoint(x: p.x - uy * off, y: p.y + ux * off)
    }

    func label(_ text: String) {
        wake()
        let t = text.trimmingCharacters(in: .whitespaces)
        guard !t.isEmpty else { labelUntil = .distantPast; return }
        func make(_ body: String) -> NSMutableAttributedString {
            let s = NSMutableAttributedString(string: "·\u{2002}", attributes: [.font: whatFont, .foregroundColor: NSColor(white: 1, alpha: 0.7)])
            s.append(NSAttributedString(string: body, attributes: [.font: whatFont, .foregroundColor: NSColor(white: 1, alpha: 0.96)]))
            return s
        }
        // Truncate from the tail with an ellipsis until it fits within 230pt (same max width as the browser nameplate)
        var body = t.count > 60 ? String(t.prefix(59)) + "…" : t
        var s = make(body)
        while s.size().width > 230 && body.count > 2 {
            body = String(body.dropLast(2)) + "…"
            s = make(body)
        }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        what.string = s
        CATransaction.commit()
        whatW = min(230, ceil(s.size().width))
        labelUntil = Date().addingTimeInterval(2.6)
    }

    func press(count: Int = 1) {
        wake()
        guard !reduceMotion else { return }
        pressAt = Date()
        pressDur = (Double(ProcessInfo.processInfo.environment["DSH_CURSOR_PRESS_MS"] ?? "260") ?? 260) / 1000
        for i in 0..<max(1, min(3, count)) { ripple(delay: Double(i) * 0.13) }
    }

    /// Drag: press-and-hold — the arrow shrinks a bit, halo ring around the tip
    func down() {
        wake()
        pressHeld = true
        CATransaction.begin(); CATransaction.setAnimationDuration(0.15)
        halo.opacity = 1
        halo.transform = CATransform3DIdentity
        CATransaction.commit()
    }

    func up() {
        wake()
        pressHeld = false
        CATransaction.begin(); CATransaction.setAnimationDuration(0.18)
        halo.opacity = 0
        halo.transform = CATransform3DMakeScale(0.4, 0.4, 1)
        CATransaction.commit()
    }

    /// Scroll hint: an arrow inside the small circle up-right, slides gently toward the scroll direction, then fades out
    func scroll(_ dir: CGFloat) {
        wake()
        let p = CGMutablePath()
        if dir < 0 { p.move(to: CGPoint(x: 3, y: 7.5)); p.addLine(to: CGPoint(x: 6, y: 4.5)); p.addLine(to: CGPoint(x: 9, y: 7.5)) }
        else { p.move(to: CGPoint(x: 3, y: 4.5)); p.addLine(to: CGPoint(x: 6, y: 7.5)); p.addLine(to: CGPoint(x: 9, y: 4.5)) }
        CATransaction.begin(); CATransaction.setDisableActions(true)
        chevron.path = p
        CATransaction.commit()
        guard !reduceMotion else { return }
        let s: CGFloat = dir < 0 ? -1 : 1
        let fade = CAKeyframeAnimation(keyPath: "opacity")
        fade.values = [0, 1, 1, 0]; fade.keyTimes = [0, 0.25, 0.75, 1]
        let slide = CAKeyframeAnimation(keyPath: "transform.translation.y")
        slide.values = [-4 * s, 0, 3 * s, 5 * s]; slide.keyTimes = [0, 0.25, 0.75, 1]
        let g = CAAnimationGroup()
        g.animations = [fade, slide]
        g.duration = 0.9
        g.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        wheel.add(g, forKey: "scroll")
    }

    /// A faint ripple ring + a small center dot, spreading out from the tip
    func ripple(delay: Double) {
        let ring = CAShapeLayer()
        ring.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
        ring.position = tip
        ring.path = CGPath(ellipseIn: ring.bounds.insetBy(dx: 0.75, dy: 0.75), transform: nil)
        ring.fillColor = rgb(0x4D6BFE, 0.12)
        ring.strokeColor = rgb(0x4D6BFE, 0.85)
        ring.lineWidth = 1.5
        ring.shadowColor = white; ring.shadowOpacity = 0.6; ring.shadowRadius = 0.5; ring.shadowOffset = .zero
        ring.contentsScale = scale
        ring.opacity = 0
        let dot = CAShapeLayer()
        dot.bounds = CGRect(x: 0, y: 0, width: 7, height: 7)
        dot.position = tip
        dot.path = CGPath(ellipseIn: dot.bounds, transform: nil)
        dot.fillColor = rgb(0x4D6BFE)
        dot.strokeColor = rgb(0xFFFFFF, 0.9)
        dot.lineWidth = 2
        dot.contentsScale = scale
        dot.opacity = 0
        root.insertSublayer(ring, below: arrow)
        root.insertSublayer(dot, below: arrow)

        let begin = CACurrentMediaTime() + delay
        let grow = CABasicAnimation(keyPath: "transform.scale")
        grow.fromValue = 0.3; grow.toValue = 1
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 0.9; fade.toValue = 0
        let g = CAAnimationGroup()
        g.animations = [grow, fade]
        g.duration = 0.56; g.beginTime = begin
        g.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.7, 0.3, 1)
        g.fillMode = .both; g.isRemovedOnCompletion = false
        ring.add(g, forKey: "ripple")

        let dg = CAKeyframeAnimation(keyPath: "opacity")
        dg.values = [1, 1, 0]; dg.keyTimes = [0, 0.3, 1]
        let ds = CAKeyframeAnimation(keyPath: "transform.scale")
        ds.values = [0.5, 1, 1]; ds.keyTimes = [0, 0.3, 1]
        let dgg = CAAnimationGroup()
        dgg.animations = [dg, ds]
        dgg.duration = 0.6; dgg.beginTime = begin
        dgg.fillMode = .both; dgg.isRemovedOnCompletion = false
        dot.add(dgg, forKey: "ripple")

        DispatchQueue.main.asyncAfter(deadline: .now() + delay + 0.8) { ring.removeFromSuperlayer(); dot.removeFromSuperlayer() }
    }

    func startTicking() {
        guard timer == nil else { return }
        last = Date()
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60.0, repeats: true) { [weak self] t in
            guard let self = self else { t.invalidate(); return }
            self.tick()
        }
        RunLoop.main.add(timer!, forMode: .common)
    }

    func tick() {
        let now = Date()
        let dt = min(0.05, now.timeIntervalSince(last)); last = now
        spring.step(dt)
        let disp = displayPos()
        let origin = panelOrigin(disp)
        if origin != lastOrigin { panel.setFrameOrigin(origin); lastOrigin = origin }
        // True velocity (including the arc component): stretch, tilt and nameplate lag all derive from it — same algorithm as the browser
        if let pd = prevDisp, dt > 0 {
            dispVel = CGPoint(x: (disp.x - pd.x) / CGFloat(dt), y: (disp.y - pd.y) / CGFloat(dt))
        } else {
            dispVel = .zero
        }
        prevDisp = disp

        // Stretch gently along the velocity + tilt (both proportional to speed, reset to zero when stopped); no stretch while a drag is held
        let v = pressHeld ? CGPoint.zero : dispVel
        let speed = hypot(v.x, v.y)
        let amount = min(1, speed / 2600)
        let smooth = CGFloat(1 - exp(-dt * 18))
        stretch = lerp(stretch, 1 + 0.07 * amount, smooth)
        tilt = lerp(tilt, speed > 1 ? (v.x / speed) * 0.10 * amount : 0, smooth)
        if speed > 30 { dir = atan2(v.y, v.x) }
        // Nameplate half a beat behind: lags slightly against the velocity (up to 5px), then catches up
        let lmax: CGFloat = 5
        let want = CGPoint(x: max(-lmax, min(lmax, -v.x * 0.004)), y: max(-lmax, min(lmax, -v.y * 0.004)))
        lag = CGPoint(x: lerp(lag.x, want.x, smooth), y: lerp(lag.y, want.y, smooth))

        // Entrance: scale from 0.6 up to 1.04, settle back to 1, while fading in
        let ua = CGFloat(now.timeIntervalSince(shownAt) / 0.28)
        var appear: CGFloat = 1, appearA: CGFloat = 1
        if ua < 1 {
            appear = ua < 0.7 ? lerp(0.6, 1.04, easeOut(ua / 0.7)) : lerp(1.04, 1, (ua - 0.7) / 0.3)
            appearA = min(1, ua / 0.7)
        }
        // Click: shrink to 0.86 around the tip as pivot, bounce gently to 1.03, then settle back
        let up = CGFloat(now.timeIntervalSince(pressAt) / pressDur)
        var press: CGFloat = 1
        if up < 1 {
            press = up < 0.35 ? lerp(1, 0.86, easeOut(up / 0.35))
                : up < 0.75 ? lerp(0.86, 1.03, easeInOut((up - 0.35) / 0.4))
                : lerp(1.03, 1, (up - 0.75) / 0.25)
        }

        hold = lerp(hold, pressHeld ? 0.88 : 1, CGFloat(1 - exp(-dt * 25)))

        // After 6 idle seconds, dim and retract the nameplate (like the browser: fade to two-thirds)
        let idle = now.timeIntervalSince(wokeAt) > 6
        dim = lerp(dim, idle ? 0.66 : 1, CGFloat(1 - exp(-dt * 6)))
        if idle { labelUntil = .distantPast }

        // Nameplate width / text opacity chase their target values
        let tw = targetW
        tagW = abs(tw - tagW) < 0.3 ? tw : lerp(tagW, tw, CGFloat(1 - exp(-dt * 14)))
        whatA = lerp(whatA, tw > collapsedW ? 1 : 0, CGFloat(1 - exp(-dt * (tw > collapsedW ? 10 : 22))))

        var t = CGAffineTransform(rotationAngle: dir)
            .scaledBy(x: stretch, y: 1 / sqrt(stretch))
            .rotated(by: -dir)
        t = t.concatenating(CGAffineTransform(rotationAngle: tilt))
        t = t.concatenating(CGAffineTransform(scaleX: press * appear * hold, y: press * appear * hold))

        let tagA = min(1, max(0, CGFloat((now.timeIntervalSince(shownAt) - 0.06) / 0.26)))

        // Touch no layers when nothing changed: while parked, each frame is just a few comparisons, no redraw
        let key: [CGFloat] = [t.a, t.b, t.c, t.d, appearA, lag.x, lag.y, tagA, tagW, whatA, dim]
        if key.count == lastKey.count && zip(key, lastKey).allSatisfy({ abs($0 - $1) < 0.0005 }) { return }
        let widthChanged = lastKey.count != key.count || abs(lastKey[8] - tagW) >= 0.0005
        lastKey = key

        CATransaction.begin(); CATransaction.setDisableActions(true)
        arrow.setAffineTransform(t)
        arrow.opacity = Float(appearA)
        tag.position = CGPoint(x: tip.x + 17 + lag.x, y: tip.y + 21 + lag.y)
        tag.opacity = Float(tagA)
        if widthChanged { layoutTag() }
        what.opacity = Float(whatA)
        root.opacity = Float(dim)
        CATransaction.commit()
    }

    func hide() {
        timer?.invalidate(); timer = nil
        panel.orderOut(nil)
        visible = false
        spring.live = false
        labelUntil = .distantPast
        tagW = collapsedW; whatA = 0; dim = 1
        lastOrigin = nil; lastKey = []
        pressHeld = false; hold = 1; arcBend = 0; prevDisp = nil
        halo.opacity = 0
    }

    /// Before quitting after a long idle, fade out over 0.25s instead of vanishing abruptly; commands arriving mid-fade resume normal operation
    func fadeOut(then done: @escaping () -> Void) {
        guard visible, !reduceMotion else { done(); return }
        timer?.invalidate(); timer = nil
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = root.opacity
        a.toValue = 0
        a.duration = 0.25
        a.fillMode = .forwards
        a.isRemovedOnCompletion = false
        root.add(a, forKey: "fade")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) { [weak self] in
            guard let self = self else { return }
            if Date().timeIntervalSince(lastActivity) < idleSeconds {
                self.root.removeAnimation(forKey: "fade")
                self.lastKey = []
                self.exiting = false
                self.startTicking()
                return
            }
            done()
        }
    }
}

// ── "Working" spinner: frames taken directly from Codex's LensSequence (45 frames)──────
final class LensView: NSView {
    var frames: [NSImage] = []
    var idx = 0
    var timer: Timer?
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard !frames.isEmpty else { return }
        frames[idx % frames.count].draw(in: bounds)
    }
    func start() {
        guard timer == nil, !frames.isEmpty else { return }
        timer = Timer.scheduledTimer(withTimeInterval: 1.0/30.0, repeats: true) { [weak self] _ in
            guard let self = self else { return }
            self.idx = (self.idx + 1) % self.frames.count
            self.needsDisplay = true
        }
        RunLoop.main.add(timer!, forMode: .common)
    }
    func stop() { timer?.invalidate(); timer = nil }
}

final class FogView: NSView {
    var focus: NSPoint = .zero          // AppKit coords (bottom-left origin)
    var radius: CGFloat = 200
    var dim: CGFloat = 0.5

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current else { return }
        ctx.compositingOperation = .sourceOver
        NSColor(calibratedWhite: 0, alpha: dim).setFill()
        bounds.fill()
        // Use destinationOut + a radial gradient to "wipe" the center clear
        ctx.compositingOperation = .destinationOut
        let grad = NSGradient(colors: [
            NSColor(calibratedWhite: 0, alpha: 1.0),
            NSColor(calibratedWhite: 0, alpha: 0.75),
            NSColor(calibratedWhite: 0, alpha: 0.0),
        ])
        grad?.draw(fromCenter: focus, radius: 0, toCenter: focus, radius: radius, options: [])
    }
}

final class EffectsController: NSObject {
    /// Auto-retract delay for effects (seconds) — clean up once activity stops, don't linger on the user's screen
    let fxIdle: Double = 6
    var fxTimer: Timer?
    func keepAlive() {
        fxTimer?.invalidate()
        fxTimer = Timer.scheduledTimer(withTimeInterval: fxIdle, repeats: false) { [weak self] _ in
            self?.hideLens()
            self?.setFog(false)
        }
        RunLoop.main.add(fxTimer!, forMode: .common)
    }

    var lensPanel: NSPanel?
    var lensView: LensView?
    var fogPanel: NSPanel?
    var fogView: FogView?

    func loadFrames() -> [NSImage] {
        let dir = NSString(string: "~/.dsh/share/lens").expandingTildeInPath
        let fs = (try? FileManager.default.contentsOfDirectory(atPath: dir))?.filter { $0.hasSuffix(".png") }.sorted() ?? []
        return fs.compactMap { NSImage(contentsOfFile: dir + "/" + $0) }
    }

    func showLens(x: Double, y: Double) {
        if lensPanel == nil {
            let size: CGFloat = 40
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: size, height: size),
                            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            p.isOpaque = false; p.backgroundColor = .clear; p.hasShadow = false
            p.ignoresMouseEvents = true; p.hidesOnDeactivate = false
            p.level = .screenSaver
            p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
            let v = LensView(frame: NSRect(x: 0, y: 0, width: size, height: size))
            v.frames = loadFrames()
            p.contentView = v
            lensPanel = p; lensView = v
        }
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        let size = lensPanel!.frame.width
        // Place the spinner just below-right of the cursor so it doesn't cover it
        lensPanel!.setFrameOrigin(NSPoint(x: CGFloat(x) + 6, y: screenH - CGFloat(y) - size + 4))
        lensPanel!.orderFrontRegardless()
        lensView?.start()
        keepAlive()
    }

    func hideLens() {
        lensView?.stop()
        lensPanel?.orderOut(nil)
    }

    func setFog(_ on: Bool) {
        if on {
            if fogPanel == nil {
                let f = NSScreen.screens.first?.frame ?? NSRect(x: 0, y: 0, width: 1920, height: 1080)
                let p = NSPanel(contentRect: f, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                p.isOpaque = false
                p.backgroundColor = .clear
                p.hasShadow = false; p.ignoresMouseEvents = true; p.hidesOnDeactivate = false
                p.level = .init(rawValue: NSWindow.Level.screenSaver.rawValue - 1)   // below the cursor / spinner
                p.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle, .fullScreenAuxiliary]
                let v = FogView(frame: NSRect(origin: .zero, size: f.size))
                p.contentView = v
                fogPanel = p; fogView = v
            }
            fogPanel?.orderFrontRegardless()
            keepAlive()
        } else {
            fogPanel?.orderOut(nil)
        }
    }

    /// Move the "bright spot" to the cursor
    func fogFocus(x: Double, y: Double) {
        guard let v = fogView else { return }
        let screenH = NSScreen.screens.first?.frame.height ?? 0
        v.focus = NSPoint(x: CGFloat(x), y: screenH - CGFloat(y))
        v.needsDisplay = true
    }
}

let controller = OverlayController()
let effects = EffectsController()

// ---- FIFO command channel ----
try? FileManager.default.removeItem(atPath: fifoPath)
mkfifo(fifoPath, 0o600)

let fd = open(fifoPath, O_RDONLY | O_NONBLOCK)
if fd < 0 {
    FileHandle.standardError.write("dsh-cursor-overlay: cannot open FIFO \(fifoPath)\n".data(using: .utf8)!)
    exit(1)
}

func handle(_ line: String) {
    lastActivity = Date()
    let parts = line.split(separator: " ").map(String.init)
    guard let op = parts.first else { return }
    switch op {
    case "show" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) {
            controller.show(x: x, y: y, animate: false)
            effects.fogFocus(x: x, y: y)
        }
    case "move" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { controller.show(x: x, y: y, animate: true) }
    case "click":
        controller.press(count: parts.count >= 2 ? Int(parts[1]) ?? 1 : 1)
    case "down":
        controller.down()
    case "up":
        controller.up()
    case "scroll":
        controller.scroll(parts.count >= 2 ? CGFloat(Double(parts[1]) ?? 1) : 1)
    case "label":
        controller.label(parts.count >= 2 ? String(line.dropFirst(op.count + 1)) : "")
    case "hide":
        controller.hide()
    case "ping":
        let a = controller.spring
        let line = String(format: "pong visible=%d pos=%.0f,%.0f target=%.0f,%.0f vel=%.0f stretch=%.3f tilt=%.3f tag=%.0f\n",
                          controller.visible ? 1 : 0,
                          a.pos.x, a.pos.y, a.target.x, a.target.y,
                          hypot(a.vel.x, a.vel.y), controller.stretch, controller.tilt, controller.tagW)
        FileHandle.standardError.write(line.data(using: .utf8)!)
    case "lens" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { effects.showLens(x: x, y: y) }
    case "lenshide":
        effects.hideLens()
    case "fog":
        effects.setFog(parts.count >= 2 && parts[1] == "on")
    case "fogfocus" where parts.count >= 3:
        if let x = Double(parts[1]), let y = Double(parts[2]) { effects.fogFocus(x: x, y: y) }
    case "quit":
        controller.hide(); effects.hideLens(); effects.setFog(false)
        exit(0)
    default:
        break
    }
}

// Poll the FIFO with a DispatchSource (the write end would block with no reader, so the fd stays open)
let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
var buffer = Data()
src.setEventHandler {
    var chunk = [UInt8](repeating: 0, count: 4096)
    let n = read(fd, &chunk, chunk.count)
    if n > 0 {
        buffer.append(contentsOf: chunk[0..<n])
        while let nl = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: buffer.startIndex..<nl)
            buffer.removeSubrange(buffer.startIndex...nl)
            if let s = String(data: lineData, encoding: .utf8) {
                handle(s.trimmingCharacters(in: .whitespaces))
            }
        }
    }
}
src.resume()

// ---- Idle self-exit ----
// Exit and remove the FIFO when no commands arrive for longer than idleSeconds. A single action shouldn't leave the user a resident process.
let idleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
    if Date().timeIntervalSince(lastActivity) >= idleSeconds && !controller.exiting {
        controller.exiting = true
        controller.fadeOut {
            controller.hide(); effects.hideLens(); effects.setFog(false)
            try? FileManager.default.removeItem(atPath: fifoPath)
            exit(0)
        }
    }
}
RunLoop.main.add(idleTimer, forMode: .common)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)   // no Dock icon, no Cmd-Tab entry, never steals focus
app.run()
