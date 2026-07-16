import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
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
    readonly onError: (frame: { readonly message: string }) => void;
    readonly onConnectionStatus: (
      status: "connecting" | "open" | "closed",
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

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () => ({}),
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
