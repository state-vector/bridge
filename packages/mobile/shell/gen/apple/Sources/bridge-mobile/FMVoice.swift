// FoundationModels voice bridge (BR#4782).
//
// The FoundationModels framework is Swift-only on iOS — there are no
// OBJC_CLASS symbols to bind from Rust (checked in the iOS 26.5 SDK), which
// is why the desktop's `foundation-models` crate ships a Swift bridge of its
// own for macOS. This is the minimal iOS counterpart: three `@_cdecl` C
// symbols compiled into the app target, declared `extern "C"` in
// packages/mobile/shell/src/fm.rs.
//
// Session-per-call, string in → string out. The tool loop and prompting live
// Rust-side (console.rs) so the engine stays swappable.

import Foundation

#if canImport(FoundationModels)
import FoundationModels
#endif

/// True when the on-device model can serve (iOS 26+, Apple Intelligence on).
@_cdecl("fm_voice_is_available")
public func fm_voice_is_available() -> Bool {
#if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
        if case .available = SystemLanguageModel.default.availability {
            return true
        }
        return false
    }
#endif
    return false
}

/// Rust's callback: (ctx, response_cstr, error_cstr). Exactly one call per
/// request; non-empty error = failure.
public typealias FMVoiceRespondCallback = @convention(c) (
    UnsafeMutableRawPointer?, UnsafePointer<CChar>?, UnsafePointer<CChar>?
) -> Void

private func dupCString(_ s: String) -> UnsafeMutablePointer<CChar> {
    strdup(s)!
}

/// Class box so a Task can cross the C boundary as an opaque handle
/// (Unmanaged needs a class; Task is a struct).
private final class FMTaskBox {
    let task: Task<Void, Never>
    init(task: Task<Void, Never>) {
        self.task = task
    }
}

/// One turn: instructions + prompt → reply text (async, background).
/// Returns an opaque task handle for fm_voice_task_cancel.
@_cdecl("fm_voice_respond")
public func fm_voice_respond(
    instructions: UnsafePointer<CChar>?,
    prompt: UnsafePointer<CChar>?,
    context: UnsafeMutableRawPointer?,
    callback: @escaping FMVoiceRespondCallback
) -> UnsafeMutableRawPointer? {
    let instructions = instructions.map { String(cString: $0) } ?? ""
    let prompt = prompt.map { String(cString: $0) } ?? ""

#if canImport(FoundationModels)
    if #available(iOS 26.0, *) {
        let task = Task.detached(priority: .userInitiated) {
            var response: String? = nil
            var failure: String? = nil
            do {
                let session = LanguageModelSession(instructions: Instructions(instructions))
                // The on-device window is ~4k tokens total and small models
                // can loop — cap generation so prompt + reply always fit.
                let options = GenerationOptions(maximumResponseTokens: 300)
                let result = try await session.respond(to: prompt, options: options)
                response = result.content
            } catch is CancellationError {
                failure = "cancelled"
            } catch {
                failure = "apple-fm: \(error.localizedDescription)"
            }
            // Deliver exactly once. The duplicated C strings are Rust's to
            // leak (one-shot, tiny) — the callback does not free them.
            if let ctx = context {
                callback(
                    ctx,
                    response.map { UnsafePointer(dupCString($0)) },
                    failure.map { UnsafePointer(dupCString($0)) }
                )
            }
        }
        return Unmanaged.passRetained(FMTaskBox(task: task)).toOpaque()
    }
#endif
    if let ctx = context {
        let msg = "FoundationModels unavailable (iOS 26+ required)"
        callback(ctx, nil, UnsafePointer(dupCString(msg)))
    }
    return Unmanaged.passRetained(FMTaskBox(task: Task<Void, Never> {})).toOpaque()
}

/// Cancel an in-flight respond (Rust-side timeout path).
@_cdecl("fm_voice_task_cancel")
public func fm_voice_task_cancel(_ handle: UnsafeMutableRawPointer?) {
    guard let handle else { return }
    let box = Unmanaged<FMTaskBox>.fromOpaque(handle).takeRetainedValue()
    box.task.cancel()
}
