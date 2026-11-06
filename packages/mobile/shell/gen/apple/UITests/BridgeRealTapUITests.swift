import XCTest
import CoreGraphics

/// BR#5449 — real-touch delivery probe.
///
/// The autopilot lane (BridgeShellUITests) drives clicks via injected JS, which
/// works even when REAL touch delivery is broken — that is exactly how BR#5449
/// went unnoticed until a human finger failed on device. This test sends real
/// coordinate taps and verifies the result WITHOUT touching the accessibility
/// tree, which wedges on the non-idling wry run loop (see BridgeShellUITests
/// header): taps are plain XCUIApplication coordinate taps (synthesized system
/// touch events, not JS), and the verification is a screenshot pixel-diff
/// against a no-touch baseline. If the tab row is dead, the post-tap screens
/// equal the baseline — unambiguous receipt either way.
///
/// Expected geometry (portrait, iPhone 17 Pro, 874pt tall): header ends ~108pt,
/// tabs row spans ~108..157pt, button center ~136pt → normalized y ≈ 0.156.
/// The three tabs are flex:1 → For You center x = 0.5. Fallback candidates in
/// case the sim's safe-area inset differs.
final class BridgeRealTapUITests: XCTestCase {

  /// Fraction of RGB pixels differing by more than `tolerance` per channel.
  private func differingPixelFraction(_ a: XCUIScreenshot, _ b: XCUIScreenshot, tolerance: Int = 16) -> Double? {
    guard let cgA = a.image.cgImage?.resizedForComparison(),
      let cgB = b.image.cgImage?.resizedForComparison(),
      cgA.width == cgB.width, cgA.height == cgB.height
    else { return nil }
    guard let bufA = cgA.rgbaBytes(), let bufB = cgB.rgbaBytes() else { return nil }
    let total = cgA.width * cgA.height
    var differing = 0
    var i = 0
    let end = total * 4
    while i < end {
      let dR = abs(Int(bufA[i]) - Int(bufB[i]))
      let dG = abs(Int(bufA[i + 1]) - Int(bufB[i + 1]))
      let dB = abs(Int(bufA[i + 2]) - Int(bufB[i + 2]))
      if dR > tolerance || dG > tolerance || dB > tolerance {
        differing += 1
      }
      i += 4
    }
    return Double(differing) / Double(total)
  }

  /// No-touch baseline: two screenshots 4s apart with no interaction. Catches
  /// clock ticks / spinners so a dead-touch verdict can't be fooled.
  private func baselineDiff(screen: XCUIScreen) throws -> Double {
    let a = screen.screenshot()
    sleep(4)
    let b = screen.screenshot()
    let d = differingPixelFraction(a, b) ?? -1
    XCTAssertGreaterThanOrEqual(d, 0, "baseline screenshot diff failed to compute")
    return d
  }

  @MainActor
  func testRealCoordinateTapSwitchesTabs() throws {
    let app = XCUIApplication()
    // No E2E launch environment: no autopilot, no pre-connect. The app boots
    // cold (Connect card, Fleet tab) — exactly what a human finger sees.
    app.launch()
    sleep(10) // webview boot + first paint

    let screen = XCUIScreen.main
    let base = try baselineDiff(screen: screen)
    print("[BR5449] baseline no-touch diff: \(base)")

    let candidates: [CGVector] = [
      CGVector(dx: 0.5, dy: 0.156), // computed tab-row center
      CGVector(dx: 0.5, dy: 0.135),
      CGVector(dx: 0.5, dy: 0.175),
    ]

    // Flat locals instead of a tuple — keeps the type checker fast.
    var bestDiff = -1.0
    var bestVector = candidates[0]
    var bestBefore: XCUIScreenshot? = nil
    var bestAfter: XCUIScreenshot? = nil
    var afterBaseline = screen.screenshot()

    for (idx, c) in candidates.enumerated() {
      let before = afterBaseline
      app.coordinate(withNormalizedOffset: c).tap()
      sleep(4)
      let after = screen.screenshot()
      let d = differingPixelFraction(before, after) ?? -1
      print("[BR5449] tap #\(idx) at (\(c.dx), \(c.dy)): diff \(d)")
      if d > bestDiff {
        bestDiff = d
        bestVector = c
        bestBefore = before
        bestAfter = after
      }
      afterBaseline = after
      // A real tab switch dwarfs the baseline; further candidates can't beat it.
      if d > max(0.05, base * 5) { break }
    }

    if let before = bestBefore, let after = bestAfter {
      let attBefore = XCTAttachment(screenshot: before)
      attBefore.name = "br5449-before-\(bestVector.dx)-\(bestVector.dy)"
      attBefore.lifetime = .keepAlways
      add(attBefore)
      let attAfter = XCTAttachment(screenshot: after)
      attAfter.name = "br5449-after-\(bestVector.dx)-\(bestVector.dy)"
      attAfter.lifetime = .keepAlways
      add(attAfter)
    }

    // PASS requires a content change from REAL taps that exceeds both an
    // absolute floor and the no-touch baseline (clock noise). Calibrated on
    // device sim receipts: a genuine Fleet→For You switch moves the accent
    // underline across the tab row and changes ~4% of pixels (dark theme,
    // structurally similar card layouts) — 2% is 40x the measured baseline
    // noise while a dead-touch screen stays at baseline.
    XCTAssertGreaterThan(
      bestDiff, max(0.02, base * 10),
      "BR#5449: real coordinate taps produced no UI change — touch delivery is DEAD on this sim " +
      "(baseline no-touch diff \(base), best tap diff \(bestDiff)). Screenshots attached as receipts."
    )
  }
}

private extension CGImage {
  /// Downscale to a bounded size so the pixel loop stays fast (~0.5M pixels max).
  func resizedForComparison(maxDim: Int = 760) -> CGImage {
    let w = width, h = height
    let scale = Double(maxDim) / Double(max(w, h))
    if scale >= 1 { return self }
    let nw = Int(Double(w) * scale), nh = Int(Double(h) * scale)
    guard let ctx = CGContext(
      data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: nw * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return self }
    ctx.interpolationQuality = .low
    ctx.draw(self, in: CGRect(x: 0, y: 0, width: nw, height: nh))
    return ctx.makeImage() ?? self
  }

  /// Copied RGBA bytes — the CGContext backing store dies with the context,
  /// so the buffer must outlive it as an owned copy.
  func rgbaBytes() -> [UInt8]? {
    guard let ctx = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(),
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }
    ctx.draw(self, in: CGRect(x: 0, y: 0, width: width, height: height))
    guard let data = ctx.data else { return nil }
    let ptr = data.assumingMemoryBound(to: UInt8.self)
    let count = width * height * 4
    return Array(UnsafeBufferPointer(start: ptr, count: count))
  }
}
