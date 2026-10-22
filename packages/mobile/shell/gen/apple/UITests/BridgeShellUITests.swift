import XCTest

/// BR#2514 E2E drive (autopilot variant).
///
/// The shell's E2E launch hook (shellui::e2e_boot_script, launchEnvironment-
/// gated) pre-connects the app to the local hub and auto-drives the entire
/// flow inside the webview: banner click on the first 401, hub password-form
/// auto-submit, For You tab, Unblock on the seeded decision. XCUITest only
/// launches the app and waits — the wry run loop never idles, which wedges
/// XCUITest accessibility snapshots (queries AND taps), so the drive lives
/// where the DOM is. Verification receipts are external: simctl screenshots,
/// unified log, and hub-side state.
final class BridgeShellUITests: XCTestCase {

  private let hub = ProcessInfo.processInfo.environment["E2E_HUB_URL"] ?? "http://127.0.0.1:8787"
  private let password = ProcessInfo.processInfo.environment["E2E_HUB_PASSWORD"] ?? "e2e-hub-pass-2514"

  @MainActor
  func testConnectSignInFleetAndForYou() throws {
    XCTAssertFalse(password.isEmpty, "E2E_HUB_PASSWORD missing — cannot drive the sign-in leg")

    let app = XCUIApplication()
    app.launchEnvironment["E2E_HUB_URL"] = hub
    app.launchEnvironment["E2E_HUB_PASSWORD"] = password
    app.launch()

    // Autopilot timeline: banner ~5s after first 401, login submit <=1s after
    // the form renders, return + authed polls ~5s later, For You + Unblock on
    // the next autopilot ticks. 55s covers it with margin before teardown.
    sleep(55)
  }
}
