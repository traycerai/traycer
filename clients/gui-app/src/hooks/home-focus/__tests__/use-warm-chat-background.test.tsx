import { useMemo, useState } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackgroundItem } from "@traycer/protocol/host/agent/gui/subscribe";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import { useWarmChatBackground } from "@/hooks/home-focus/use-warm-chat-background";
import {
  __getChatSessionRegistryForTests,
  disposeAllChatSessions,
} from "@/lib/registries/chat-session-registry";
import {
  createChatSessionStore,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import { IMMEDIATE_STREAM_FLUSH_COORDINATOR } from "@/stores/chats/stream-flush-coordinator";
import { CHAT_STORE_TEST_ENVIRONMENT } from "@/stores/chats/test-support/chat-store-test-environment";
import {
  makeManagedCommand,
  makeWakeupBackgroundItem,
} from "@/lib/home-focus/__tests__/fixtures";

/**
 * `useWarmChatBackground` reads the REAL chat-session registry - the only
 * client-side source for a warm chat's shells/background work - so it is
 * exercised against a real registry + real zustand session stores, the same
 * shape `use-epic-activity-status.test.tsx` uses for the identical registry.
 * No mock of the hook under test.
 */
const EPIC_ID = "epic-warm-1";
const HOST_ID = "host-warm-1";

function registerChatSession(
  chatId: string,
  overrides: {
    readonly managedCommands?: readonly ManagedCommand[];
    readonly backgroundItems?: readonly BackgroundItem[];
  },
): ChatSessionStoreHandle {
  const handle = __getChatSessionRegistryForTests().acquire(
    {
      epicId: EPIC_ID,
      chatId,
      hostId: HOST_ID,
      scopeKey: "warm-chat-background-test-scope",
    },
    () =>
      createChatSessionStore({
        environment: CHAT_STORE_TEST_ENVIRONMENT,
        hostId: HOST_ID,
        epicId: EPIC_ID,
        chatId,
        userId: null,
        onAuthError: null,
        onProviderAuthError: null,
        streamFlushCoordinator: IMMEDIATE_STREAM_FLUSH_COORDINATOR,
        streamClientFactory: () => ({
          sendAction: () => undefined,
          sameTurnSteeringProtocolSupported: () => true,
          requestTranscriptRange: () => undefined,
          requestResnapshot: () => undefined,
          close: () => undefined,
        }),
      }),
  );
  handle.store.setState({
    managedCommands: [...(overrides.managedCommands ?? [])],
    backgroundItems: [...(overrides.backgroundItems ?? [])],
  });
  return handle;
}

function runningCommand(id: string): ManagedCommand {
  return makeManagedCommand({
    id,
    status: { state: "running", pid: 1, startedAtMs: 0 },
  });
}

afterEach(() => {
  cleanup();
  disposeAllChatSessions();
  vi.restoreAllMocks();
});

describe("useWarmChatBackground", () => {
  it("produces no entry for a chat whose only background items are wakeups", () => {
    registerChatSession("chat-wakeup", {
      backgroundItems: [
        makeWakeupBackgroundItem({
          taskId: "task-1",
          title: "Scheduled wake",
          scheduledFor: 1_000,
        }),
      ],
    });

    const { result } = renderHook(() => useWarmChatBackground());

    expect(result.current).toHaveLength(0);
  });

  it("returns the SAME array reference across an unrelated registry notification", () => {
    registerChatSession("chat-a", {
      managedCommands: [runningCommand("cmd-a")],
    });

    const { result } = renderHook(() => useWarmChatBackground());
    const first = result.current;
    expect(first).toHaveLength(1);

    // An unrelated registry membership change - a second chat that
    // contributes nothing to the warm-background output (empty commands and
    // items), registered here purely to fire the registry's own `subscribe`
    // notification independent of any handle-level change.
    act(() => {
      registerChatSession("chat-b", {});
    });

    expect(result.current).toBe(first);
  });

  it("mints a new array when a chat's content actually changes", () => {
    const handle = registerChatSession("chat-a", {
      managedCommands: [runningCommand("cmd-a")],
    });

    const { result } = renderHook(() => useWarmChatBackground());
    const first = result.current;
    expect(first).toHaveLength(1);
    expect(first[0]?.managedCommands).toHaveLength(1);

    act(() => {
      handle.store.setState({
        managedCommands: [runningCommand("cmd-a"), runningCommand("cmd-b")],
      });
    });

    expect(result.current).not.toBe(first);
    expect(result.current[0]?.managedCommands).toHaveLength(2);
  });

  it("tears down both the registry subscription and the per-handle subscription on unmount", () => {
    const handle = registerChatSession("chat-a", {
      managedCommands: [runningCommand("cmd-a")],
    });
    const registry = __getChatSessionRegistryForTests();

    const originalRegistrySubscribe = registry.subscribe.bind(registry);
    let capturedRegistryUnsubscribe: (() => void) | null = null;
    vi.spyOn(registry, "subscribe").mockImplementation((listener) => {
      const real = originalRegistrySubscribe(listener);
      const wrapped = vi.fn(real);
      capturedRegistryUnsubscribe = wrapped;
      return wrapped;
    });

    const originalHandleSubscribe = handle.store.subscribe.bind(handle.store);
    let capturedHandleUnsubscribe: (() => void) | null = null;
    vi.spyOn(handle.store, "subscribe").mockImplementation((listener) => {
      const real = originalHandleSubscribe(listener);
      const wrapped = vi.fn(real);
      capturedHandleUnsubscribe = wrapped;
      return wrapped;
    });

    const { unmount } = renderHook(() => useWarmChatBackground());
    expect(capturedRegistryUnsubscribe).not.toBeNull();
    expect(capturedHandleUnsubscribe).not.toBeNull();

    unmount();

    expect(capturedRegistryUnsubscribe).toHaveBeenCalledTimes(1);
    expect(capturedHandleUnsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps a fixed hook count as the warm set grows and shrinks - no React hook-order warning", () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
      /* silence expected-clean output; assertions below check it directly */
    });

    function Probe(): null {
      // A fixed budget of OTHER hooks alongside the one under test - if
      // `useWarmChatBackground` ever called a hook per warm chat, this
      // component's total hook count would change between renders and React
      // would log the "Rendered more/fewer hooks" error to `console.error`.
      const [tick, setTick] = useState(0);
      const warmChats = useWarmChatBackground();
      const summary = useMemo(
        () => `${tick}:${warmChats.length}`,
        [tick, warmChats.length],
      );
      void setTick;
      void summary;
      return null;
    }

    const { rerender } = render(<Probe />);

    let chat1Handle: ChatSessionStoreHandle | null = null;
    act(() => {
      chat1Handle = registerChatSession("chat-1", {
        managedCommands: [runningCommand("c1")],
      });
    });
    rerender(<Probe />);

    act(() => {
      registerChatSession("chat-2", {
        managedCommands: [runningCommand("c2")],
      });
      registerChatSession("chat-3", {
        managedCommands: [runningCommand("c3")],
      });
    });
    rerender(<Probe />);

    act(() => {
      if (chat1Handle !== null) {
        __getChatSessionRegistryForTests().releaseHandle(
          EPIC_ID,
          "chat-1",
          HOST_ID,
          chat1Handle,
        );
      }
    });
    rerender(<Probe />);

    const hookOrderWarning = consoleError.mock.calls.some((call) =>
      call.some(
        (arg) => typeof arg === "string" && arg.includes("Rendered more"),
      ),
    );
    expect(hookOrderWarning).toBe(false);
  });
});
