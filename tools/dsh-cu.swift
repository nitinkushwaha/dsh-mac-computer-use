// dsh-cu — a minimal macOS computer use command line
//
// Why this exists: cua-driver (the native driver the dsh-computer-use plugin depends on) has an
// unfixed upstream bug on macOS 26 — its daemon always gets 0 AXWindows over AX
// (trycua/cua#4039; environment identical to ours). Yet on the same machine, **processes spawned by DSH**
// work over AX perfectly fine (this file is the proof). So this reimplements it directly on the system AX API.
//
// Design principles (**vision-first**, because third-party binaries' AX is broken on this machine):
//   * Find windows: CGWindowListCopyWindowInfo — needs no permissions, gives pid + exact bounds
//   * See: screencapture screenshots (DSH already holds Screen Recording permission)
//   * Click: CGEvent delivered to the target process via postToPid — **doesn't move the real mouse, doesn't steal focus**
//   * Type: CGEvent + keyboardSetUnicodeString, likewise delivered to the target process (supports Chinese)
//   * AX commands are kept, but unreliable on this machine (elements under kAXWindowsAttribute report role AXApplication,
//     so AXWindow is never reachable; AppleScript works fine in the same environment, meaning third-party binaries' AX is restricted)
//
// Usage:
//   dsh-cu windows                     List apps that have windows
//   dsh-cu tree <pid> [--limit N]      Print the AX tree (with [i] indices)
//   dsh-cu click <pid> <i>             Click the i-th element (AXPress, most reliable)
//   dsh-cu clickat <pid> <x> <y> [--global] [--no-cursor]  Click at screen coordinates (real mouse untouched by default; syncs the overlay cursor)
//   dsh-cu type <pid> <text>           Type text into the target process (supports Chinese)
//   dsh-cu key <pid> <keycode> [flags] Press a key (flags: cmd/shift/alt/ctrl, combinable)
//   dsh-cu find <text> [--pid N]       OCR-find on-screen text → prints clickable coordinates (all displays when pid is omitted)
//   dsh-cu observe <pid> [--out path] [--limit N]  **set-of-mark**: numbers the clickable elements on a screenshot
//   dsh-cu click-index <pid> <number> [--no-cursor]  Clicks the element with that number (syncs the overlay cursor)
//   dsh-cu scroll-lines <pid> <x> <y> <dy> [dx] [--no-cursor]   Scroll wheel, unit "rows": dy positive = down, dx positive = right (syncs the overlay cursor;
//                                      old name scroll still works. The plugin uses the new name — an old engine that doesn't recognize it fails outright instead of scrolling by pixels in the opposite direction)
//   dsh-cu drag <pid> <x1> <y1> <x2> <y2> [--no-cursor]   Drag (syncs the overlay cursor)
//   dsh-cu apps                             List running apps (* = foreground)
//   dsh-cu launch <bundleId|app name>          Launch an app in the background (doesn't steal focus; the app name can be a localized name, e.g. Calculator)
//   dsh-cu shot [--out path] [--rect x,y,w,h | --pid N | --window window-number]  Screenshot (main display by default). Image comes out in "points":
//                                      image (u,v) = screen (rect.x+u, rect.y+v); the rect is printed on the second output line.
//                                      --pid / --window capture the window itself by window number (works even when covered by other windows), falling back to a screen-area capture if that fails
//   dsh-cu version                     Protocol version (the plugin checks it first; on mismatch, rerun install.sh)
//   dsh-cu features                    Additions that keep the protocol version (one per line). The plugin uses this to hint "the engine can be updated" without blocking use
//
// Click / type / key / scroll / drag / observe need Accessibility permission (without it the system silently drops synthetic events); missing permission fails right away.

import ApplicationServices
import AppKit
import Foundation
import ImageIO
import Vision

// ── Utility functions ────────────────────────────────────────────────────────────────

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func attr(_ el: AXUIElement, _ name: String) -> CFTypeRef? {
    var out: CFTypeRef?
    guard AXUIElementCopyAttributeValue(el, name as CFString, &out) == .success else { return nil }
    return out
}

func str(_ el: AXUIElement, _ name: String) -> String? {
    attr(el, name) as? String
}

func children(_ el: AXUIElement) -> [AXUIElement] {
    (attr(el, kAXChildrenAttribute as String) as? [AXUIElement]) ?? []
}

func frame(_ el: AXUIElement) -> CGRect? {
    guard let pv = attr(el, kAXPositionAttribute as String),
          let sv = attr(el, kAXSizeAttribute as String) else { return nil }
    var p = CGPoint.zero
    var s = CGSize.zero
    AXValueGetValue(pv as! AXValue, .cgPoint, &p)
    AXValueGetValue(sv as! AXValue, .cgSize, &s)
    return CGRect(origin: p, size: s)
}

/// Readable label for an element in the tree: prefers title / description / value
func label(_ el: AXUIElement) -> String {
    for k in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXRoleDescriptionAttribute] {
        if let v = str(el, k as String), !v.isEmpty { return v }
    }
    return ""
}

func appsWithWindows() -> [(pid_t, String, Int)] {
    NSWorkspace.shared.runningApplications
        .filter { $0.activationPolicy == .regular }
        .compactMap { app in
            let pid = app.processIdentifier
            let ax = AXUIElementCreateApplication(pid)
            let wins = (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
            guard !wins.isEmpty else { return nil }
            return (pid, app.localizedName ?? "?", wins.count)
        }
}

/// Whether the target process is still alive (kill 0 only probes, sends no signal; EPERM = alive, just not owned by us).
/// Posting events to a dead process doesn't error, so the tool would falsely report success
func requireAlive(_ pid: pid_t) {
    guard pid > 0, kill(pid, 0) == 0 || errno == EPERM else {
        fail("Process \(pid) is gone (did the app quit?). Use desktop_apps / desktop_windows to get a fresh pid")
    }
}

/// Without Accessibility permission the system silently drops posted click / keyboard / scroll events and AX reads no elements — fail outright instead of falsely reporting success
func requireAX() {
    guard AXIsProcessTrusted() else {
        fail("No Accessibility permission: clicks, typing, key presses and scrolling will be dropped outright by the system. Enable the DeepSeek Harness toggle under System Settings → Privacy & Security → Accessibility, then retry")
    }
}

/// Protocol version agreed with the plugin (ENGINE_PROTOCOL in plugin/index.js). When arguments or output format change, bump both sides by 1 together:
/// the plugin auto-updates with DSH while the engine needs a manual install.sh rerun; on mismatch the plugin uses this to stop rather than continue
let ENGINE_PROTOCOL = 2

/// FIFO for the cursor overlay: under the user's private temp dir (DARWIN_USER_TEMP_DIR, 0700) where other accounts can't grab it or read it.
/// The plugin (getconf DARWIN_USER_TEMP_DIR) and the overlay use the same algorithm
func cursorFifoPath() -> String {
    var buf = [CChar](repeating: 0, count: Int(PATH_MAX))
    let dir = confstr(_CS_DARWIN_USER_TEMP_DIR, &buf, buf.count) > 0 ? String(cString: buf) : NSTemporaryDirectory()
    return (dir as NSString).appendingPathComponent("dsh-cursor.fifo")
}
let cursorFifo = cursorFifoPath()

/// Screenshot scratch files live here: a 0700 subdir of the user's own temp dir (NSTemporaryDirectory), removed wholesale when the process exits
var scratchDir: String?

func privateTemp(_ name: String) -> String {
    if scratchDir == nil {
        let d = (NSTemporaryDirectory() as NSString).appendingPathComponent("dsh-cu-\(getpid())-\(UUID().uuidString.prefix(8))")
        do {
            try FileManager.default.createDirectory(atPath: d, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } catch { fail("Can't create temp directory \(d): \(error.localizedDescription)") }
        scratchDir = d
        atexit { if let d = scratchDir { try? FileManager.default.removeItem(atPath: d) } }
    }
    return (scratchDir! as NSString).appendingPathComponent(name)
}

/// Clickable-element enumeration shared by observe numbering and click-index: same rules, same order, so the numbers line up
let INTERACTIVE: Set<String> = ["AXButton", "AXTextField", "AXTextArea", "AXLink", "AXCheckBox",
                                "AXRadioButton", "AXPopUpButton", "AXMenuItem", "AXTab", "AXSlider",
                                "AXSearchField", "AXComboBox", "AXDisclosureTriangle", "AXIncrementor"]

func interactiveElements(in win: AXUIElement, limit: Int) -> [(role: String, label: String, rect: CGRect, el: AXUIElement)] {
    let wf = frame(win) ?? .zero
    var marks: [(role: String, label: String, rect: CGRect, el: AXUIElement)] = []
    var seen = Set<CFHashCode>()
    func collect(_ el: AXUIElement, _ depth: Int) {
        guard depth <= 20, marks.count < limit else { return }
        let h = CFHash(el); if seen.contains(h) { return }; seen.insert(h)
        let role = str(el, kAXRoleAttribute as String) ?? "?"
        if INTERACTIVE.contains(role), let f = frame(el), f.width >= 4, f.height >= 4,
           f.midX >= wf.minX - 2, f.midX <= wf.maxX + 2, f.midY >= wf.minY - 2, f.midY <= wf.maxY + 2 {
            marks.append((role, label(el), f, el))
        }
        for c in children(el) { collect(c, depth + 1) }
    }
    collect(win, 0)
    return marks
}

// ── Subcommands ──────────────────────────────────────────────────────────────────

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("Usage: see the header comment at the top of this file") }

/// Look up a value by flag name (--out path, --limit N …). Can't take "the last argument" as the value: appending --no-cursor or the like afterwards would break everything
func argValue(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// --limit accepts positive integers only; falls back to the default when omitted
func limitArg(_ def: Int) -> Int {
    guard let v = argValue("--limit") else { return def }
    guard let n = Int(v), n > 0 else { fail("--limit must be a positive integer, got \"\(v)\"") }
    return n
}

switch cmd {

case "version":
    print(ENGINE_PROTOCOL)

case "features":
    // window-shot: observe / find --pid / shot --pid capture the window itself by window number
    print("window-shot")

case "winlist":
    // CGWindowList: doesn't rely on AX; yields pid / title / exact bounds / layer
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in info {
        let layer = w[kCGWindowLayer as String] as? Int ?? -1
        guard layer == 0 else { continue }                      // ordinary windows only
        let pid = w[kCGWindowOwnerPID as String] as? Int ?? 0
        let name = w[kCGWindowOwnerName as String] as? String ?? "?"
        let title = w[kCGWindowName as String] as? String ?? ""
        guard let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { continue }
        let wid = w[kCGWindowNumber as String] as? Int ?? 0
        print("\(pid)\t\(wid)\t\(name)\t\(title)\t\(Int(b["X"] ?? 0)),\(Int(b["Y"] ?? 0)) \(Int(b["Width"] ?? 0))×\(Int(b["Height"] ?? 0))")
    }

case "windows":
    for (pid, name, _) in appsWithWindows() {
        let ax = AXUIElementCreateApplication(pid)
        let wins = (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
        for w in wins {
            let f = frame(w)
            let t = str(w, kAXTitleAttribute as String) ?? ""
            let box = f.map { "(\(Int($0.origin.x)),\(Int($0.origin.y)) \(Int($0.width))×\(Int($0.height)))" } ?? ""
            print("\(pid)\t\(name)\t\(t)\t\(box)")
        }
    }

case "tree":
    guard args.count >= 2, let pid = pid_t(args[1]) else { fail("Usage: dsh-cu tree <pid>") }
    let limit = limitArg(200)
    var index = 0
    var seen = Set<CFHashCode>()
    let ax = AXUIElementCreateApplication(pid)
    func walk(_ el: AXUIElement, _ depth: Int) {
        guard index < limit, depth <= 20 else { return }
        let h = CFHash(el)
        if seen.contains(h) { return }          // cycle detection: the AX tree contains self-references
        seen.insert(h)
        let role = str(el, kAXRoleAttribute as String) ?? "?"
        let lab = label(el)
        let f = frame(el)
        let pos = f.map { "@\(Int($0.midX)),\(Int($0.midY))" } ?? ""
        let pad = String(repeating: "  ", count: depth)
        print("[\(index)]\(pad) \(role) \(lab.isEmpty ? "" : "«\(lab.prefix(60))»") \(pos)")
        index += 1
        for c in children(el) { walk(c, depth + 1) }
    }
    // Start from windows — walking from the application hits the menu bar and self-references first
    for w in (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] { walk(w, 0) }

case "click":
    guard args.count >= 3, let pid = pid_t(args[1]), let want = Int(args[2]) else { fail("Usage: dsh-cu click <pid> <index>") }
    requireAlive(pid)
    requireAX()
    let ax = AXUIElementCreateApplication(pid)
    var index = 0
    var target: AXUIElement?
    var seen2 = Set<CFHashCode>()
    func find(_ el: AXUIElement, _ depth: Int) {
        guard target == nil, depth <= 20 else { return }
        let h = CFHash(el)
        if seen2.contains(h) { return }
        seen2.insert(h)
        if index == want { target = el; return }
        index += 1
        for c in children(el) { find(c, depth + 1) }
    }
    for w in (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? [] { find(w, 0) }
    guard let el = target else { fail("No element #\(want)") }
    var err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success {
        // fall back to a coordinate click when there's no AXPress
        guard let f = frame(el) else { fail("Element can't be pressed and has no coordinates") }
        err = postClick(pid: pid, at: CGPoint(x: f.midX, y: f.midY)) ? .success : .failure
    }
    guard err == .success else { fail("Click failed (\(err.rawValue))") }
    print("Clicked [\(want)] \(label(el).prefix(40))")

case "clickat":
    guard args.count >= 4, let pid = pid_t(args[1]), let x = Double(args[2]), let y = Double(args[3]) else {
        fail("Usage: dsh-cu clickat <pid> <x> <y> [--global]")
    }
    requireAlive(pid)
    requireAX()
    let global = args.contains("--global")
    cursorOverlayOff = args.contains("--no-cursor")
    if !cursorOverlayOff { ensureOverlay() }
    // The cursor glides over on its own (spring + stretch along the direction of motion + click recoil) — that's the whole set of Codex cursor effects.
    // The dimming / spinning orb are other Codex features, not the cursor, so they're off by default; set DSH_CU_FX=full to get them
    let fx = ProcessInfo.processInfo.environment["DSH_CU_FX"] ?? ""
    overlayPing("move \(Int(x)) \(Int(y))")
    if fx == "full" {
        overlayPing("fog on")
        overlayPing("lens \(Int(x)) \(Int(y))")
    }
    usleep(300_000)                                    // wait for it to glide into place, then click
    overlayPing("click")
    guard postClick(pid: pid, at: CGPoint(x: x, y: y), global: global) else { fail("Click failed (couldn't create the mouse event, or the target process exited midway)") }
    print("Clicked (\(Int(x)), \(Int(y)))\(global ? " [real mouse]" : " [delivered to pid, mouse untouched]")")

case "type":
    guard args.count >= 3, let pid = pid_t(args[1]) else { fail("Usage: dsh-cu type <pid> <text>") }
    requireAlive(pid)
    requireAX()
    let text = args.dropFirst(2).joined(separator: " ")
    makeMainWindow(pid: pid)
    guard postText(pid: pid, text) else { fail("Typing failed (couldn't create the keyboard event, or the target process exited midway)") }
    print("Typed \(text.count) characters")

case "key":
    guard args.count >= 3, let pid = pid_t(args[1]), let code = UInt16(args[2]) else { fail("Usage: dsh-cu key <pid> <keycode> [cmd|shift|alt|ctrl]") }
    requireAlive(pid)
    requireAX()
    var flags: CGEventFlags = []
    for f in args.dropFirst(3) {
        switch f {
        case "cmd": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt": flags.insert(.maskAlternate)
        case "ctrl": flags.insert(.maskControl)
        default: break
        }
    }
    makeMainWindow(pid: pid)
    let src = quietSource()
    for down in [true, false] {
        guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { fail("Key press failed (couldn't create the keyboard event)") }
        e.flags = flags
        e.postToPid(pid)
        usleep(20_000)                                 // posting is async: exiting right after the send occasionally drops the key-up
    }
    if flags.contains(.maskCommand), NSRunningApplication(processIdentifier: pid)?.isActive == false {
        // A background app does receive the press (the page's own shortcuts still work), but menu-driven ones like select-all / copy / paste won't run. Say so honestly instead of claiming success
        print("Pressed key \(code) (with ⌘; target in background: system shortcuts like select-all/copy/paste may not take effect — verify with a screenshot)")
    } else {
        print("Pressed key \(code)")
    }

case "find":
    // OCR-find text → return screen coordinates. This is what makes the vision route genuinely usable:
    // the agent says "click the Sign in button" instead of guessing coordinates.
    guard args.count >= 2 else { fail("Usage: dsh-cu find <text> [--pid N] [--all]") }
    let needle = args[1]
    let showAll = args.contains("--all")
    // Each image is paired with the rect it covers: in screenshot mode those are global screen points (each display's own origin and scale already converted inside capture),
    // in --file mode they are image pixels
    var shots: [(image: CGImage, covered: CGRect)] = []
    if let file = argValue("--file") {
        // OCR the image file directly (no screenshot)
        guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: file) as CFURL, nil),
              let cg = CGImageSourceCreateImageAtIndex(src, 0, nil) else { fail("Can't read image: \(file)") }
        shots = [(cg, CGRect(x: 0, y: 0, width: cg.width, height: cg.height))]
    } else if let p = argValue("--pid") {
        guard let pid = pid_t(p) else { fail("--pid must be a number") }
        guard let w = windowInfosOf(pid).first else { fail(noWindow(pid)) }
        shots = [captureWindow(w)]              // capture just this window (it comes out even when covered) and only match text inside it
    } else {
        shots = displays().map { capture($0) }          // search every display
        if shots.isEmpty { fail("No display found") }
    }

    let want = needle.lowercased()
    var hits: [(String, CGPoint, Float)] = []
    var seenText = 0
    for (cg, covered) in shots {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = ["zh-Hans", "en-US"]
        req.usesLanguageCorrection = true
        let handler = VNImageRequestHandler(cgImage: cg, options: [:])
        do { try handler.perform([req]) } catch { fail("OCR failed: \(error.localizedDescription)") }
        seenText += (req.results ?? []).count
        for obs in (req.results ?? []) {
            guard let top = obs.topCandidates(1).first else { continue }
            let matchAll = want.isEmpty || want == "*"      // Swift's contains("") is false, so handle it separately
            guard matchAll || top.string.lowercased().contains(want) else { continue }
            let bb = obs.boundingBox                        // normalized, bottom-left origin
            let sx = covered.minX + bb.midX * covered.width
            let sy = covered.minY + (1 - bb.midY) * covered.height   // converted to top-left origin
            hits.append((top.string, CGPoint(x: sx, y: sy), top.confidence))
        }
    }
    if hits.isEmpty {
        print("Didn't find \"\(needle)\" (OCR recognized \(seenText) text segments)")
        exit(2)
    }
    hits.sort { $0.2 > $1.2 }
    for (i, h) in (showAll ? hits : [hits[0]]).enumerated() {
        print("\(i)\t\(Int(h.1.x)),\(Int(h.1.y))\t\(String(format: "%.2f", h.2))\t\(h.0)")
    }

case "observe":
    // set-of-mark: number the clickable elements on the screenshot so the model can say "click #7" instead of guessing coordinates
    guard args.count >= 2, let pid = pid_t(args[1]) else { fail("Usage: dsh-cu observe <pid> [--out path] [--limit N]") }
    let outPath = argValue("--out") ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("dsh-cu-mark-\(pid).png")
    let maxMark = limitArg(60)
    requireAlive(pid)
    requireAX()

    guard let win = windowsOfAX(pid).first else { fail("pid \(pid) has no AX windows (app may not be running or has no windows)") }
    let winFrame = frame(win) ?? .zero
    guard winFrame.width > 1, winFrame.height > 1 else { fail("Can't get the window size") }

    let marks = interactiveElements(in: win, limit: maxMark)
    if marks.isEmpty { fail("No interactive elements found in this window") }

    // Capture the window itself (works even when covered by other windows): match the AX window to a CGWindowList window number by position and size; fall back to a screen-area capture on mismatch
    // (cropped using the origin and scale of the display the window is on — Retina / secondary displays / negative coordinates all handled). Image comes out at "point" size
    let near = { (a: CGFloat, b: CGFloat) in abs(a - b) < 2 }
    let cgWin = windowInfosOf(pid).first {
        near($0.rect.minX, winFrame.minX) && near($0.rect.minY, winFrame.minY) &&
        near($0.rect.width, winFrame.width) && near($0.rect.height, winFrame.height)
    }
    let (shot, covered) = cgWin.map { captureWindow($0) } ?? capture(winFrame)
    let W = max(1, Int(covered.width.rounded())), H = max(1, Int(covered.height.rounded()))
    let scale = CGFloat(W) / covered.width
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: W, pixelsHigh: H, bitsPerSample: 8, samplesPerPixel: 4,
                                     hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let gc = NSGraphicsContext(bitmapImageRep: rep) else { fail("Can't draw the annotation image") }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = gc
    let ctx = gc.cgContext
    ctx.interpolationQuality = .high
    ctx.draw(shot, in: CGRect(x: 0, y: 0, width: W, height: H))
    ctx.setLineWidth(2)
    for (i, m) in marks.enumerated() {
        // screen coords → image coords (origin is bottom-left, so flip y)
        let x = (m.rect.minX - covered.minX) * scale
        let y = CGFloat(H) - (m.rect.maxY - covered.minY) * scale
        let w = m.rect.width * scale, hh = m.rect.height * scale
        ctx.setStrokeColor(NSColor.systemBlue.withAlphaComponent(0.9).cgColor)
        ctx.stroke(CGRect(x: x, y: y, width: w, height: hh))
        let tag = "\(i + 1)"
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.boldSystemFont(ofSize: 13),
            .foregroundColor: NSColor.white,
        ]
        let ts = NSAttributedString(string: tag, attributes: attrs)
        let sz = ts.size()
        let bx = x, by = y + hh - sz.height - 2
        ctx.setFillColor(NSColor.systemBlue.cgColor)
        ctx.fill(CGRect(x: bx, y: by, width: sz.width + 6, height: sz.height + 2))
        ts.draw(at: NSPoint(x: bx + 3, y: by + 1))
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = rep.representation(using: .png, properties: [:]) else { fail("Can't encode the annotation image") }
    do { try png.write(to: URL(fileURLWithPath: outPath)) } catch { fail("Can't write the annotation image to \(outPath): \(error.localizedDescription)") }

    // While observing, glide the cursor to the window center to signal "I'm looking at this"
    if !args.contains("--no-cursor") {
        ensureOverlay()
        overlayPing("move \(Int(winFrame.midX)) \(Int(winFrame.midY))")
        if ProcessInfo.processInfo.environment["DSH_CU_FX"] == "full" {
            overlayPing("fog on")
            overlayPing("lens \(Int(winFrame.midX)) \(Int(winFrame.midY))")
        }
    }
    print(outPath)
    print("window\t\(Int(winFrame.minX)),\(Int(winFrame.minY)) \(Int(winFrame.width))×\(Int(winFrame.height))")
    for (i, m) in marks.enumerated() {
        print("\(i + 1)\t\(m.role)\t\(m.label.prefix(50))\t\(Int(m.rect.midX)),\(Int(m.rect.midY))")
    }

case "click-index":
    guard args.count >= 3, let pid = pid_t(args[1]), let want = Int(args[2]) else { fail("Usage: dsh-cu click-index <pid> <number> [--no-cursor]") }
    requireAlive(pid)
    requireAX()
    guard let win = windowsOfAX(pid).first else { fail("No AX windows") }
    guard want >= 1 else { fail("Numbering starts at 1") }
    // Same enumeration and order as observe; stop once the want-th is counted — however many observe marked, the numbers line up
    let marks = interactiveElements(in: win, limit: want)
    guard want <= marks.count else { fail("Number out of range (1...\(marks.count))") }
    let el = marks[want - 1].el
    // Glide the cursor to the element's center with a nameplate naming what will be clicked, then press (same rhythm as clickat)
    cursorOverlayOff = args.contains("--no-cursor")
    if !cursorOverlayOff, let f = frame(el) {
        ensureOverlay()
        let name = label(el).replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespaces)
        overlayPing(name.isEmpty ? "label click" : "label click \(name.count > 14 ? String(name.prefix(13)) + "…" : name)")
        overlayPing("move \(Int(f.midX)) \(Int(f.midY))")
        usleep(300_000)
        overlayPing("click")
    }
    var err = AXUIElementPerformAction(el, kAXPressAction as CFString)
    if err != .success, let f = frame(el) {
        err = postClick(pid: pid, at: CGPoint(x: f.midX, y: f.midY)) ? .success : .failure
    }
    guard err == .success else { fail("Click failed (\(err.rawValue))") }
    print("Clicked [\(want)] \(label(el).prefix(40))")

case "scroll", "scroll-lines":
    guard args.count >= 5, let pid = pid_t(args[1]), let x = Double(args[2]), let y = Double(args[3]), let rawDy = Int32(args[4]) else {
        fail("Usage: dsh-cu scroll <pid> <x> <y> <dy> [dx] [--no-cursor]")
    }
    requireAlive(pid)
    requireAX()
    // Unit is "rows"; convention: dy positive = scroll down, dx positive = right. Clamped to ±1000 so the negation below can't overflow
    let dy = max(-1000, min(1000, rawDy))
    let dx = max(-1000, min(1000, args.count >= 6 ? Int32(args[5]) ?? 0 : 0))
    // Glide the cursor to the scroll position, then flash the scroll direction in the top-right corner
    cursorOverlayOff = args.contains("--no-cursor")
    if !cursorOverlayOff {
        ensureOverlay()
        overlayPing("move \(Int(x)) \(Int(y))")
        usleep(300_000)
        overlayPing("scroll \(dy < 0 ? -1 : 1)")
    }
    // CGEvent wheel values run opposite to the convention (wheel1 positive = up, wheel2 positive = left), hence the negation
    guard let e = CGEvent(scrollWheelEvent2Source: quietSource(),
                          units: .line, wheelCount: 2, wheel1: -dy, wheel2: -dx, wheel3: 0) else { fail("Can't create the scroll event") }
    e.location = CGPoint(x: x, y: y)
    tagWindow(e, window: targetWindow(pid: pid, at: e.location), at: e.location)
    e.postToPid(pid)
    usleep(50_000)                                     // posting is async: exiting right after the send occasionally drops the event
    print("Scrolled dy=\(dy) dx=\(dx) rows @(\(Int(x)),\(Int(y)))")

case "drag":
    guard args.count >= 6, let pid = pid_t(args[1]),
          let x1 = Double(args[2]), let y1 = Double(args[3]),
          let x2 = Double(args[4]), let y2 = Double(args[5]) else {
        fail("Usage: dsh-cu drag <pid> <x1> <y1> <x2> <y2> [--no-cursor]")
    }
    requireAlive(pid)
    requireAX()
    // Cursor: glide to the start point, press and hold (a halo around the tip), follow each step to the endpoint, then release — just like a browser drag
    cursorOverlayOff = args.contains("--no-cursor")
    if !cursorOverlayOff {
        ensureOverlay()
        overlayPing("move \(Int(x1)) \(Int(y1))")
        usleep(300_000)
        overlayPing("down")
    }
    let src = quietSource()
    let from = CGPoint(x: x1, y: y1), to = CGPoint(x: x2, y: y2)
    // Attribute the whole drag to the window that was under the press (AppKit likewise routes drag and release to the window that received the press)
    let win = targetWindow(pid: pid, at: from)
    let commandPress = needsCommandPress(pid: pid)       // same as postClick: the press on a background Chromium window carries ⌘
    func post(_ type: CGEventType, _ pt: CGPoint) {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: pt, mouseButton: .left) else { return }
        e.setIntegerValueField(.mouseEventClickState, value: 1)
        tagWindow(e, window: win, at: pt)
        e.flags = commandPress && type == .leftMouseDown ? .maskCommand : []
        e.postToPid(pid)
    }
    post(.leftMouseDown, from)
    let steps = 12
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let pt = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
        post(.leftMouseDragged, pt)
        overlayPing("show \(Int(pt.x)) \(Int(pt.y))")
        usleep(15_000)
    }
    post(.leftMouseUp, to)
    usleep(50_000)                                     // wait for the release to land before exiting, or it occasionally drops and the target thinks the button is still down
    overlayPing("up")
    print("Dragged (\(Int(x1)),\(Int(y1))) → (\(Int(x2)),\(Int(y2)))")

case "apps":
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        let front = app.isActive ? "*" : " "
        print("\(front)\(app.processIdentifier)\t\(app.localizedName ?? "?")\t\(app.bundleIdentifier ?? "")")
    }

case "launch":
    guard args.count >= 2 else { fail("Usage: dsh-cu launch <bundleId or app name>") }
    let target = args[1]
    let cfg = NSWorkspace.OpenConfiguration()
    cfg.activates = false                       // don't steal focus
    let sem = DispatchSemaphore(value: 0)
    var launched: NSRunningApplication?
    // bundleId first; if not found (or the name itself contains dots, e.g. Node.js), look up by name — names match localized names in any language
    var found = target.contains(".") ? NSWorkspace.shared.urlForApplication(withBundleIdentifier: target) : nil
    if found == nil { found = findApp(named: target) }
    if let url = found {
        NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, _ in launched = app; sem.signal() }
        _ = sem.wait(timeout: .now() + 10)
        if let a = launched { print("Launched \(a.localizedName ?? target) in background pid=\(a.processIdentifier)") }
        else { fail("Launch timed out") }
    } else {
        // Fallback: let LaunchServices find it by name (-g = don't steal focus)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        p.arguments = ["-g", "-a", target]
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        do { try p.run() } catch { fail("Can't find app \(target)") }
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            fail("Can't find app \(target) (neither the filename in the app directories nor any localized name matches, and open -a can't find it either; try the bundleId instead)")
        }
        // open doesn't return a pid: look the app up by name among running apps (the RunLoop has to spin for the list to refresh)
        let want = target.lowercased()
        var app: NSRunningApplication?
        for _ in 0..<20 where app == nil {
            app = NSWorkspace.shared.runningApplications.first {
                ($0.localizedName ?? "").lowercased() == want
                    || ($0.bundleURL?.deletingPathExtension().lastPathComponent ?? "").lowercased() == want
            }
            if app == nil { RunLoop.current.run(until: Date().addingTimeInterval(0.25)) }
        }
        if let a = app { print("Launched \(a.localizedName ?? target) in background pid=\(a.processIdentifier)") }
        else { print("Launched \(target) in background (check the pid with desktop_apps)") }
    }

case "shot":
    let out = argValue("--out") ?? (NSTemporaryDirectory() as NSString).appendingPathComponent("dsh-cu-shot.png")
    var rect: CGRect? = nil                     // nil = the whole main display
    var win: (id: CGWindowID, rect: CGRect)? = nil   // with --pid / --window given, capture that window itself
    if let r = argValue("--rect") {
        let n = r.split(separator: ",").compactMap { Double($0) }
        guard n.count == 4, n[2] > 0, n[3] > 0 else { fail("--rect must be x,y,width,height (screen points), got \"\(r)\"") }
        rect = CGRect(x: n[0], y: n[1], width: n[2], height: n[3])
    } else if let p = argValue("--pid") {
        guard let pid = pid_t(p) else { fail("--pid must be a number") }
        guard let w = windowInfosOf(pid).first else { fail(noWindow(pid)) }
        win = w
    } else if let v = argValue("--window") {
        guard let id = CGWindowID(v), let w = windowInfo(id) else { fail("Window \(v) isn't on screen (closed, minimized, or on another desktop space)") }
        win = w
    }
    let (img, covered) = win.map { captureWindow($0) } ?? capture(rect)
    // Scale back to "point" size: 1 image pixel = 1 screen point; adding the rect origin to image coordinates gives the click coordinate
    writePNG(img, to: out, size: covered.size)
    print(out)
    print("rect\t\(Int(covered.minX.rounded())),\(Int(covered.minY.rounded())) \(Int(covered.width.rounded()))×\(Int(covered.height.rounded()))")

default:
    fail("Unknown command: \(cmd)")
}

/// A pid's AX windows (usable once unlocked; not obtainable while the screen is locked)
func windowsOfAX(_ pid: pid_t) -> [AXUIElement] {
    let ax = AXUIElementCreateApplication(pid)
    return (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
}

/// A pid's ordinary windows, frontmost first: window number + screen rect (CGWindowList, no AX needed).
/// Only what's currently visible on screen: minimized windows and other desktop spaces are not included
func windowInfosOf(_ pid: pid_t) -> [(id: CGWindowID, rect: CGRect)] {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    return info.compactMap { w in
        guard (w[kCGWindowLayer as String] as? Int ?? -1) == 0,
              (w[kCGWindowOwnerPID as String] as? Int) == Int(pid) else { return nil }
        return cgWindow(w)
    }
}

/// Find an on-screen ordinary window by window number
func windowInfo(_ id: CGWindowID) -> (id: CGWindowID, rect: CGRect)? {
    let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]] ?? []
    guard let w = info.first, (w[kCGWindowIsOnscreen as String] as? Bool) == true else { return nil }
    return cgWindow(w)
}

func cgWindow(_ w: [String: Any]) -> (id: CGWindowID, rect: CGRect)? {
    guard let n = w[kCGWindowNumber as String] as? Int,
          let b = w[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
    return (CGWindowID(n), CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0))
}

func noWindow(_ pid: pid_t) -> String {
    "pid \(pid) has no visible windows (the app has no open window, its window is minimized, or it's on another desktop space)"
}

/// Find an app by name: matches the filename first, then localized names in any language (a non-English display name still resolves to Calculator.app)
func findApp(named target: String) -> URL? {
    let fm = FileManager.default
    let dirs = ["/System/Applications", "/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
                (NSHomeDirectory() as NSString).appendingPathComponent("Applications")]
    for d in dirs {
        let u = URL(fileURLWithPath: d).appendingPathComponent("\(target).app")
        if fm.fileExists(atPath: u.path) { return u }
    }
    let want = target.lowercased()
    for d in dirs {
        for name in (try? fm.contentsOfDirectory(atPath: d)) ?? [] where name.hasSuffix(".app") {
            let u = URL(fileURLWithPath: d).appendingPathComponent(name)
            if appNames(u).contains(want) { return u }
        }
    }
    return nil
}

/// All names of an app (lowercased): filename, display name in the current language, per-language CFBundleDisplayName / CFBundleName
func appNames(_ url: URL) -> Set<String> {
    let keys = ["CFBundleDisplayName", "CFBundleName"]
    let res = url.appendingPathComponent("Contents/Resources")
    var names = [url.deletingPathExtension().lastPathComponent, FileManager.default.displayName(atPath: url.path)]
    // System apps: all languages' names live in a single InfoPlist.loctable
    if let table = NSDictionary(contentsOf: res.appendingPathComponent("InfoPlist.loctable")) as? [String: Any] {
        for case let d as [String: Any] in table.values { names += keys.compactMap { d[$0] as? String } }
    }
    // Third-party apps: one xx.lproj/InfoPlist.strings per language
    for lproj in (try? FileManager.default.contentsOfDirectory(atPath: res.path)) ?? [] where lproj.hasSuffix(".lproj") {
        let f = res.appendingPathComponent(lproj).appendingPathComponent("InfoPlist.strings")
        if let d = NSDictionary(contentsOf: f) as? [String: Any] { names += keys.compactMap { d[$0] as? String } }
    }
    return Set(names.map { $0.lowercased() })
}

// ── Screenshots: per-display origin and scale ─────────────────────────────────────────────
// CGWindowList / AX / CGEvent all work in global "point" coordinates (origin at the main display's top-left; secondary displays can be negative);
// screencapture outputs a "pixel" image (2x on Retina). The scale is computed from the actual output image, not guessed.
// Capture method: screencapture -R x,y,w,h takes global point coordinates directly (internally it uses ScreenCaptureKit's rect capture),
// so there's no guessing whether -D's display order matches CGGetActiveDisplayList. The rect is clipped to a single display first so the scale is uniform.

/// Active displays (global point coordinates)
func displays() -> [CGRect] {
    var n: UInt32 = 0
    guard CGGetActiveDisplayList(0, nil, &n) == .success, n > 0 else { return [] }
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(n))
    guard CGGetActiveDisplayList(n, &ids, &n) == .success else { return [] }
    return ids.prefix(Int(n)).map { CGDisplayBounds($0) }
}

/// Capture target: clip the rect to the display it overlaps most (largest intersection), integral-aligned; rect nil = the whole main display.
/// Returns (the global rect to capture, the display it's on); nil when it's on no display
func captureTarget(_ rect: CGRect?, displays all: [CGRect], main: CGRect) -> (want: CGRect, screen: CGRect)? {
    guard let r = rect else { return (main, main) }
    let area = { (x: CGRect) -> CGFloat in x.isNull ? 0 : x.width * x.height }
    guard let b = all.filter({ area($0.intersection(r)) > 0 })
                     .max(by: { area($0.intersection(r)) < area($1.intersection(r)) }) else { return nil }
    let want = r.intersection(b).integral.intersection(b)
    guard !want.isNull, want.width >= 1, want.height >= 1 else { return nil }
    return (want, b)
}

/// The -R argument for screencapture (global points, integers). Written flush against -R so negative coordinates aren't mistaken for another option
func rectArg(_ r: CGRect) -> String {
    "-R\(Int(r.minX)),\(Int(r.minY)),\(Int(r.width)),\(Int(r.height))"
}

/// The capture only counts as correct when the image matches the requested rect's proportions (scale = pixels / points)
func fits(_ img: CGImage, _ r: CGRect) -> Bool {
    let sx = CGFloat(img.width) / r.width, sy = CGFloat(img.height) / r.height
    return sx >= 0.5 && abs(sx - sy) < 0.05
}

/// Run screencapture once (-x keeps it silent) and read the image into memory; returns nil plus a reason on failure
func screencapture(_ opts: String...) -> (image: CGImage?, error: String) {
    let tmp = privateTemp("shot-\(UUID().uuidString.prefix(8)).png")
    defer { try? FileManager.default.removeItem(atPath: tmp) }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    p.arguments = ["-x"] + opts + [tmp]
    p.standardOutput = FileHandle.nullDevice
    let errPipe = Pipe()
    p.standardError = errPipe
    do { try p.run() } catch { return (nil, "couldn't launch screencapture: \(error.localizedDescription)") }
    let errText = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    p.waitUntilExit()
    // Read the whole file into memory before deleting it: CGImageSource may re-read the file on demand
    guard p.terminationStatus == 0, let data = FileManager.default.contents(atPath: tmp),
          let src = CGImageSourceCreateWithData(data as CFData, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        return (nil, "screencapture \(opts.joined(separator: " ")) exit code \(p.terminationStatus)\(errText.isEmpty ? "" : ": \(errText)")")
    }
    return (img, "")
}

/// Capture a rect (global points); rect nil = the whole main display. Returns the pixel image plus the global rect it actually covers (parts past the screen edge are cropped)
func capture(_ rect: CGRect?) -> (image: CGImage, covered: CGRect) {
    let main = CGDisplayBounds(CGMainDisplayID())
    guard let t = captureTarget(rect, displays: displays(), main: main) else {
        fail(rect == nil ? "No display found" : "The window isn't within any display's visible area")
    }
    let shot = screencapture(rectArg(t.want))
    if let img = shot.image {
        guard fits(img, t.want) else {
            fail("Captured image (\(img.width)×\(img.height) px) doesn't match the requested rect (\(Int(t.want.width))×\(Int(t.want.height)) pt); coordinates can't be converted")
        }
        return (img, t.want)
    }
    // When -R fails: if the target is on the main display, fall back to a full-display capture and crop (-D1 is documented as the main display, so the index can't be wrong); secondary displays have no reliable fallback, so fail outright
    if t.screen == main, let full = screencapture("-D1").image, fits(full, main),
       let cropped = full.cropping(to: pixelRect(t.want, screen: main, imageWidth: full.width, imageHeight: full.height)) {
        return (cropped, t.want)
    }
    fail("Screenshot failed (\(shot.error)). Most likely DSH lacks Screen Recording permission, or the screen is locked")
}

/// Capture the window itself (-l window number, -o no shadow): captured even when covered by other windows or in the background; the image covers exactly the window rect.
/// Falls back to a screen-area capture when the window capture fails (window just closed, special windows) or the size doesn't match
func captureWindow(_ w: (id: CGWindowID, rect: CGRect)) -> (image: CGImage, covered: CGRect) {
    if w.rect.width >= 1, w.rect.height >= 1, let img = screencapture("-o", "-l\(w.id)").image, fits(img, w.rect) {
        return (img, w.rect)
    }
    return capture(w.rect)
}

/// Global point rect → pixel rect within that display's capture: subtract the display origin, then multiply by that display's scale
func pixelRect(_ r: CGRect, screen b: CGRect, imageWidth: Int, imageHeight: Int) -> CGRect {
    let sx = CGFloat(imageWidth) / b.width, sy = CGFloat(imageHeight) / b.height
    return CGRect(x: (r.minX - b.minX) * sx, y: (r.minY - b.minY) * sy, width: r.width * sx, height: r.height * sy).integral
}

/// Write a PNG; when size is given, first scale to that pixel size (passing a "point" size = 1 image pixel per screen point)
func writePNG(_ img: CGImage, to path: String, size: CGSize? = nil) {
    var out = img
    if let s = size {
        let w = max(1, Int(s.width.rounded())), h = max(1, Int(s.height.rounded()))
        if w != img.width || h != img.height {
            guard let space = CGColorSpace(name: CGColorSpace.sRGB),
                  let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { fail("Failed to scale the screenshot") }
            ctx.interpolationQuality = .high
            ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
            guard let scaled = ctx.makeImage() else { fail("Failed to scale the screenshot") }
            out = scaled
        }
    }
    guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else {
        fail("Can't write \(path)")
    }
    CGImageDestinationAddImage(dest, out, nil)
    guard CGImageDestinationFinalize(dest) else { fail("Can't write \(path)") }
}

// ── System-level cursor overlay sync ──────────────────────────────────────────────────────
// Uses the resident NSPanel overlay at ~/.dsh/bin/dsh-cursor: during actions the cursor floats over,
// there to watch if the user wants to; it doesn't steal focus and is click-through, so it affects nothing.
// Skipped silently when the overlay isn't running.

var cursorOverlayOff = false

/// FIFO opens in non-blocking mode = there's a reader = the overlay is alive and receiving commands
func overlayReady() -> Bool {
    let fd = open(cursorFifo, O_WRONLY | O_NONBLOCK)
    guard fd >= 0 else { return false }
    close(fd)
    return true
}

func overlayRunning() -> Bool {
    let probe = Process()
    probe.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    probe.arguments = ["-U", String(getuid()), "-f", "dsh-cursor-overlay"]   // only this account's counts; an overlay run by another account doesn't
    probe.standardOutput = FileHandle.nullDevice
    probe.standardError = FileHandle.nullDevice
    try? probe.run(); probe.waitUntilExit()
    return probe.terminationStatus == 0
}

/// Start the overlay when it isn't running (same idea as the plugin's ensureCursor, so the CLI on its own still gets the effects)
func ensureOverlay() {
    if overlayReady() { return }
    // Process alive but FIFO not ready = just started (the first launch of a freshly installed binary triggers a macOS verification and is slower): wait for it instead of starting a second one
    if !overlayRunning() {
        let bin = NSString(string: "~/.dsh/bin/dsh-cursor-overlay").expandingTildeInPath
        guard FileManager.default.isExecutableFile(atPath: bin) else { return }
        try? FileManager.default.removeItem(atPath: cursorFifo)   // stale leftover after the process was killed; clean it up
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bin)
        p.arguments = ["--fifo", cursorFifo]                      // pass it explicitly: older overlays still default to the shared /tmp path
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        try? p.run()
    }
    for _ in 0..<40 {                                     // wait at most 2 seconds
        if overlayReady() { return }
        usleep(50_000)
    }
}

func overlayPing(_ cmd: String) {
    guard !cursorOverlayOff else { return }
    let fifo = cursorFifo
    // Key detail: O_NONBLOCK. A plain open on a FIFO with no reader **blocks forever** —
    // that's exactly what used to time out whole clicks. Skip outright when there's no reader; never slow the action down.
    let fd = open(fifo, O_WRONLY | O_NONBLOCK)
    guard fd >= 0 else { return }
    var bytes = Array((cmd + "\n").utf8)
    _ = write(fd, &bytes, bytes.count)
    close(fd)
}

// ── CGEvent posting (doesn't move the real mouse) ────────────────────────────────────────────

/// The target process's frontmost window at this point: window number + window top-left (screen coordinates, top-left origin). nil when none
func targetWindow(pid: pid_t, at p: CGPoint) -> (number: Int64, origin: CGPoint)? {
    guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
    for w in list {                                      // the list is ordered front to back
        guard (w[kCGWindowOwnerPID as String] as? Int).map({ pid_t($0) }) == pid,
              let b = w[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: b as CFDictionary), r.contains(p),
              let n = w[kCGWindowNumber as String] as? Int else { continue }
        if let a = w[kCGWindowAlpha as String] as? Double, a == 0 { continue }
        return (Int64(n), r.origin)
    }
    return nil
}

/// Two things not exposed on the event. Held as enum static members (initialized on first use): this file is script-style top-level code,
/// so a global let declared after the switch isn't assigned yet while the switch runs — you'd read 0 / nil
enum WindowEventFields {
    typealias SetWindowLocation = @convention(c) (CGEvent, CGPoint) -> Void
    /// The system-private CGEventSetWindowLocation (window-local coordinates). Looked up by name at runtime; when absent, only the window number is filled
    static let setWindowLocation: SetWindowLocation? = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation")
        .map { unsafeBitCast($0, to: SetWindowLocation.self) }
    /// Window-number field: absent from the public headers; AppKit's NSEvent.windowNumber reads exactly this
    static let windowNumber = CGEventField(rawValue: 51)!
}

/// Whether the target is Chromium-based (Electron apps, Chrome-family browsers): checks the app bundle for such frameworks
func isChromium(pid: pid_t) -> Bool {
    guard let url = NSRunningApplication(processIdentifier: pid)?.bundleURL else { return false }
    let fw = url.appendingPathComponent("Contents/Frameworks")
    let names = (try? FileManager.default.contentsOfDirectory(atPath: fw.path)) ?? []
    return names.contains { name in
        name == "Electron Framework.framework" || name.hasSuffix("Helper (Renderer).app")
            || (name.hasSuffix(" Framework.framework")
                && FileManager.default.fileExists(atPath: fw.appendingPathComponent(name).appendingPathComponent("Versions/Current/Helpers").path))
    }
}

/// Background Chromium / Electron windows don't accept the focus-activating click (DSH itself is one), so the press just gets dropped.
/// Carrying ⌘ on the press makes AppKit hand it straight to the page without activating the window. Release and click go without ⌘, so the page sees a plain click
func needsCommandPress(pid: pid_t) -> Bool {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return false }
    return isChromium(pid: pid)
}

/// Mouse events built via postToPid carry no window number (0) and no window-local coordinates. AppKit / Electron can't identify the window
/// and drop the click, drag, or wheel event (true of DSH's own windows and ordinary AppKit windows alike).
/// Filling in the window number and window-local coordinates routes the event into that window — still without stealing focus or moving the real mouse
func tagWindow(_ e: CGEvent, window: (number: Int64, origin: CGPoint)?, at p: CGPoint) {
    guard let w = window else { return }
    e.setIntegerValueField(WindowEventFields.windowNumber, value: w.number)
    WindowEventFields.setWindowLocation?(e, CGPoint(x: p.x - w.origin.x, y: p.y - w.origin.y))
}

/// Event source for events posted to the target process. By default the system freezes the local real keyboard and mouse for 0.25 seconds on every synthetic event
/// (localEventsSuppressionInterval): each click stutters, and typing into Chromium character by character blocks the whole session,
/// leaving users with the feeling that the plugin is fighting them for the mouse (issue #2; measured — the real mouse couldn't move a pixel while events were being sent). Events posted to a pid never touch the real mouse, so no freezing is needed
func quietSource() -> CGEventSource? {
    guard let s = CGEventSource(stateID: .hidSystemState) else { return nil }
    s.localEventsSuppressionInterval = 0
    let all: CGEventFilterMask = [.permitLocalMouseEvents, .permitLocalKeyboardEvents, .permitSystemDefinedEvents]
    s.setLocalEventsFilterDuringSuppressionState(all, state: .eventSuppressionStateSuppressionInterval)
    s.setLocalEventsFilterDuringSuppressionState(all, state: .eventSuppressionStateRemoteMouseDrag)
    return s
}

/// global=false: post to the target process (doesn't move the real mouse); true: go through system events (moves the real mouse, best compatibility)
func postClick(pid: pid_t, at point: CGPoint, global: Bool = false) -> Bool {
    let src = global ? CGEventSource(stateID: .hidSystemState) : quietSource()
    let win = global ? nil : targetWindow(pid: pid, at: point)
    let commandPress = !global && needsCommandPress(pid: pid)
    for (type, button) in [(CGEventType.leftMouseDown, CGMouseButton.left), (CGEventType.leftMouseUp, CGMouseButton.left)] {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { return false }
        e.setIntegerValueField(.mouseEventClickState, value: 1)
        if global {
            if type == .leftMouseDown { CGWarpMouseCursorPosition(point) }   // bring the cursor along too
            e.post(tap: .cghidEventTap)
        } else {
            tagWindow(e, window: win, at: point)
            e.flags = commandPress && type == .leftMouseDown ? .maskCommand : []
            e.postToPid(pid)
        }
        usleep(30_000)
    }
    if !global { makeMainWindow(pid: pid, at: point) }   // like a real click: whichever window got clicked, the next input goes there
    return true
}

/// When a background app has no "current window", keys sent to it have no receiver and typed text is entirely lost (always true of Chromium / Electron, DSH itself included).
/// Use accessibility to set one of its windows as the app's main window: the app isn't activated, doesn't steal focus, and the keys have somewhere to land.
/// With a coordinate, the window at that point is targeted (whichever window got clicked, the following input goes there); without one, its current main window is targeted
func makeMainWindow(pid: pid_t, at p: CGPoint? = nil) {
    guard let app = NSRunningApplication(processIdentifier: pid), !app.isActive else { return }
    let ax = AXUIElementCreateApplication(pid)
    let wins = (attr(ax, kAXWindowsAttribute as String) as? [AXUIElement]) ?? []
    var target: AXUIElement?
    if let p = p {
        target = wins.first { frame($0)?.contains(p) == true }
    } else if let m = attr(ax, kAXMainWindowAttribute as String), CFGetTypeID(m) == AXUIElementGetTypeID() {
        target = (m as! AXUIElement)
    } else {
        target = wins.first
    }
    guard let w = target else { return }
    AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
}

func postText(pid: pid_t, _ text: String) -> Bool {
    let src = quietSource()
    let units = Array(text.utf16)
    // An AppKit app accepts a whole run of text in a single key event. Chromium / Electron in the background only accepts single-character presses —
    // stuffing several characters at once (Chinese, emoji, "ab") drops the whole batch, so send one UTF-16 unit per event (it rejoins both halves of an emoji itself)
    let chunks = isChromium(pid: pid) ? units.map { [$0] } : [units]
    for chunk in chunks {
        guard let down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true),
              let up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false) else { return false }
        down.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        down.postToPid(pid)
        usleep(chunks.count > 1 ? 5_000 : 20_000)
        up.postToPid(pid)
        if chunks.count > 1 { usleep(5_000) }
    }
    usleep(20_000)                                     // same as above: wait for the key-up to land before exiting
    return true
}
