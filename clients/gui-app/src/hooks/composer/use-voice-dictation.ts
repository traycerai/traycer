/* eslint-disable @typescript-eslint/no-deprecated -- ScriptProcessorNode is used
   deliberately to capture PCM without a separate AudioWorklet asset (which would
   need CSP `script-src` widening for `file://`); migrating to AudioWorklet is a
   follow-up. */
import { useCallback, useEffect, useRef, useState } from "react";
import { SPEECH_INPUT_SAMPLE_RATE } from "@traycer/protocol/host/speech/schemas";
import { SpeechStreamClient } from "@traycer-clients/shared/host-transport/speech-stream-client";
import { useWsStreamClient } from "@/lib/host/stream-runtime-context";
import { appLogger, describeLogError } from "@/lib/logger";
import { useRunnerHost } from "@/providers/use-runner-host";

export type VoiceDictationState =
  | "idle"
  | "requesting"
  | "recording"
  | "transcribing"
  | "error";

export interface UseVoiceDictationArgs {
  readonly language: string;
  // Called with each finalized transcript segment (the engine emits per-pause
  // finals, no interims).
  readonly onText: (text: string) => void;
}

export interface UseVoiceDictation {
  readonly state: VoiceDictationState;
  readonly errorMessage: string | null;
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

  const markClosing = useCallback(() => {
    closingRef.current = true;
  }, []);

  const teardownAudio = useCallback(() => {
    processorRef.current?.disconnect();
    processorRef.current = null;
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
    (message: string) => {
      markClosing();
      teardownAll();
      setState("error");
      setErrorMessage(message);
    },
    [markClosing, teardownAll],
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

  // Run the permission prompt + getUserMedia. Returns null (and surfaces an
  // error, or silently aborts) when the mic can't be opened or the session was
  // stopped/cancelled while the prompt was up (detected via `generation`).
  const acquireMicStream = useCallback(
    async (generation: number): Promise<MediaStream | null> => {
      if (generation !== startGenerationRef.current) return null;
      if (typeof navigator === "undefined") {
        fail("Microphone capture is not available in this environment.");
        return null;
      }
      // Trigger the native OS permission prompt (macOS) before opening the
      // stream. Returns the existing decision when already set; a denied app is
      // never re-prompted, so route those to the "Open Settings" affordance.
      const access = await runnerHost.requestMicrophoneAccess();
      if (generation !== startGenerationRef.current) return null;
      if (access === "denied") {
        setPermissionDenied(true);
        fail("Microphone access is blocked for Traycer.");
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
        return stream;
      } catch (error) {
        const denied =
          error instanceof Error && error.name === "NotAllowedError";
        appLogger.warn(
          "[voice-dictation] microphone stream acquisition failed",
          {
            denied,
            error: describeLogError(error),
          },
        );
        if (denied) setPermissionDenied(true);
        fail(
          denied
            ? "Microphone access is blocked for Traycer."
            : `Could not access the microphone: ${
                error instanceof Error ? error.message : String(error)
              }`,
        );
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
    },
    [acquireMicStream, fail],
  );

  const start = useCallback(() => {
    if (state === "recording" || state === "requesting") return;
    if (wsStreamClient === null) {
      fail("Not connected to the local host.");
      return;
    }
    // Cancel any fallback timer left armed by a previous stop() so it can't
    // later finalize() this fresh session.
    if (finalizeTimerRef.current !== null) {
      window.clearTimeout(finalizeTimerRef.current);
      finalizeTimerRef.current = null;
    }
    setErrorMessage(null);
    setPermissionDenied(false);
    setState("requesting");
    readyRef.current = false;
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
        appLogger.warn("[voice-dictation] audio context creation failed", {
          error: describeLogError(error),
        });
        fail(
          `Could not start audio capture: ${
            error instanceof Error ? error.message : String(error)
          }`,
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
          setState("recording");
          const pending = pendingChunksRef.current;
          pendingChunksRef.current = [];
          for (const chunk of pending) client.sendAudio(chunk);
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
          finalize();
        },
        onError: (frame) => {
          fail(frame.message);
        },
        onConnectionStatus: (status) => {
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
          fail("Lost connection to the local host.");
        },
      },
    });
    speechClientRef.current = client;
    void startAudioGraph(generation);
  }, [state, wsStreamClient, fail, finalize, markClosing, startAudioGraph]);

  const stop = useCallback(() => {
    const client = speechClientRef.current;
    if (client === null) {
      setState("idle");
      return;
    }
    // Invalidate any startAudioGraph still waiting on the permission prompt so
    // it can't re-arm capture into this now-flushing session.
    startGenerationRef.current += 1;
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
    markClosing();
    teardownAll();
    setState("idle");
    setErrorMessage(null);
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
