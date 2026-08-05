/* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessorNode is used
   deliberately to capture PCM without a separate AudioWorklet asset (which would
   need CSP `script-src` widening for `file://`); migrating to AudioWorklet is a
   follow-up. */
import { useCallback, useEffect, useRef, useState } from "react";
import { SPEECH_INPUT_SAMPLE_RATE } from "@traycer/protocol/host/speech/schemas";
import { SpeechStreamClient } from "@traycer-clients/shared/host-transport/speech-stream-client";
import type { StreamConnectionStatus } from "@traycer-clients/shared/host-transport/i-stream-session";
import type { MicrophoneAccessStatus } from "@traycer-clients/shared/platform/runner-host";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { appLogger, describeLogError, type AppLogFields } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";
import {
  Analytics,
  AnalyticsEvent,
  analyticsBlockerFromError,
} from "@/lib/analytics";

export type VoiceDictationState =
  "idle" | "requesting" | "recording" | "transcribing" | "error";

/**
 * Which path aborted a dictation attempt. Passed to `fail()` as a required
 * argument - not derived from the message - so the single log line it writes
 * always names the class, and a new failure path cannot be added without
 * declaring one. Two field reports (oss #945, #1003) were root-caused only by
 * elimination because that line did not exist.
 */
export type DictationFailureClass =
  // No `navigator` (non-browser environment).
  | "capture_unavailable"
  // The permission IPC itself rejected.
  | "permission_request_failed"
  // The OS says the app is denied (macOS TCC; win32 always reports granted).
  | "permission_denied_os"
  // `getUserMedia` rejected with NotAllowedError.
  | "permission_denied_browser"
  // `getUserMedia` rejected for any other reason (no device, in use, ...).
  | "mic_open_failed"
  | "audio_context_create_failed"
  | "audio_context_not_running"
  // No host stream client at start - the link was down before we asked.
  | "not_connected"
  // The host answered with an `error` frame.
  | "host_error_frame"
  // The stream dropped mid-session without us closing it.
  | "connection_lost";

export interface UseVoiceDictationArgs {
  readonly language: string;
  // Called with each finalized transcript segment (the engine emits per-pause
  // finals, no interims).
  readonly onText: (text: string) => void;
}

export interface UseVoiceDictation {
  readonly state: VoiceDictationState;
  readonly errorMessage: string | null;
  /**
   * Which path produced {@link errorMessage}, or null when there is no error.
   * A stable app-defined identifier (never user text), so it is safe to carry
   * into a public support report - which is the point: the reporter's own
   * issue then names the failure class instead of leaving triage to infer it.
   */
  readonly failureClass: DictationFailureClass | null;
  /** True when the last error was a denied OS microphone permission. */
  readonly permissionDenied: boolean;
  readonly start: () => void;
  readonly stop: () => void;
  readonly toggle: () => void;
  /** Abort recording and discard the utterance (no transcript). */
  readonly cancel: () => void;
  /**
   * The live capture MediaStream while recording (else null), handed to the
   * waveform visualizer. Stable accessor so the visualizer attaches without
   * triggering React re-renders.
   */
  readonly getStream: () => MediaStream | null;
}

// ScriptProcessor frame size → ~128 ms chunks at 16 kHz. Power-of-two as the
// API requires. (AudioWorklet would be lower-latency; ScriptProcessor avoids a
// separate worklet asset + CSP `script-src` widening and is adequate for STT.)
const PROCESSOR_BUFFER_SIZE = 2048;
// After `flush`, the host transcribes the buffered utterance and replies
// `flushed`; we close then. This fallback only fires if that reply never
// arrives (e.g., an unusually long decode) so the UI never hangs in
// "transcribing".
const FINALIZE_FALLBACK_MS = 15000;

/**
 * Splits a rejected `getUserMedia` into the denial the user can act on and
 * every other open failure (no device, device busy, hardware error). Extracted
 * from the acquisition path so classifying the failure does not push that
 * already-branchy async arrow over the complexity ceiling.
 */
function classifyMicOpenFailure(error: unknown): {
  readonly denied: boolean;
  readonly failureClass: DictationFailureClass;
  readonly message: string;
} {
  if (error instanceof Error && error.name === "NotAllowedError") {
    return {
      denied: true,
      failureClass: "permission_denied_browser",
      message: "Microphone access is blocked for Traycer.",
    };
  }
  return {
    denied: false,
    failureClass: "mic_open_failed",
    message: `Could not access the microphone: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

function dictationDurationBucket(
  startedAtMs: number | null,
): "under_10s" | "10_to_30s" | "over_30s" {
  const elapsed = startedAtMs === null ? 0 : Date.now() - startedAtMs;
  if (elapsed < 10_000) return "under_10s";
  if (elapsed <= 30_000) return "10_to_30s";
  return "over_30s";
}

/**
 * Drives on-device dictation: captures the mic as PCM16 mono, streams it to the
 * host recognizer over `speech.dictate` (reporting the real capture rate so
 * the host resamples to the model rate), and forwards final transcripts to the
 * caller (which writes them into the composer).
 */
export function useVoiceDictation(
  args: UseVoiceDictationArgs,
): UseVoiceDictation {
  const { language, onText } = args;
  const wsStreamClient = useWsStreamClient();
  const runnerHost = useRunnerHost();
  const [state, setState] = useState<VoiceDictationState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [failureClass, setFailureClass] =
    useState<DictationFailureClass | null>(null);
  const [permissionDenied, setPermissionDenied] = useState(false);

  // Latest-value refs so the long-lived audio/stream callbacks never close over
  // stale handlers/state.
  const handlersRef = useRef(args);
  const stateRef = useRef(state);
  useEffect(() => {
    handlersRef.current = { language, onText };
  }, [language, onText]);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const speechClientRef = useRef<SpeechStreamClient | null>(null);
  const readyRef = useRef(false);
  // True once the capture graph is wired and pulling (mic stream + running
  // context + connected processor). "recording" requires this AND the speech
  // session's `ready` - either alone would show a live-recording UI that is
  // not actually capturing (speech ready while the permission prompt is still
  // up) or not actually transcribing (graph pulling with no session).
  const audioGraphReadyRef = useRef(false);
  const pendingChunksRef = useRef<Uint8Array[]>([]);
  // Browser `setTimeout` returns a numeric handle.
  const finalizeTimerRef = useRef<number | null>(null);
  // True once we've asked to end the session (stop/cancel/fail). Lets the
  // connection-close handler tell an expected close from an unexpected drop.
  const closingRef = useRef(false);
  // Bumped on every start/stop/cancel. The async capture path captures the
  // value at launch and bails if it changed, so a stop/cancel during the
  // permission prompt can't re-arm a now-abandoned session.
  const startGenerationRef = useRef(0);
  // When the live recording actually began (onReady), for duration buckets.
  const recordingStartedAtRef = useRef<number | null>(null);
  // Last status the live session reported, or null before any session opened.
  // Read only by the failure log: it separates "the link was already down" from
  // "the link dropped under us", which no other signal distinguishes after
  // teardown has run.
  const lastConnectionStatusRef = useRef<StreamConnectionStatus | null>(null);

  const markClosing = useCallback(() => {
    closingRef.current = true;
  }, []);

  const teardownAudio = useCallback(() => {
    const processor = processorRef.current;
    if (processor !== null) {
      // Detach the capture callback before disconnecting: an audio task the
      // browser already queued must find a dead handler, not a closure that
      // could still route this session's PCM into a successor session.
      processor.onaudioprocess = null;
      processor.disconnect();
    }
    processorRef.current = null;
    audioGraphReadyRef.current = false;
    sourceNodeRef.current?.disconnect();
    sourceNodeRef.current = null;
    const stream = mediaStreamRef.current;
    if (stream !== null) {
      for (const track of stream.getTracks()) track.stop();
    }
    mediaStreamRef.current = null;
    const ctx = audioContextRef.current;
    audioContextRef.current = null;
    if (ctx !== null) {
      void ctx.close().catch((error: unknown) => {
        appLogger.warn("[voice-dictation] audio context close failed", {
          error: describeLogError(error),
        });
      });
    }
  }, []);

  const teardownAll = useCallback(() => {
    if (finalizeTimerRef.current !== null) {
      window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    teardownAudio();
    speechClientRef.current?.close();
    speechClientRef.current = null;
    readyRef.current = false;
    pendingChunksRef.current = [];
  }, [teardownAudio]);

  const fail = useCallback(
    (
      failureClass: DictationFailureClass,
      // Extra per-path fields for the log line only. Required (not defaulted)
      // so each call site states what it has; most pass `{}`. Deliberately
      // separate from `error`, which feeds analytics blocker classification -
      // enriching the log must not silently reclassify the funnel.
      details: AppLogFields,
      message: string,
      error: unknown,
    ) => {
      // Logged BEFORE teardown: `teardownAll()` clears the readiness refs this
      // line reports, so emitting afterwards would describe the torn-down
      // session rather than the failing one.
      appLogger.error(
        "[voice-dictation] failed",
        {
          ...details,
          failureClass,
          state: stateRef.current,
          connectionStatus: lastConnectionStatusRef.current ?? "none",
          hasStreamClient: wsStreamClient !== null,
          sessionReady: readyRef.current,
          audioGraphReady: audioGraphReadyRef.current,
          msSinceRecordingStart:
            recordingStartedAtRef.current === null
              ? null
              : Date.now() - recordingStartedAtRef.current,
        },
        error,
      );
      if (stateRef.current === "transcribing") {
        Analytics.getInstance().track(AnalyticsEvent.VoiceTranscriptionFailed, {
          blocker: analyticsBlockerFromError(error),
        });
      } else {
        Analytics.getInstance().track(AnalyticsEvent.VoiceCaptureFailed, {
          source: "direct_ui",
          blocker: analyticsBlockerFromError(error),
        });
      }
      // Invalidate capture work still in flight, the way `stop()`/`cancel()`
      // already do. `startAudioGraph` captures the AudioContext BEFORE awaiting
      // the permission prompt, so without this bump a failure arriving during
      // that await tears the context down and the task still resumes on it -
      // finds it closed, and calls fail() a SECOND time with
      // `audio_context_not_running`. That generic class would overwrite the
      // real first cause and become the one the user reports.
      startGenerationRef.current += 1;
      markClosing();
      teardownAll();
      setState("error");
      setErrorMessage(message);
      setFailureClass(failureClass);
    },
    [markClosing, teardownAll, wsStreamClient],
  );

  // Normal end-of-session: the host has flushed all transcripts. Close the
  // stream and return to idle.
  const finalize = useCallback(() => {
    if (finalizeTimerRef.current !== null) {
      window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    speechClientRef.current?.close();
    speechClientRef.current = null;
    readyRef.current = false;
    setState("idle");
  }, []);

  // The "recording" transition: taken only once BOTH readiness signals are in
  // for the same live session - the speech session's `ready` (readyRef) and
  // the wired capture graph (audioGraphReadyRef). Whichever signal lands
  // second takes the transition; queued pre-ready audio is flushed here so
  // nothing is sent before the session can accept it.
  const tryBeginRecording = useCallback((client: SpeechStreamClient) => {
    if (closingRef.current || speechClientRef.current !== client) return;
    if (!readyRef.current || !audioGraphReadyRef.current) return;
    // Same-tick latch (stateRef only updates post-render): a non-null start
    // timestamp means this session already took the transition.
    if (recordingStartedAtRef.current !== null) return;
    recordingStartedAtRef.current = Date.now();
    Analytics.getInstance().track(AnalyticsEvent.VoiceDictationStarted, {
      source: "direct_ui",
    });
    setState("recording");
    const pending = pendingChunksRef.current;
    pendingChunksRef.current = [];
    for (const chunk of pending) client.sendAudio(chunk);
  }, []);

  // Run the permission prompt + getUserMedia. Returns null (and surfaces an
  // error, or silently aborts) when the mic can't be opened or the session was
  // stopped/cancelled while the prompt was up (detected via `generation`).
  const acquireMicStream = useCallback(
    async (generation: number): Promise<MediaStream | null> => {
      if (generation !== startGenerationRef.current) return null;
      if (typeof navigator === "undefined") {
        Analytics.getInstance().track(AnalyticsEvent.VoicePermissionResolved, {
          permission: "unavailable",
        });
        fail(
          "capture_unavailable",
          {},
          "Microphone capture is not available in this environment.",
          "Microphone capture is not available in this environment.",
        );
        return null;
      }
      // Trigger the native OS permission prompt (macOS) before opening the
      // stream. Returns the existing decision when already set; a denied app is
      // never re-prompted, so route those to the "Open Settings" affordance.
      let access: MicrophoneAccessStatus;
      try {
        access = await runnerHost.requestMicrophoneAccess();
      } catch (error) {
        if (generation !== startGenerationRef.current) return null;
        fail(
          "permission_request_failed",
          {},
          `Could not request microphone access: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        );
        return null;
      }
      if (generation !== startGenerationRef.current) return null;
      if (access === "denied") {
        Analytics.getInstance().track(AnalyticsEvent.VoicePermissionResolved, {
          permission: "denied",
        });
        setPermissionDenied(true);
        fail(
          "permission_denied_os",
          {},
          "Microphone access is blocked for Traycer.",
          "Microphone access is blocked for Traycer.",
        );
        return null;
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          // Use the browser's built-in audio processing (noise suppression /
          // auto-gain / echo cancellation). Noise suppression silences ambient
          // hiss so the waveform reads flat at rest and the recognizer gets a
          // clean signal, and AGC normalizes level. (The earlier raw-capture
          // workaround was for Whisper; Parakeet handles processed audio.)
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // The session may have been stopped/cancelled while the prompt was open.
        if (generation !== startGenerationRef.current) {
          for (const track of stream.getTracks()) track.stop();
          return null;
        }
        Analytics.getInstance().track(AnalyticsEvent.VoicePermissionResolved, {
          permission: "granted",
        });
        return stream;
      } catch (error) {
        // The session may have been stopped/cancelled while getUserMedia was
        // pending - a late rejection must not resurrect it into "error" or
        // emit analytics for an attempt the user already abandoned.
        if (generation !== startGenerationRef.current) return null;
        // No log here: `fail()` writes the single line for this path, and the
        // `denied` split it used to record is now carried by the failure class.
        const failure = classifyMicOpenFailure(error);
        if (failure.denied) {
          // The OS said yes but the browser-level prompt was refused - still a
          // user-visible permission denial for the funnel.
          Analytics.getInstance().track(
            AnalyticsEvent.VoicePermissionResolved,
            { permission: "denied" },
          );
          setPermissionDenied(true);
        }
        fail(failure.failureClass, {}, failure.message, error);
        return null;
      }
    },
    [fail, runnerHost],
  );

  const startAudioGraph = useCallback(
    async (generation: number): Promise<void> => {
      if (generation !== startGenerationRef.current) return;
      const ctx = audioContextRef.current;
      if (ctx === null) {
        return;
      }
      const stream = await acquireMicStream(generation);
      if (stream === null) return;
      if (generation !== startGenerationRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      mediaStreamRef.current = stream;
      if (ctx.state === "suspended") {
        await ctx.resume().catch((error: unknown) => {
          appLogger.warn("[voice-dictation] audio context resume failed", {
            error: describeLogError(error),
          });
        });
        if (generation !== startGenerationRef.current) return;
      }
      if (ctx.state !== "running") {
        fail(
          "audio_context_not_running",
          {},
          "Could not start audio capture (the audio context did not start).",
          "Could not start audio capture (the audio context did not start).",
        );
        return;
      }
      const source = ctx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      // The waveform visualizer (wavesurfer) taps `mediaStreamRef` itself via
      // its own AudioContext, so no analyser is needed in this graph.
      // 1 output channel (left silent - we never write the output buffer) so the
      // node can legally connect to `destination`; a 0-output node throws on
      // connect in Chromium.
      const processor = ctx.createScriptProcessor(PROCESSOR_BUFFER_SIZE, 1, 1);
      processorRef.current = processor;
      processor.onaudioprocess = (event: AudioProcessingEvent) => {
        // Generation-pinned: teardown nulls `onaudioprocess`, but an audio
        // task the browser queued before that can still run this closure - it
        // must not route this session's PCM into a successor session's client
        // (the refs below are live, not session-scoped).
        if (generation !== startGenerationRef.current) return;
        const input = event.inputBuffer.getChannelData(0);
        const pcm = floatToPcm16(input);
        const client = speechClientRef.current;
        if (client === null) return;
        if (readyRef.current) {
          client.sendAudio(pcm);
        } else {
          pendingChunksRef.current.push(pcm);
        }
      };
      source.connect(processor);
      // ScriptProcessorNode only fires `onaudioprocess` while wired into the
      // graph; connecting its (silent) output to `destination` keeps it pulled.
      processor.connect(ctx.destination);
      // The graph is wired and pulling; if the speech session's `ready`
      // already landed this takes the "recording" transition, otherwise
      // `onReady` will.
      audioGraphReadyRef.current = true;
      const client = speechClientRef.current;
      if (client !== null) {
        tryBeginRecording(client);
      }
    },
    [acquireMicStream, fail, tryBeginRecording],
  );

  const start = useCallback(() => {
    if (state === "recording" || state === "requesting") return;
    // Clear everything the PREVIOUS attempt left behind FIRST - before any
    // failure path below can read it or outlive it.
    //
    // The refs are only meaningful for the attempt now beginning: a failure
    // that reports the previous attempt's connection status or a still-growing
    // time-since-recording is worse than no diagnostic, because it sends triage
    // after the wrong session. `null` here honestly means "this attempt never
    // got that far".
    //
    // The error state has to clear here too, not after the not-connected branch
    // below. `permissionDenied` drives the "Open Settings" affordance, so a
    // denied attempt followed by one with no host would pair a host-link
    // failure with a microphone remedy - and since the failure class rides the
    // Report Issue prefill, the filed report would read `not_connected` while
    // telling the user to grant microphone access.
    recordingStartedAtRef.current = null;
    lastConnectionStatusRef.current = null;
    setErrorMessage(null);
    setFailureClass(null);
    setPermissionDenied(false);
    if (wsStreamClient === null) {
      fail(
        "not_connected",
        {},
        "Not connected to the local host.",
        "Not connected to the local host.",
      );
      return;
    }
    // Cancel any fallback timer left armed by a previous stop() so it can't
    // later finalize() this fresh session.
    if (finalizeTimerRef.current !== null) {
      window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    setState("requesting");
    readyRef.current = false;
    audioGraphReadyRef.current = false;
    // (`recordingStartedAtRef` is cleared above, before the not-connected
    // branch, so a stop during "requesting" can't report a stopped event
    // stamped with the PREVIOUS recording's start time either.)
    pendingChunksRef.current = [];
    closingRef.current = false;
    const generation = startGenerationRef.current + 1;
    startGenerationRef.current = generation;

    // Create the capture context up front so we can report its true sample rate
    // to the host (the browser may pin it to the hardware rate, ignoring the
    // 16 kHz hint). Fall back to the hardware rate if 16 kHz is unsupported; the
    // host resamples either way.
    let ctx: AudioContext;
    try {
      ctx = new AudioContext({ sampleRate: SPEECH_INPUT_SAMPLE_RATE });
    } catch (error) {
      appLogger.warn("[voice-dictation] requested sample rate unsupported", {
        sampleRate: SPEECH_INPUT_SAMPLE_RATE,
        error: describeLogError(error),
      });
      try {
        ctx = new AudioContext();
      } catch (error) {
        // No log here either: `fail()` writes the single line for this path.
        fail(
          "audio_context_create_failed",
          {},
          `Could not start audio capture: ${
            error instanceof Error ? error.message : String(error)
          }`,
          error,
        );
        return;
      }
    }
    audioContextRef.current = ctx;

    const client = new SpeechStreamClient({
      wsStreamClient,
      language: handlersRef.current.language,
      sampleRate: ctx.sampleRate,
      callbacks: {
        onReady: () => {
          // Ignore a `ready` that arrives after this session was stopped/
          // cancelled or superseded by a newer one - otherwise it would flip the
          // UI back to "recording" with no live capture.
          if (closingRef.current || speechClientRef.current !== client) return;
          readyRef.current = true;
          // "recording" additionally needs the wired capture graph - a `ready`
          // that beats the permission prompt must not show a recording UI
          // that captures nothing (the prompt may still fail).
          tryBeginRecording(client);
        },
        onTranscript: (frame) => {
          // Insert only while THIS client is still the active session - guards
          // against a late final from a stopped/cancelled session landing in a
          // newer recording's composer. (Finals after stop, during
          // "transcribing", are still wanted, so this isn't gated on closing.)
          if (frame.isFinal && speechClientRef.current === client) {
            handlersRef.current.onText(frame.text);
          }
        },
        onFlushed: () => {
          // A later attempt (auto-restart, or a stop/start racing this flush)
          // already superseded this session - ignore its stale resolution,
          // matching onTranscript's guard. Otherwise this would finalize()
          // the ACTIVE session out from under it.
          if (speechClientRef.current !== client) return;
          // Same gate as the stopped event: a flush of a session that never
          // reached "recording" transcribed nothing worth counting.
          if (recordingStartedAtRef.current !== null) {
            Analytics.getInstance().track(
              AnalyticsEvent.VoiceTranscriptionSucceeded,
              {
                duration_bucket: dictationDurationBucket(
                  recordingStartedAtRef.current,
                ),
              },
            );
          }
          finalize();
        },
        onError: (frame) => {
          if (speechClientRef.current !== client) return;
          // `frame` still goes in as the analytics error (unchanged
          // classification); the host's own code rides the log fields, where
          // it names ENGINE_UNAVAILABLE / MODEL_NOT_READY / DICTATION_FAILED.
          fail(
            "host_error_frame",
            { hostErrorCode: frame.code },
            frame.message,
            frame,
          );
        },
        onConnectionStatus: (status, reason) => {
          if (speechClientRef.current !== client) return;
          lastConnectionStatusRef.current = status;
          if (status !== "closed") return;
          if (closingRef.current) {
            // Expected close (we flushed / tore down). Settle the UI if it's
            // still waiting on a `flushed` the dropped socket can't deliver.
            if (stateRef.current === "transcribing") finalize();
            return;
          }
          // Unexpected drop mid-recording: surface it and stop capturing,
          // otherwise the audio graph keeps buffering with nowhere to send.
          markClosing();
          fail(
            "connection_lost",
            // Optional chaining, not a null check: the declared type says
            // `| null`, but this is a callback the transport invokes - a
            // caller that omits the argument entirely must not turn a
            // diagnostic into a crash inside the failure path itself.
            { closeReason: reason?.kind ?? "none" },
            "Lost connection to the local host.",
            "Lost connection to the local host.",
          );
        },
      },
    });
    speechClientRef.current = client;
    void startAudioGraph(generation);
  }, [
    state,
    wsStreamClient,
    fail,
    finalize,
    markClosing,
    startAudioGraph,
    tryBeginRecording,
  ]);

  const stop = useCallback(() => {
    const client = speechClientRef.current;
    if (client === null) {
      setState("idle");
      return;
    }
    // Invalidate any startAudioGraph still waiting on the permission prompt so
    // it can't re-arm capture into this now-flushing session.
    startGenerationRef.current += 1;
    // Only a session that actually reached "recording" reports a stop - a
    // stop while still requesting has no matching started event.
    if (recordingStartedAtRef.current !== null) {
      Analytics.getInstance().track(AnalyticsEvent.VoiceDictationStopped, {
        duration_bucket: dictationDurationBucket(recordingStartedAtRef.current),
      });
    }
    markClosing();
    // Stop capturing immediately and ask the host to transcribe the buffered
    // utterance. Stay connected until it replies `flushed` (→ `finalize`); the
    // timer is only a fallback if that reply never lands.
    teardownAudio();
    readyRef.current = false;
    setState("transcribing");
    client.flush();
    if (finalizeTimerRef.current !== null)
      window.clearTimeout(finalizeTimerRef.current);
    finalizeTimerRef.current = window.setTimeout(
      finalize,
      FINALIZE_FALLBACK_MS,
    );
  }, [teardownAudio, finalize, markClosing]);

  const toggle = useCallback(() => {
    if (state === "recording" || state === "requesting") {
      stop();
      return;
    }
    // Ignore a toggle while a flush is still settling - starting a new session
    // mid-transcription would race the in-flight finalize.
    if (state === "transcribing") return;
    start();
  }, [state, start, stop]);

  // Abort: tear down without flushing so the in-progress utterance is dropped.
  const cancel = useCallback(() => {
    startGenerationRef.current += 1;
    if (stateRef.current === "recording" || stateRef.current === "requesting") {
      Analytics.getInstance().track(
        AnalyticsEvent.VoiceDictationCancelled,
        null,
      );
    }
    markClosing();
    teardownAll();
    setState("idle");
    setErrorMessage(null);
    setFailureClass(null);
    setPermissionDenied(false);
  }, [markClosing, teardownAll]);

  const getStream = useCallback(() => mediaStreamRef.current, []);

  // Tear everything down on unmount. Mark closing first so a stream-close
  // callback that lands after teardown is treated as an expected close, not the
  // unexpected-drop path (which would fail()/setState on an unmounted hook).
  useEffect(() => {
    return () => {
      markClosing();
      teardownAll();
    };
  }, [markClosing, teardownAll]);

  return {
    state,
    errorMessage,
    failureClass,
    permissionDenied,
    start,
    stop,
    toggle,
    cancel,
    getStream,
  };
}

function floatToPcm16(input: Float32Array): Uint8Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, input[i]));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}
