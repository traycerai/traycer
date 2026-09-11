import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatSessionStore } from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";

const EPIC_ID = "epic-1";
const CHAT_ID = "chat-1";
const OWNER_ID = "owner-1";

function createRetryStore(input: {
  readonly wakeTransport: (() => void) | null;
  readonly transportSilentFor?: ((ms: number) => boolean) | null;
}): {
  readonly handle: ReturnType<typeof createChatSessionStore>;
  readonly factoryCalls: () => number;
  readonly order: readonly string[];
} {
  const order: string[] = [];
  let factoryCalls = 0;
  const wake = input.wakeTransport;
  const handle = createChatSessionStore({
    environment: CHAT_STORE_TEST_ENVIRONMENT,
    hostId: "host-a",
    epicId: EPIC_ID,
    chatId: CHAT_ID,
    userId: OWNER_ID,
    onAuthError: null,
    onProviderAuthError: null,
    wakeTransport:
      wake === null
        ? null
        : () => {
            order.push("wake");
            wake();
          },
    ...(input.transportSilentFor === undefined
      ? {}
      : { transportSilentFor: input.transportSilentFor }),
    streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
    streamClientFactory: () => {
      factoryCalls += 1;
      order.push("subscribe");
      return {
        sendAction: () => undefined,
        sameTurnSteeringProtocolSupported: () => true,
        requestTranscriptRange: () => undefined,
        requestResnapshot: () => undefined,
        close: () => undefined,
      };
    },
  });
  return {
    handle,
    factoryCalls: () => factoryCalls,
    order,
  };
}

describe("createChatSessionStore retryFromUser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls wakeTransport then re-subscribes when transportSilentFor answers true", () => {
    const wakeTransport = vi.fn();
    const store = createRetryStore({
      wakeTransport,
      transportSilentFor: () => true,
    });
    expect(store.factoryCalls()).toBe(1);

    store.handle.store.getState().retryFromUser();

    expect(wakeTransport).toHaveBeenCalledTimes(1);
    expect(store.factoryCalls()).toBe(2);
    expect(store.order).toEqual(["subscribe", "wake", "subscribe"]);
    store.handle.dispose();
  });

  it("only re-subscribes when transportSilentFor answers false", () => {
    const wakeTransport = vi.fn();
    const store = createRetryStore({
      wakeTransport,
      transportSilentFor: () => false,
    });

    store.handle.store.getState().retryFromUser();

    expect(wakeTransport).not.toHaveBeenCalled();
    expect(store.factoryCalls()).toBe(2);
    expect(store.order).toEqual(["subscribe", "subscribe"]);
    store.handle.dispose();
  });

  it("only re-subscribes when transportSilentFor is null", () => {
    const wakeTransport = vi.fn();
    const store = createRetryStore({
      wakeTransport,
      transportSilentFor: null,
    });

    store.handle.store.getState().retryFromUser();

    expect(wakeTransport).not.toHaveBeenCalled();
    expect(store.factoryCalls()).toBe(2);
    store.handle.dispose();
  });

  it("only re-subscribes when transportSilentFor is absent", () => {
    const wakeTransport = vi.fn();
    const store = createRetryStore({ wakeTransport });

    store.handle.store.getState().retryFromUser();

    expect(wakeTransport).not.toHaveBeenCalled();
    expect(store.factoryCalls()).toBe(2);
    store.handle.dispose();
  });

  it("retry() never calls wakeTransport even when transportSilentFor answers true", () => {
    const wakeTransport = vi.fn();
    const store = createRetryStore({
      wakeTransport,
      transportSilentFor: () => true,
    });

    store.handle.store.getState().retry();

    expect(wakeTransport).not.toHaveBeenCalled();
    expect(store.factoryCalls()).toBe(2);
    expect(store.order).toEqual(["subscribe", "subscribe"]);
    store.handle.dispose();
  });
});
