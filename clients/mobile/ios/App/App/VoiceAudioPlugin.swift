import AVFoundation
import Capacitor

/// The phone's microphone permission and its voice session's interruptions
/// (see `src/voice-audio.ts`). The capture itself is the web view's: WebKit
/// opens the microphone for `getUserMedia` and owns the duplex audio session
/// while it runs, so nothing here touches the session's category or route.
///
/// `checkMicrophone` reads the decision without asking; `requestMicrophone`
/// raises the system prompt (with `NSMicrophoneUsageDescription`) when the
/// person has not decided yet and returns the remembered decision otherwise -
/// iOS never asks twice, so a denial is repaired only in the Settings app.
///
/// While `setLive(true)` holds, an audio-session interruption that begins (a
/// call, an alarm, Siri) raises `interrupted`, and the voice session ends.
@objc(VoiceAudioPlugin)
public class VoiceAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VoiceAudioPlugin"
    public let jsName = "VoiceAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkMicrophone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestMicrophone", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLive", returnType: CAPPluginReturnPromise),
    ]

    private var interruptionObserver: NSObjectProtocol?

    @objc func checkMicrophone(_ call: CAPPluginCall) {
        call.resolve(["state": currentState()])
    }

    @objc func requestMicrophone(_ call: CAPPluginCall) {
        let state = currentState()
        if state != "prompt" {
            call.resolve(["state": state])
            return
        }
        let settle: (Bool) -> Void = { granted in
            call.resolve(["state": granted ? "granted" : "denied"])
        }
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission(completionHandler: settle)
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission(settle)
        }
    }

    @objc func setLive(_ call: CAPPluginCall) {
        let live = call.getBool("live") ?? false
        DispatchQueue.main.async {
            if live {
                self.observeInterruptions()
            } else {
                self.stopObservingInterruptions()
            }
            call.resolve()
        }
    }

    private func currentState() -> String {
        if #available(iOS 17.0, *) {
            switch AVAudioApplication.shared.recordPermission {
            case .granted: return "granted"
            case .denied: return "denied"
            default: return "prompt"
            }
        }
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        default: return "prompt"
        }
    }

    private func observeInterruptions() {
        guard interruptionObserver == nil else { return }
        interruptionObserver = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began
            else { return }
            self?.notifyListeners("interrupted", data: [:])
        }
    }

    private func stopObservingInterruptions() {
        if let interruptionObserver {
            NotificationCenter.default.removeObserver(interruptionObserver)
        }
        interruptionObserver = nil
    }

    deinit {
        stopObservingInterruptions()
    }
}
