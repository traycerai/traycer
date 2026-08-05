import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import { appLogger } from "@/lib/logger";
import { useVoiceDictation } from "@/hooks/composer/use-voice-dictation";

// ---------------------------------------------------------------------------
// Module fakes. The hook's true external boundaries are the speech stream
// client (host transport), the runner host (permission IPC), and the Web
// Audio / getUserMedia browser APIs - everything else runs real.
// ---------------------------------------------------------------------------

const speech = vi.hoisted(() => {
  interface FakeSpeechCallbacks {
    readonly onReady: () => void;
    readonly onTranscript: (frame: {
      readonly text: string;
      readonly isFinal: boolean;
    }) => void;
    readonly onFlushed: () => void;
    readonly onError: (frame: {
      readonly message: string;
      readonly code: string;
    }) => void;
    readonly onConnectionStatus: (
      status: "connecting" | "open" | "closed",
      // Mirrors the real `StreamCloseReason | null`: a close can arrive with
      // no reason attached, which the hook must survive.
      reason: { readonly kind: string } | null,
    ) => void;
  }
  interface FakeSpeechOptions {
    readonly wsStreamClient: unknown;
    readonly language: string;
    readonly sampleRate: number;
    readonly callbacks: FakeSpeechCallbacks;
  }
  class FakeSpeechStreamClient {
    static instances: FakeSpeechStreamClient[] = [];
    readonly callbacks: FakeSpeechCallbacks;
    readonly sent: Uint8Array[] = [];
    flushCalls = 0;
    closeCalls = 0;
    constructor(options: FakeSpeechOptions) {
      this.callbacks = options.callbacks;
      FakeSpeechStreamClient.instances.push(this);
    }
    sendAudio(chunk: Uint8Array): void {
      this.sent.push(chunk);
    }
    flush(): void {
      this.flushCalls += 1;
    }
    close(): void {
      this.closeCalls += 1;
    }
  }
  return { FakeSpeechStreamClient };
});

vi.mock("@traycer-clients/shared/host-transport/speech-stream-client", () => ({
  SpeechStreamClient: speech.FakeSpeechStreamClient,
}));

const runnerHostState = vi.hoisted(() => ({
  requestMicrophoneAccess: (): Promise<string> => Promise.resolve("granted"),
}));

vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({
    requestMicrophoneAccess: () => runnerHostState.requestMicrophoneAccess(),
  }),
}));

const streamRuntimeState = vi.hoisted(
  (): { wsStreamClient: object | null } => ({ wsStreamClient: {} }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => streamRuntimeState.wsStreamClient,
}));

// ---------------------------------------------------------------------------
// Browser API fakes (Web Audio + getUserMedia).
// ---------------------------------------------------------------------------

interface MinimalAudioProcessEvent {
  readonly inputBuffer: {
    getChannelData(channel: number): Float32Array;
  };
}

class FakeScriptProcessor {
  onaudioprocess: ((event: MinimalAudioProcessEvent) => void) | null = null;
  connectCalls = 0;
  disconnectCalls = 0;
  connect(): void {
    this.connectCalls += 1;
  }
  disconnect(): void {
    this.disconnectCalls += 1;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state = "running";
  readonly sampleRate = 16_000;
  readonly destination = {};
  processor: FakeScriptProcessor | null = null;
  constructor() {
    FakeAudioContext.instances.push(this);
  }
  createMediaStreamSource(_stream: unknown): {
    connect(target: unknown): void;
    disconnect(): void;
  } {
    return { connect: () => undefined, disconnect: () => undefined };
  }
  createScriptProcessor(
    _bufferSize: number,
    _inputs: number,
    _outputs: number,
  ): FakeScriptProcessor {
    const processor = new FakeScriptProcessor();
    this.processor = processor;
    return processor;
  }
  resume(): Promise<void> {
    this.state = "running";
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = "closed";
    return Promise.resolve();
  }
}

interface FakeMediaStream {
  getTracks(): Array<{ stop(): void }>;
}

function fakeMediaStream(): FakeMediaStream {
  return { getTracks: () => [{ stop: () => undefined }] };
}

let getUserMediaImpl: () => Promise<FakeMediaStream> = () =>
  Promise.resolve(fakeMediaStream());

const globalWithAudio = globalThis as { AudioContext?: unknown };
let originalAudioContext: unknown;
let originalMediaDevices: PropertyDescriptor | undefined;

function fireAudio(processor: FakeScriptProcessor, samples: number[]): void {
  processor.onaudioprocess?.({
    inputBuffer: { getChannelData: () => new Float32Array(samples) },
  });
}

async function flushAsync(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

function lastSpeechClient() {
  const instance = speech.FakeSpeechStreamClient.instances.at(-1);
  if (instance === undefined) {
    throw new Error("no speech client was constructed");
  }
  return instance;
}

function lastAudioContext(): FakeAudioContext {
  const instance = FakeAudioContext.instances.at(-1);
  if (instance === undefined) {
    throw new Error("no audio context was constructed");
  }
  return instance;
}

beforeEach(() => {
  speech.FakeSpeechStreamClient.instances = [];
  FakeAudioContext.instances = [];
  streamRuntimeState.wsStreamClient = {};
  runnerHostState.requestMicrophoneAccess = () => Promise.resolve("granted");
  getUserMediaImpl = () => Promise.resolve(fakeMediaStream());
  originalAudioContext = globalWithAudio.AudioContext;
  globalWithAudio.AudioContext = FakeAudioContext;
  originalMediaDevices = Object.getOwnPropertyDescriptor(
    navigator,
    "mediaDevices",
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: () => getUserMediaImpl() },
  });
});

afterEach(() => {
  globalWithAudio.AudioContext = originalAudioContext;
  if (originalMediaDevices !== undefined) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  vi.restoreAllMocks();
});

function renderDictation() {
  return renderHook(() =>
    useVoiceDictation({ language: "en", onText: () => undefined }),
  );
}

describe("useVoiceDictation lifecycle", () => {
  it("surfaces an error instead of wedging in requesting when the permission IPC rejects", async () => {
    runnerHostState.requestMicrophoneAccess = () =>
      Promise.reject(new Error("ipc channel dead"));
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    expect(result.current.state).toBe("requesting");
    await flushAsync();

    expect(result.current.state).toBe("error");
    expect(result.current.errorMessage).toContain(
      "Could not request microphone access",
    );
  });

  it("ignores a stale getUserMedia rejection from a cancelled session (newer session unaffected)", async () => {
    let rejectFirst: (error: Error) => void = () => undefined;
    getUserMediaImpl = () =>
      new Promise<FakeMediaStream>((_resolve, reject) => {
        rejectFirst = reject;
      });
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    expect(result.current.state).toBe("requesting");

    act(() => {
      result.current.cancel();
    });
    expect(result.current.state).toBe("idle");

    // A fresh session with its own (still pending) acquisition.
    getUserMediaImpl = () => new Promise<FakeMediaStream>(() => undefined);
    act(() => {
      result.current.start();
    });
    await flushAsync();
    expect(result.current.state).toBe("requesting");

    // The abandoned session's acquisition now rejects - it must not fail the
    // newer session.
    rejectFirst(new Error("device disappeared"));
    await flushAsync();

    expect(result.current.state).toBe("requesting");
    expect(result.current.errorMessage).toBeNull();
  });

  it("does not show recording on speech readiness alone while the mic prompt is still pending", async () => {
    let resolveStream: (stream: FakeMediaStream) => void = () => undefined;
    getUserMediaImpl = () =>
      new Promise<FakeMediaStream>((resolve) => {
        resolveStream = resolve;
      });
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();

    // Speech session becomes ready while the permission prompt is still up.
    act(() => {
      lastSpeechClient().callbacks.onReady();
    });
    expect(result.current.state).toBe("requesting");

    // The prompt resolves and the capture graph wires - NOW recording begins.
    resolveStream(fakeMediaStream());
    await flushAsync();
    expect(result.current.state).toBe("recording");
  });

  it("does not show recording on a wired capture graph alone, queues audio, and flushes it on speech readiness", async () => {
    const track = vi.spyOn(Analytics.getInstance(), "track");
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();

    // Graph is wired but the speech session has not said ready.
    const processor = lastAudioContext().processor;
    expect(processor).not.toBeNull();
    if (processor === null) throw new Error("unreachable");
    expect(result.current.state).toBe("requesting");

    // Audio produced pre-ready is queued, not sent.
    act(() => {
      fireAudio(processor, [0.25, -0.25]);
      fireAudio(processor, [0.5, -0.5]);
    });
    expect(lastSpeechClient().sent).toHaveLength(0);

    act(() => {
      lastSpeechClient().callbacks.onReady();
    });
    expect(result.current.state).toBe("recording");
    // The queued chunks were flushed in order at the transition.
    expect(lastSpeechClient().sent).toHaveLength(2);
    // Post-ready audio is sent directly.
    act(() => {
      fireAudio(processor, [0.1, -0.1]);
    });
    expect(lastSpeechClient().sent).toHaveLength(3);
    expect(
      track.mock.calls.filter(
        ([event]) => event === AnalyticsEvent.VoiceDictationStarted,
      ),
    ).toHaveLength(1);
  });

  it("cannot route a stale queued audio callback into a new session after rapid cancel/restart", async () => {
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    act(() => {
      lastSpeechClient().callbacks.onReady();
    });
    expect(result.current.state).toBe("recording");

    const firstProcessor = lastAudioContext().processor;
    expect(firstProcessor).not.toBeNull();
    if (firstProcessor === null) throw new Error("unreachable");
    // A queued browser audio task holds the handler closure even after
    // teardown detaches it from the node.
    const retainedCallback = firstProcessor.onaudioprocess;
    expect(retainedCallback).not.toBeNull();

    act(() => {
      result.current.cancel();
    });
    // Teardown detached the callback from the node itself.
    expect(firstProcessor.onaudioprocess).toBeNull();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    act(() => {
      lastSpeechClient().callbacks.onReady();
    });
    expect(result.current.state).toBe("recording");
    const secondClient = lastSpeechClient();
    expect(secondClient.sent).toHaveLength(0);

    // The stale task fires anyway: the generation pin must drop its PCM
    // instead of routing it into the new session's client.
    act(() => {
      retainedCallback?.({
        inputBuffer: { getChannelData: () => new Float32Array([0.7, -0.7]) },
      });
    });
    expect(secondClient.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Failure-class observability. Two field reports (oss #945, #1003) were
// root-caused only by elimination because `fail()` wrote no log line at all.
// These cover the classes a support bundle actually turns on - the transport
// pair, the host error frame, the mic split, and the two paths that used to
// emit their own warn - plus the two rules that make a class worth trusting:
// a line describes THIS attempt (never the previous one), and an attempt
// produces exactly one class (a late-resolving capture task must not overwrite
// the cause that killed the session). They do not exhaust all ten classes;
// `fail()` writing the line centrally is what makes the rest structural rather
// than test-enforced.
// ---------------------------------------------------------------------------

describe("useVoiceDictation failure logging", () => {
  // Returns an accessor rather than the spy itself: naming a vitest spy's type
  // needs `ReturnType<typeof ...>`, which this repo bans (and which does not
  // type-check for an overloaded `spyOn`). Inference keeps it honest.
  function spyOnFailureLog() {
    const spy = vi
      .spyOn(appLogger, "error")
      .mockImplementation(() => undefined);
    return {
      failures: () =>
        spy.mock.calls.filter((call) => call[0] === "[voice-dictation] failed"),
      restore: () => {
        spy.mockRestore();
      },
    };
  }

  it("names not_connected when dictation starts with no host stream client", () => {
    streamRuntimeState.wsStreamClient = null;
    const log = spyOnFailureLog();
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });

    const logs = log.failures();
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      failureClass: "not_connected",
      hasStreamClient: false,
      connectionStatus: "none",
    });
    expect(result.current.failureClass).toBe("not_connected");
  });

  it("names connection_lost, with the close reason, when the stream drops mid-recording", async () => {
    const log = spyOnFailureLog();
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    act(() => {
      lastSpeechClient().callbacks.onReady();
    });
    expect(result.current.state).toBe("recording");

    act(() => {
      lastSpeechClient().callbacks.onConnectionStatus("closed", {
        kind: "fatalError",
      });
    });

    const logs = log.failures();
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      failureClass: "connection_lost",
      state: "recording",
      connectionStatus: "closed",
      closeReason: "fatalError",
      sessionReady: true,
    });
    expect(result.current.failureClass).toBe("connection_lost");
  });

  it("does not throw when the close carries no reason", async () => {
    const log = spyOnFailureLog();
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    act(() => {
      lastSpeechClient().callbacks.onReady();
    });

    act(() => {
      // A reasonless close - the diagnostic must not crash the failure path
      // it is meant to describe.
      lastSpeechClient().callbacks.onConnectionStatus("closed", null);
    });

    expect(log.failures()[0][1]).toMatchObject({
      failureClass: "connection_lost",
      closeReason: "none",
    });
  });

  it("names host_error_frame and carries the host's own error code", async () => {
    const log = spyOnFailureLog();
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();

    act(() => {
      lastSpeechClient().callbacks.onError({
        message: "the on-device model is not installed",
        code: "MODEL_NOT_READY",
      });
    });

    const logs = log.failures();
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({
      failureClass: "host_error_frame",
      hostErrorCode: "MODEL_NOT_READY",
    });
    expect(result.current.failureClass).toBe("host_error_frame");
  });

  it("splits a denied getUserMedia from any other mic-open failure", async () => {
    const denial = new Error("blocked");
    denial.name = "NotAllowedError";
    getUserMediaImpl = () => Promise.reject(denial);
    const deniedLog = spyOnFailureLog();
    const denied = renderDictation();

    act(() => {
      denied.result.current.start();
    });
    await flushAsync();

    expect(deniedLog.failures()[0][1]).toMatchObject({
      failureClass: "permission_denied_browser",
    });
    deniedLog.restore();

    getUserMediaImpl = () => Promise.reject(new Error("device in use"));
    const otherLog = spyOnFailureLog();
    const other = renderDictation();

    act(() => {
      other.result.current.start();
    });
    await flushAsync();

    expect(otherLog.failures()[0][1]).toMatchObject({
      failureClass: "mic_open_failed",
    });
  });

  it("logs exactly one line when getUserMedia fails, not the warn it used to emit", async () => {
    const warnSpy = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    const log = spyOnFailureLog();
    getUserMediaImpl = () => Promise.reject(new Error("device in use"));
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();

    expect(log.failures()).toHaveLength(1);
    expect(
      warnSpy.mock.calls.filter((call) =>
        call[0].startsWith("[voice-dictation] microphone stream"),
      ),
    ).toHaveLength(0);
  });

  it("logs exactly one line when the audio context cannot be constructed", async () => {
    // The other path that used to emit its own warn. Both constructor forms
    // must throw: the hook retries without the sample-rate hint before giving
    // up, and only the second failure reaches fail().
    const warnSpy = vi
      .spyOn(appLogger, "warn")
      .mockImplementation(() => undefined);
    const log = spyOnFailureLog();
    globalWithAudio.AudioContext = function ThrowingAudioContext(): never {
      throw new Error("no audio device");
    };
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();

    const failures = log.failures();
    expect(failures).toHaveLength(1);
    expect(failures[0][1]).toMatchObject({
      failureClass: "audio_context_create_failed",
    });
    expect(
      warnSpy.mock.calls.filter((call) =>
        call[0].startsWith("[voice-dictation] audio context creation"),
      ),
    ).toHaveLength(0);
  });

  it("describes THIS attempt, not the previous one, when a retry finds no host", async () => {
    // A stale `connectionStatus`/`msSinceRecordingStart` would send triage
    // after the wrong session - worse than no diagnostic at all.
    const { result, rerender } = renderDictation();

    // Attempt 1: record for real, then let the session close normally.
    act(() => {
      result.current.start();
    });
    await flushAsync();
    act(() => {
      lastSpeechClient().callbacks.onReady();
    });
    expect(result.current.state).toBe("recording");
    // Record a live status BEFORE tearing down: after cancel() the hook has
    // dropped its client reference and ignores further status callbacks, so a
    // status fired post-cancel would leave the ref null and this test would
    // assert "none" vacuously - passing even without the reset.
    act(() => {
      lastSpeechClient().callbacks.onConnectionStatus("open", null);
    });
    act(() => {
      result.current.cancel();
    });

    // Attempt 2: the host link is gone.
    streamRuntimeState.wsStreamClient = null;
    rerender();
    const log = spyOnFailureLog();
    act(() => {
      result.current.start();
    });

    const failures = log.failures();
    expect(failures).toHaveLength(1);
    expect(failures[0][1]).toMatchObject({
      failureClass: "not_connected",
      connectionStatus: "none",
      msSinceRecordingStart: null,
    });
  });

  it("clears the failure class when a new attempt starts", async () => {
    streamRuntimeState.wsStreamClient = null;
    const { result, rerender } = renderDictation();

    act(() => {
      result.current.start();
    });
    expect(result.current.failureClass).toBe("not_connected");

    // The host link comes back. `rerender` is what feeds the hook the new
    // client - mutating the module state alone leaves the previous render's
    // closure holding the null one, which is exactly the stale-session bug
    // the generation pin exists to prevent.
    streamRuntimeState.wsStreamClient = {};
    rerender();
    act(() => {
      result.current.start();
    });
    await flushAsync();

    expect(result.current.failureClass).toBeNull();
    expect(result.current.state).toBe("requesting");
  });

  it("does not carry a denied attempt's microphone remedy into a host-link failure", async () => {
    // `permissionDenied` drives the composer's "Open Settings" action. Since
    // the failure class now rides the PUBLIC Report Issue prefill, a stale flag
    // produces one self-contradicting report: code `not_connected`, next to a
    // button that opens microphone settings.
    runnerHostState.requestMicrophoneAccess = () => Promise.resolve("denied");
    const { result, rerender } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    expect(result.current.failureClass).toBe("permission_denied_os");
    expect(result.current.permissionDenied).toBe(true);

    // The host link is gone by the time the user retries.
    streamRuntimeState.wsStreamClient = null;
    rerender();
    act(() => {
      result.current.start();
    });

    expect(result.current.failureClass).toBe("not_connected");
    expect(result.current.permissionDenied).toBe(false);
  });

  it("does not let a late microphone acquisition overwrite the failure that killed the session", async () => {
    // The host can fail a session while the permission prompt is still up.
    // `startAudioGraph` captured the AudioContext before that await, so the
    // resumed task would find it closed and report `audio_context_not_running`
    // over the real cause - burying the class this whole change exists to
    // deliver.
    let resolveStream: (stream: FakeMediaStream) => void = () => undefined;
    getUserMediaImpl = () =>
      new Promise<FakeMediaStream>((resolve) => {
        resolveStream = resolve;
      });
    const log = spyOnFailureLog();
    const { result } = renderDictation();

    act(() => {
      result.current.start();
    });
    await flushAsync();
    // The prompt is genuinely still pending - otherwise the race under test
    // never happens and this would pass vacuously.
    expect(result.current.state).toBe("requesting");

    act(() => {
      lastSpeechClient().callbacks.onError({
        message: "the on-device model is not installed",
        code: "MODEL_NOT_READY",
      });
    });
    expect(result.current.failureClass).toBe("host_error_frame");

    // The prompt the user was still looking at now resolves.
    resolveStream(fakeMediaStream());
    await flushAsync();

    expect(log.failures()).toHaveLength(1);
    expect(result.current.failureClass).toBe("host_error_frame");
  });
});
