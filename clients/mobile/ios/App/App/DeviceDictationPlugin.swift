import AVFoundation
import Capacitor
import Speech

/// Dictation transcribed by the phone's own recognizer (see
/// `src/device-dictation.ts`). The web view captures the microphone and sends
/// the audio here; nothing in this file opens a microphone or touches the
/// audio session.
///
/// Every request sets `requiresOnDeviceRecognition`, and a recognizer that
/// cannot work on the device is reported unavailable, so audio is never sent
/// to a server.
@objc(DeviceDictationPlugin)
public class DeviceDictationPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "DeviceDictationPlugin"
    public let jsName = "DeviceDictation"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "appendAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "finish", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private final class Session {
        let id: String
        let recognizer: SFSpeechRecognizer
        let request: SFSpeechAudioBufferRecognitionRequest
        let format: AVAudioFormat
        var task: SFSpeechRecognitionTask?
        var text: String?
        var failure: String?
        var finishCall: CAPPluginCall?
        /// Set once `finish` has ended the audio.
        var audioEnded = false

        init(id: String, recognizer: SFSpeechRecognizer, request: SFSpeechAudioBufferRecognitionRequest, format: AVAudioFormat) {
            self.id = id
            self.recognizer = recognizer
            self.request = request
            self.format = format
        }
    }

    /// Read and written on the main queue only.
    private var session: Session?

    /// The recognizer's "No speech detected". Any other error is a failure,
    /// so a transcript lost while decoding is reported, never returned empty.
    private static func isNoSpeech(_ error: Error) -> Bool {
        let error = error as NSError
        return error.domain == "kAFAssistantErrorDomain" && error.code == 1110
    }

    /// `"auto"` is the device's own language.
    private func recognizer(for language: String) -> SFSpeechRecognizer? {
        language == "auto"
            ? SFSpeechRecognizer()
            : SFSpeechRecognizer(locale: Locale(identifier: language))
    }

    private func usable(_ recognizer: SFSpeechRecognizer?) -> SFSpeechRecognizer? {
        guard let recognizer, recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            return nil
        }
        return recognizer
    }

    @objc func isAvailable(_ call: CAPPluginCall) {
        let language = call.getString("language") ?? "auto"
        call.resolve(["available": usable(recognizer(for: language)) != nil])
    }

    @objc func start(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"),
              let sampleRate = call.getDouble("sampleRate"),
              let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: false)
        else {
            call.reject("Dictation could not start.")
            return
        }
        // Before the system prompt: a device that cannot dictate asks nothing.
        guard let recognizer = usable(recognizer(for: call.getString("language") ?? "auto")) else {
            call.reject("Dictation is not available on this device.")
            return
        }
        SFSpeechRecognizer.requestAuthorization { status in
            DispatchQueue.main.async {
                guard status == .authorized else {
                    call.reject("Speech recognition is blocked for Traycer.", "PERMISSION_DENIED")
                    return
                }
                self.end(self.session, rejecting: "Dictation was replaced.")
                let request = SFSpeechAudioBufferRecognitionRequest()
                request.requiresOnDeviceRecognition = true
                request.shouldReportPartialResults = false
                request.taskHint = .dictation
                if #available(iOS 16.0, *) {
                    request.addsPunctuation = true
                }
                let session = Session(id: id, recognizer: recognizer, request: request, format: format)
                session.task = recognizer.recognitionTask(with: request) { [weak session] result, error in
                    DispatchQueue.main.async {
                        guard let session, self.session === session else { return }
                        if let result, result.isFinal {
                            session.text = result.bestTranscription.formattedString
                        } else if let error {
                            if session.audioEnded, Self.isNoSpeech(error) {
                                // Audio with no speech in it is an empty transcript,
                                // not a failed dictation.
                                session.text = ""
                            } else {
                                session.failure = error.localizedDescription
                            }
                        } else {
                            return
                        }
                        self.settle(session)
                    }
                }
                self.session = session
                call.resolve()
            }
        }
    }

    @objc func appendAudio(_ call: CAPPluginCall) {
        guard let id = call.getString("sessionId"),
              let audio = call.getString("audio"),
              let data = Data(base64Encoded: audio)
        else {
            call.reject("Dictation audio was not readable.")
            return
        }
        DispatchQueue.main.async {
            guard let session = self.session, session.id == id else {
                call.resolve()
                return
            }
            if let failure = session.failure {
                call.reject(failure)
                return
            }
            let frames = AVAudioFrameCount(data.count / 2)
            guard frames > 0,
                  let buffer = AVAudioPCMBuffer(pcmFormat: session.format, frameCapacity: frames),
                  let samples = buffer.int16ChannelData
            else {
                call.resolve()
                return
            }
            buffer.frameLength = frames
            data.copyBytes(to: UnsafeMutableRawBufferPointer(start: samples[0], count: Int(frames) * 2))
            session.request.append(buffer)
            call.resolve()
        }
    }

    @objc func finish(_ call: CAPPluginCall) {
        let id = call.getString("sessionId")
        DispatchQueue.main.async {
            guard let session = self.session, session.id == id else {
                call.reject("Dictation was not running.")
                return
            }
            session.finishCall = call
            if session.failure == nil {
                session.audioEnded = true
                session.request.endAudio()
            }
            self.settle(session)
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        let id = call.getString("sessionId")
        DispatchQueue.main.async {
            if let session = self.session, session.id == id {
                self.end(session, rejecting: "Dictation was cancelled.")
            }
            call.resolve()
        }
    }

    /// Answers a pending `finish` once the recognizer has a transcript or a
    /// failure. A failure before `finish` waits here: `appendAudio` reports it.
    private func settle(_ session: Session) {
        guard let call = session.finishCall else { return }
        if let text = session.text {
            call.resolve(["text": text])
        } else if let failure = session.failure {
            call.reject(failure)
        } else {
            return
        }
        session.finishCall = nil
        session.task = nil
        if self.session === session {
            self.session = nil
        }
    }

    private func end(_ session: Session?, rejecting message: String) {
        guard let session else { return }
        session.task?.cancel()
        session.task = nil
        session.finishCall?.reject(message)
        session.finishCall = nil
        if self.session === session {
            self.session = nil
        }
    }
}
