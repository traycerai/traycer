import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { ChatStreamCallbacks } from "@traycer-clients/shared/host-transport/chat-stream-client";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  retryClosedChatSessions,
  subscribeChatSessionWakeRetry,
  WAKE_RETRY_EPISODE_MS,
} from "@/lib/chats/chat-session-wake-retry";

const EPIC_ID = "epic-wake";
const CHAT_ID = "chat-wake";

interface Harness {
  readonly handle: ChatSessionStoreHandle;
  readonly factoryRuns: () => number;
  readonly callbacks: () => ChatStreamCallbacks;
  /** Makes the NEXT factory invocation throw (one-shot). */
  readonly failNextFactoryRun: () => void;
}

function createHarness(chatId: string): Harness {
  let runs = 0;
  let failNext = false;
  let lastCallbacks: ChatStreamCallbacks | null = null;
  const handle = createChatSessionStore({
    epicId: EPIC_ID,
    chatId,
    userId: "user-wake",
    onAuthError: null,
    onProviderAuthError: null,
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: (_epicId, _chatId, nextCallbacks) => {
      runs += 1;
      if (failNext) {
        failNext = false;
        throw new Error("transport wiring failed");
      }
      lastCallbacks = nextCallbacks;
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => false,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    factoryRuns: () => runs,
    callbacks: () => {
      if (lastCallbacks === null) throw new Error("Expected callbacks");
      return lastCallbacks;
    },
    failNextFactoryRun: () => {
      failNext = true;
    },
  };
}

function driveTerminallyClosed(harness: Harness): void {
  harness.callbacks().onConnectionStatus("closed", {
    kind: "fatalError",
    details: {
      code: "UNAUTHORIZED",
      reason: "no-progress UNAUTHORIZED reconnects exhausted",
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  });
}

function makeRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

afterEach(() => {
  disposeAllChatSessions();
  vi.restoreAllMocks();
});

describe("retryClosedChatSessions", () => {
  it("re-dials a terminally closed session and clears its fatal close", () => {
    const harness = createHarness(CHAT_ID);
    driveTerminallyClosed(harness);
    expect(harness.handle.store.getState().connectionStatus).toBe("closed");
    expect(harness.factoryRuns()).toBe(1);

    const attempted = retryClosedChatSessions([harness.handle], "wake-resume");

    expect(attempted).toEqual([harness.handle]);
    expect(harness.factoryRuns()).toBe(2);
    expect(harness.handle.store.getState().connectionStatus).toBe("connecting");
    expect(harness.handle.store.getState().fatalClose).toBeNull();
    harness.handle.dispose();
  });

  it("leaves live sessions untouched - only closed ones get the wake dial", () => {
    const harness = createHarness(CHAT_ID);
    harness.callbacks().onConnectionStatus("open", null);

    const attempted = retryClosedChatSessions([harness.handle], "wake-resume");

    expect(attempted).toEqual([]);
    expect(harness.factoryRuns()).toBe(1);
    expect(harness.handle.store.getState().connectionStatus).toBe("open");
    harness.handle.dispose();
  });

  it("contains a throwing retry: the session returns to a retryable closed state and later handles still run", () => {
    const broken = createHarness("chat-broken");
    const healthy = createHarness("chat-healthy");
    driveTerminallyClosed(broken);
    driveTerminallyClosed(healthy);
    broken.failNextFactoryRun();

    const attempted = retryClosedChatSessions(
      [broken.handle, healthy.handle],
      "wake-resume",
    );

    // Both were attempted; the broken one is back in "closed" (NOT stranded in
    // "connecting") with its fatal close preserved, so a later pulse can try
    // again; the healthy one re-dialed despite the earlier throw.
    expect(attempted).toEqual([broken.handle, healthy.handle]);
    expect(broken.handle.store.getState().connectionStatus).toBe("closed");
    expect(broken.handle.store.getState().fatalClose?.code).toBe(
      "UNAUTHORIZED",
    );
    expect(healthy.handle.store.getState().connectionStatus).toBe("connecting");
    expect(healthy.factoryRuns()).toBe(2);

    // The broken session is retryable on the next pass.
    const second = retryClosedChatSessions([broken.handle], "wake-online");
    expect(second).toEqual([broken.handle]);
    expect(broken.handle.store.getState().connectionStatus).toBe("connecting");
    expect(broken.factoryRuns()).toBe(3);

    broken.handle.dispose();
    healthy.handle.dispose();
  });
});

describe("subscribeChatSessionWakeRetry", () => {
  function wireResumeSpy(runnerHost: MockRunnerHost): {
    readonly fireResume: () => void;
    readonly resumeDispose: Mock<() => void>;
  } {
    let capturedResume: (() => void) | null = null;
    const resumeDispose = vi.fn<() => void>();
    vi.spyOn(runnerHost, "onSystemResumed").mockImplementation((listener) => {
      capturedResume = listener;
      return { dispose: resumeDispose };
    });
    // Read through a function so the closure-assigned var keeps its declared
    // type (a direct narrow on the `let` collapses the else-branch to `never`).
    const fireResume = (): void => {
      if (capturedResume === null) throw new Error("Expected resume listener");
      capturedResume();
    };
    return { fireResume, resumeDispose };
  }

  it("retries registry sessions on the OS resume pulse, and detaches on dispose", () => {
    const runnerHost = makeRunnerHost();
    const { fireResume, resumeDispose } = wireResumeSpy(runnerHost);

    const harness = createHarness(CHAT_ID);
    __getChatSessionRegistryForTests().acquire(
      EPIC_ID,
      CHAT_ID,
      "wake-test-scope",
      () => harness.handle,
    );
    driveTerminallyClosed(harness);

    const dispose = subscribeChatSessionWakeRetry(runnerHost);

    fireResume();
    expect(harness.factoryRuns()).toBe(2);
    expect(harness.handle.store.getState().connectionStatus).toBe("connecting");

    // A second pulse while the session is no longer closed is a no-op.
    fireResume();
    expect(harness.factoryRuns()).toBe(2);

    dispose();
    expect(resumeDispose).toHaveBeenCalledTimes(1);
  });

  it("folds a burst of wake pulses into one dial per episode for a fast-re-closing session", () => {
    const runnerHost = makeRunnerHost();
    const { fireResume } = wireResumeSpy(runnerHost);
    let nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);

    const harness = createHarness(CHAT_ID);
    __getChatSessionRegistryForTests().acquire(
      EPIC_ID,
      CHAT_ID,
      "wake-test-scope",
      () => harness.handle,
    );
    driveTerminallyClosed(harness);

    const dispose = subscribeChatSessionWakeRetry(runnerHost);

    // Pulse 1 (resume) re-dials; the session immediately goes terminal again
    // (a permanently fatal close, e.g. INCOMPATIBLE).
    fireResume();
    expect(harness.factoryRuns()).toBe(2);
    driveTerminallyClosed(harness);

    // Pulses 2/3 (unlock-screen fan-out, debounced 'online') land inside the
    // same wake episode: no additional rebuild.
    nowMs += 300;
    fireResume();
    expect(harness.factoryRuns()).toBe(2);

    // The next physical wake (outside the episode window) dials again.
    nowMs += WAKE_RETRY_EPISODE_MS;
    fireResume();
    expect(harness.factoryRuns()).toBe(3);

    dispose();
  });
});
