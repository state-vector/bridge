//! Voice legs of the console — on-device STT (Speech) and TTS (AVFAudio),
//! objc2 all the way down, same pattern as `ios_notify.rs`. iOS-only.
//!
//! Events emitted to the webview:
//!   "voice://partial" { text }    — live recognition hypothesis
//!   "voice://final"    { text }   — final transcript (the UI then calls voice_turn)
//!   "voice://error"    { stage, message }
//!   "voice://speak-done" {}       — TTS finished (UI re-arms the mic button)
//!
//! Design notes:
//! - `requiresOnDeviceRecognition = true` — audio never leaves the phone;
//!   offline is a feature, not a fallback. If the device can't do on-device
//!   (rare, sim without speech assets) we surface it instead of silently
//!   shipping audio to Apple servers.
//! - One listen session at a time; the static mutex serializes.
//! - The synthesizer + delegate are created once at app setup on the main
//!   thread (MainThreadOnly, like the notification delegate); speak calls
//!   go through the stored handle from any command thread.
//! - TTS and STT share the audio session (playAndRecord + defaultToSpeaker)
//!   so a spoken question can be answered by ear on speaker.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, ClassType, DefinedClass};
use objc2_avf_audio::{
    AVAudioEngine, AVAudioSession, AVSpeechBoundary, AVSpeechSynthesisVoice, AVSpeechSynthesizer,
    AVSpeechSynthesizerDelegate, AVSpeechUtterance,
};
use objc2_foundation::{ns_string, NSError, NSString};
use objc2_speech::{
    SFSpeechAudioBufferRecognitionRequest, SFSpeechRecognizer, SFSpeechRecognizerAuthorizationStatus,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter};

static SPEAK_BUSY: AtomicBool = AtomicBool::new(false);

/// objc object wrappers are !Send/!Sync by default; AVFoundation's speech
/// and audio-graph objects tolerate background-thread use and every access
/// below is serialized through a Mutex, so the wrapper is sound. The audio
/// session itself is process-global on Apple platforms.
struct SendObj<T>(Retained<T>);
unsafe impl<T> Send for SendObj<T> {}
unsafe impl<T> Sync for SendObj<T> {}
impl<T: objc2::Message> Clone for SendObj<T> {
    fn clone(&self) -> Self {
        Self(self.0.clone())
    }
}
impl<T> std::ops::Deref for SendObj<T> {
    type Target = Retained<T>;
    fn deref(&self) -> &Retained<T> {
        &self.0
    }
}

pub struct ListenSession {
    engine: SendObj<AVAudioEngine>,
    request: SendObj<SFSpeechAudioBufferRecognitionRequest>,
    task: SendObj<objc2_speech::SFSpeechRecognitionTask>,
}

static LISTEN: Mutex<Option<ListenSession>> = Mutex::new(None);
static SYNTH: Mutex<Option<SendObj<AVSpeechSynthesizer>>> = Mutex::new(None);

struct SpeakDelegateIvars {
    app: AppHandle,
}

define_class!(
    #[unsafe(super(objc2::runtime::NSObject))]
    #[name = "BridgeMobileSpeakDelegate"]
    #[ivars = SpeakDelegateIvars]
    struct SpeakDelegate;

    unsafe impl NSObjectProtocol for SpeakDelegate {}

    unsafe impl AVSpeechSynthesizerDelegate for SpeakDelegate {
        #[unsafe(method(speechSynthesizer:didFinishSpeechUtterance:))]
        unsafe fn did_finish(&self, _synth: &AVSpeechSynthesizer, _utterance: &AVSpeechUtterance) {
            SPEAK_BUSY.store(false, Ordering::Relaxed);
            let _ = self.ivars().app.emit("voice://speak-done", serde_json::json!({}));
        }

        #[unsafe(method(speechSynthesizer:didCancelSpeechUtterance:))]
        unsafe fn did_cancel(&self, _synth: &AVSpeechSynthesizer, _utterance: &AVSpeechUtterance) {
            SPEAK_BUSY.store(false, Ordering::Relaxed);
            let _ = self.ivars().app.emit("voice://speak-done", serde_json::json!({}));
        }
    }
);

impl SpeakDelegate {
    fn new(app: AppHandle) -> Retained<SpeakDelegate> {
        let this: objc2::rc::Allocated<SpeakDelegate> =
            unsafe { msg_send![SpeakDelegate::class(), alloc] };
        let this = this.set_ivars(SpeakDelegateIvars { app });
        unsafe { msg_send![super(this), init] }
    }
}

/// Create the TTS core at app setup (main thread). Idempotent.
pub fn init(app: AppHandle) {
    let mut slot = SYNTH.lock().unwrap();
    if slot.is_some() {
        return;
    }
    let synth = unsafe { AVSpeechSynthesizer::new() };
    let delegate = SpeakDelegate::new(app);
    let proto: &ProtocolObject<dyn AVSpeechSynthesizerDelegate> =
        ProtocolObject::from_ref(&*delegate);
    unsafe { synth.setDelegate(Some(proto)) };
    std::mem::forget(delegate); // the synth holds its delegate weakly
    *slot = Some(SendObj(synth));
}

fn synth() -> Result<SendObj<AVSpeechSynthesizer>, String> {
    SYNTH
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "speech core not initialized".into())
}

fn emit_error(app: &AppHandle, stage: &str, message: &str) {
    let _ = app.emit(
        "voice://error",
        serde_json::json!({ "stage": stage, "message": message }),
    );
}

/// Request mic + speech permissions (fire-and-forget prompts; status polled
/// by voice_permissions). The AVAudioSession record API is deprecated in
/// favour of AVAudioApplication (iOS 17+ SDK-gated in objc2-avf-audio);
/// deprecated still works everywhere and avoids splitting the path.
#[allow(deprecated)]
pub fn request_permissions() {
    unsafe {
        SFSpeechRecognizer::requestAuthorization(&RcBlock::new(
            |_s: SFSpeechRecognizerAuthorizationStatus| {},
        ));
        let session = AVAudioSession::sharedInstance();
        session.requestRecordPermission(&RcBlock::new(|_g: objc2::runtime::Bool| {}));
    }
}

#[allow(deprecated)]
pub fn permission_status() -> Value {
    let speech = unsafe { SFSpeechRecognizer::authorizationStatus() };
    let mic = unsafe { AVAudioSession::sharedInstance().recordPermission() };
    serde_json::json!({
        "speech": format!("{speech:?}"),
        "mic": format!("{mic:?}"),
    })
}

/// Start listening: audio session → engine tap → buffered recognition request.
pub fn listen_start(app: AppHandle) -> Result<(), String> {
    let mut slot = LISTEN.lock().unwrap();
    if slot.is_some() {
        return Err("already listening".into());
    }

    unsafe {
        let session = AVAudioSession::sharedInstance();
        session
            .setCategory_withOptions_error(
                objc2_avf_audio::AVAudioSessionCategoryPlayAndRecord.expect("category constant"),
                objc2_avf_audio::AVAudioSessionCategoryOptions::DefaultToSpeaker,
            )
            .map_err(|e| format!("audio session category: {e:?}"))?;
        session
            .setActive_withOptions_error(true, objc2_avf_audio::AVAudioSessionSetActiveOptions(0))
            .map_err(|e| format!("audio session activate: {e:?}"))?;

        let recognizer = SFSpeechRecognizer::new();
        if !recognizer.isAvailable() {
            return Err("speech recognition unavailable right now".into());
        }
        if !recognizer.supportsOnDeviceRecognition() {
            emit_error(
                &app,
                "listen",
                "this device cannot recognize speech on-device; staying offline anyway",
            );
        }

        let request = SFSpeechAudioBufferRecognitionRequest::new();
        request.setShouldReportPartialResults(true);
        request.setRequiresOnDeviceRecognition(true);
        request.setAddsPunctuation(true);

        let engine = AVAudioEngine::new();
        let input = engine.inputNode();
        let format = input.outputFormatForBus(0);

        let req_for_tap = request.clone();
        let tap = RcBlock::new(
            move |buffer: std::ptr::NonNull<objc2_avf_audio::AVAudioPCMBuffer>,
                  _when: std::ptr::NonNull<objc2_avf_audio::AVAudioTime>| {
                // The runtime hands us a live buffer for the tap's lifetime.
                req_for_tap.appendAudioPCMBuffer(buffer.as_ref());
            },
        );
        input.installTapOnBus_bufferSize_format_block(0, 1024, Some(&format), RcBlock::as_ptr(&tap));

        engine
            .startAndReturnError()
            .map_err(|e| format!("audio engine start: {e:?}"))?;

        let app_for_results = app.clone();
        let handler = RcBlock::new(
            move |result: *mut objc2_speech::SFSpeechRecognitionResult, error: *mut NSError| {
                if !error.is_null() {
                    let msg = error
                        .as_ref()
                        .map(|e| e.localizedDescription().to_string())
                        .unwrap_or_else(|| "recognition error".into());
                    emit_error(&app_for_results, "recognize", &msg);
                    return;
                }
                let Some(result) = result.as_ref() else {
                    return;
                };
                let text = result.bestTranscription().formattedString().to_string();
                if text.trim().is_empty() {
                    return;
                }
                if result.isFinal() {
                    let _ = app_for_results
                        .emit("voice://final", serde_json::json!({ "text": text }));
                } else {
                    let _ = app_for_results
                        .emit("voice://partial", serde_json::json!({ "text": text }));
                }
            },
        );

        let task = recognizer.recognitionTaskWithRequest_resultHandler(&request, &handler);
        // The task stays alive while the session holds it; listen_stop flushes
        // via endAudio and tears the tap + engine down.

        *slot = Some(ListenSession {
            engine: SendObj(engine),
            request: SendObj(request),
            task: SendObj(task),
        });
        Ok(())
    }
}

/// Stop listening and flush the final transcript (endAudio finalizes).
pub fn listen_stop() -> Result<(), String> {
    let mut slot = LISTEN.lock().unwrap();
    match slot.take() {
        Some(session) => unsafe {
            session.request.endAudio();
            // Cancel the recognition task (the final transcript, if any, has
            // already been delivered by the time the user taps stop).
            session.task.cancel();
            let input = session.engine.inputNode();
            input.removeTapOnBus(0);
            session.engine.stop();
            Ok(())
        },
        None => Err("not listening".into()),
    }
}

/// Speak text aloud. Errors when speech is already in flight — the UI
/// serializes (one answer at a time).
pub fn speak(text: &str) -> Result<(), String> {
    let synth = synth()?;
    if SPEAK_BUSY.swap(true, Ordering::Relaxed) {
        return Err("already speaking".into());
    }
    let utterance =
        unsafe { AVSpeechUtterance::speechUtteranceWithString(&NSString::from_str(text)) };
    unsafe {
        // Default rate is brisk for board ids like "BR#1234".
        utterance.setRate(0.5);
        if let Some(voice) = AVSpeechSynthesisVoice::voiceWithLanguage(Some(ns_string!("en-US"))) {
            utterance.setVoice(Some(&voice));
        }
        synth.speakUtterance(&utterance);
    }
    Ok(())
}

pub fn speak_stop() {
    if let Ok(synth) = synth() {
        unsafe { synth.stopSpeakingAtBoundary(AVSpeechBoundary::Immediate) };
    }
}
