import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  FocusBackgroundRow,
  FocusBrowserRow,
} from "@/lib/home-focus/focus-model";
import type { NotificationActivationOutcome } from "@/hooks/notifications/use-notification-activation";
import type { FocusStopAgentInput } from "@/hooks/home-focus/use-focus-actions";
import type { ManagedCommandLifecycleVariables } from "@/hooks/managed-command/use-managed-command-lifecycle-mutations";
import {
  makeApprovalPayload,
  makeFocusBackgroundChat,
  makeManagedCommand,
  makeMergedNotificationRow,
  makeRunningBackgroundItem,
} from "@/lib/home-focus/__tests__/fixtures";
import { buildFocusBackground } from "@/lib/home-focus/focus-background";
import { useFocusActions } from "@/hooks/home-focus/use-focus-actions";

const {
  navigateMock,
  routeNotificationForHostMock,
  activateMock,
  markAsReadMock,
  stopAgentMutateMock,
  stopManagedCommandMutateMock,
} = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  routeNotificationForHostMock: vi.fn(() => true),
  activateMock: vi.fn(),
  markAsReadMock: vi.fn(),
  // Typed against the exact two-argument shape `useFocusActions` calls -
  // `mutate(variables, { onSettled })` - never optional: every real call site
  // in the hook passes both.
  stopAgentMutateMock: vi.fn(
    (_variables: FocusStopAgentInput, _options: { onSettled: () => void }) =>
      undefined,
  ),
  stopManagedCommandMutateMock: vi.fn(
    (
      _variables: ManagedCommandLifecycleVariables,
      _options: { onSettled: () => void },
    ) => undefined,
  ),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("@/lib/notifications", () => ({
  routeNotificationForHost: routeNotificationForHostMock,
}));

vi.mock("@/hooks/notifications/use-notification-activation", () => ({
  useNotificationActivation: () => ({ activate: activateMock }),
}));

vi.mock("@/stores/notifications/merged-notifications", () => ({
  useMergedNotificationsActions: () => ({
    markAsRead: markAsReadMock,
    clear: vi.fn(),
    clearAll: vi.fn(),
    markAllAsRead: vi.fn(),
    markEntityAsRead: vi.fn(),
    loadMoreHost: vi.fn(),
    canLoadMoreHost: false,
    isLoadingMoreHost: false,
    hasHostLoadError: false,
    loadMoreAttention: vi.fn(),
    canLoadMoreAttention: false,
    isLoadingMoreAttention: false,
    hasAttentionLoadError: false,
    loadMoreUnreadRecent: vi.fn(),
    canLoadMoreUnreadRecent: false,
    isLoadingMoreUnreadRecent: false,
    hasUnreadRecentLoadError: false,
  }),
}));

vi.mock("@/hooks/home-focus/use-focus-stop-agent-mutation", () => ({
  useFocusStopAgent: () => ({ mutate: stopAgentMutateMock }),
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => "effective-host-1",
}));

vi.mock(
  "@/hooks/managed-command/use-managed-command-lifecycle-mutations",
  () => ({
    useManagedCommandStop: () => ({ mutate: stopManagedCommandMutateMock }),
  }),
);

beforeEach(() => {
  navigateMock.mockClear();
  routeNotificationForHostMock.mockClear();
  activateMock.mockClear();
  markAsReadMock.mockClear();
  stopAgentMutateMock.mockClear();
  stopManagedCommandMutateMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

function renderActions() {
  return renderHook(() => useFocusActions()).result;
}

/** A managed-command row built through the real builder, so its `key`
 * carries a genuine parseable address rather than a hand-typed literal. */
function managedCommandRow(
  overrides: Partial<{ hostId: string | null; commandId: string }>,
): FocusBackgroundRow {
  const chat = makeFocusBackgroundChat({
    epicId: "epic-1",
    chatId: "chat-1",
    hostId: overrides.hostId === undefined ? "host-1" : overrides.hostId,
    managedCommands: [
      makeManagedCommand({ id: overrides.commandId ?? "cmd-1" }),
    ],
  });
  const [row] = buildFocusBackground([chat], []);
  return row;
}

function backgroundItemRow(): FocusBackgroundRow {
  const chat = makeFocusBackgroundChat({
    epicId: "epic-2",
    chatId: "chat-2",
    backgroundItems: [
      makeRunningBackgroundItem({ taskId: "task-1", title: "Subagent" }),
    ],
  });
  const [row] = buildFocusBackground([chat], []);
  return row;
}

describe("useFocusActions", () => {
  describe("stopAgent", () => {
    it("calls the focus-stop mutate with exactly the input object as its first argument", () => {
      const result = renderActions();

      act(() => {
        result.current.stopAgent({
          hostId: "host-b",
          epicId: "epic-1",
          agentId: "agent-1",
          cascade: true,
        });
      });

      expect(stopAgentMutateMock).toHaveBeenCalledExactlyOnceWith(
        {
          hostId: "host-b",
          epicId: "epic-1",
          agentId: "agent-1",
          cascade: true,
        },
        expect.anything(),
      );
    });

    it("sends hostId: null through unchanged when null is passed", () => {
      const result = renderActions();

      act(() => {
        result.current.stopAgent({
          hostId: null,
          epicId: "epic-1",
          agentId: "agent-1",
          cascade: false,
        });
      });

      expect(stopAgentMutateMock).toHaveBeenCalledExactlyOnceWith(
        { hostId: null, epicId: "epic-1", agentId: "agent-1", cascade: false },
        expect.anything(),
      );
    });
  });

  describe("stopManagedCommand", () => {
    it("calls the managed-command mutate with {hostId, epicId, commandId} parsed from the row key", () => {
      const row = managedCommandRow({ hostId: "host-1", commandId: "cmd-1" });
      const result = renderActions();

      act(() => {
        result.current.stopManagedCommand(row);
      });

      expect(stopManagedCommandMutateMock).toHaveBeenCalledExactlyOnceWith(
        { hostId: "host-1", epicId: "epic-1", commandId: "cmd-1" },
        expect.anything(),
      );
    });

    it("is a no-op for a stoppable: false row", () => {
      const row = managedCommandRow({ hostId: null });
      expect(row.stoppable).toBe(false);
      const result = renderActions();

      result.current.stopManagedCommand(row);

      expect(stopManagedCommandMutateMock).not.toHaveBeenCalled();
    });

    it("is a no-op for a background-item row", () => {
      const row = backgroundItemRow();
      expect(row.kind).toBe("background-item");
      const result = renderActions();

      result.current.stopManagedCommand(row);

      expect(stopManagedCommandMutateMock).not.toHaveBeenCalled();
    });
  });

  describe("stopping", () => {
    it("starts empty, contains the agent id between stopAgent(...) and the settle, and empties again once it settles - whether the mutation succeeded or failed", () => {
      const result = renderActions();
      expect(result.current.stopping.size).toBe(0);

      act(() => {
        result.current.stopAgent({
          hostId: "host-b",
          epicId: "epic-1",
          agentId: "agent-1",
          cascade: true,
        });
      });

      expect(result.current.stopping.has("agent-1")).toBe(true);

      const [, options] = stopAgentMutateMock.mock.calls[0];
      // `onSettled` is the ONLY callback `useFocusActions` passes - react-query
      // fires it identically on success and on failure, so invoking it here is
      // evidence that `stopping` clears in BOTH cases, not just the happy path.
      act(() => {
        options.onSettled();
      });

      expect(result.current.stopping.has("agent-1")).toBe(false);
    });

    it("tracks a managed-command stop keyed by the ROW KEY - FocusBackgroundRow exposes no command id, so the key is what a renderer looks itself up by", () => {
      const row = managedCommandRow({ hostId: "host-1", commandId: "cmd-1" });
      const result = renderActions();
      expect(result.current.stopping.size).toBe(0);

      act(() => {
        result.current.stopManagedCommand(row);
      });

      expect(result.current.stopping.has(row.key)).toBe(true);
      // Confirms it is the KEY, not the parsed command id, that is tracked.
      expect(row.key).not.toBe("cmd-1");

      const [, options] = stopManagedCommandMutateMock.mock.calls[0];
      // Same as the agent case: `onSettled` fires identically on success and
      // failure, so this is evidence `stopping` clears in both cases.
      act(() => {
        options.onSettled();
      });

      expect(result.current.stopping.has(row.key)).toBe(false);
    });
  });

  it("openAgent(epicId, agentId) routes with a {kind: chat, epicId, chatId: agentId} payload, chatId equal to the agent id", () => {
    const result = renderActions();

    result.current.openAgent("epic-1", "agent-1");

    expect(routeNotificationForHostMock).toHaveBeenCalledExactlyOnceWith(
      navigateMock,
      { kind: "chat", epicId: "epic-1", chatId: "agent-1" },
      expect.any(Number),
      { originHostId: null, effectiveHostId: "effective-host-1" },
    );
  });

  it("openTask(epicId) routes with a {kind: epic, epicId} payload", () => {
    const result = renderActions();

    result.current.openTask("epic-1");

    expect(routeNotificationForHostMock).toHaveBeenCalledExactlyOnceWith(
      navigateMock,
      { kind: "epic", epicId: "epic-1" },
      expect.any(Number),
      { originHostId: null, effectiveHostId: "effective-host-1" },
    );
  });

  describe("openBackground", () => {
    it("routes to the owning chat with {kind: chat, epicId: row.epicId, chatId: row.chatId} for a managed-command row", () => {
      const row = managedCommandRow({});
      const result = renderActions();

      result.current.openBackground(row);

      expect(routeNotificationForHostMock).toHaveBeenCalledExactlyOnceWith(
        navigateMock,
        { kind: "chat", epicId: row.epicId, chatId: row.chatId },
        expect.any(Number),
        { originHostId: null, effectiveHostId: "effective-host-1" },
      );
    });

    it("routes to the owning chat for a background-item row too - it does not depend on stoppable", () => {
      const row = backgroundItemRow();
      expect(row.stoppable).toBe(false);
      const result = renderActions();

      result.current.openBackground(row);

      expect(routeNotificationForHostMock).toHaveBeenCalledExactlyOnceWith(
        navigateMock,
        { kind: "chat", epicId: row.epicId, chatId: row.chatId },
        expect.any(Number),
        { originHostId: null, effectiveHostId: "effective-host-1" },
      );
    });
  });

  describe("openBrowser", () => {
    /** A browser session is host-local for life, so the row carries its host
     * and the route must be told which machine to match a tile on. */
    function browserRow(hostId: string): FocusBrowserRow {
      return {
        key: `${hostId}-session-1-tab-1`,
        epicId: "epic-1",
        taskTitle: "Storefront",
        hostId,
        sessionId: "session-1",
        tabId: "tab-1",
        title: "Checkout",
        urlHost: "shop.example.com",
        url: "https://shop.example.com/checkout",
        status: "live",
        drivenByChatId: null,
        drivenByAgentName: null,
      };
    }

    it("routes to the TAB, not to the task it lives in", () => {
      const result = renderActions();

      result.current.openBrowser(browserRow("host-a"));

      expect(routeNotificationForHostMock).toHaveBeenCalledExactlyOnceWith(
        navigateMock,
        {
          kind: "browserSession",
          epicId: "epic-1",
          sessionId: "session-1",
          tabId: "tab-1",
        },
        expect.any(Number),
        { originHostId: "host-a", effectiveHostId: "effective-host-1" },
      );
    });

    it("passes the row's OWN host as the origin", () => {
      const result = renderActions();

      result.current.openBrowser(browserRow("host-elsewhere"));

      // Without it a same-id tile on another machine would satisfy the match.
      // This is the one action on the page that needs an origin host, and the
      // reason is that a session id names a host-local object.
      expect(routeNotificationForHostMock).toHaveBeenCalledWith(
        navigateMock,
        expect.objectContaining({ kind: "browserSession" }),
        expect.any(Number),
        expect.objectContaining({ originHostId: "host-elsewhere" }),
      );
    });
  });

  describe("openPrompt", () => {
    it("calls activate with the row's payload/feedId/originHostId", () => {
      const payload = makeApprovalPayload("epic-1", "chat-1");
      const activation = makeMergedNotificationRow({
        feedId: "host:approval-1",
        hostKind: "approval.requested",
        severity: "needs_action",
        originHostId: "origin-host-1",
        payload,
      });
      const result = renderActions();

      result.current.openPrompt({
        key: activation.feedId,
        kind: "approval",
        epicId: "epic-1",
        chatId: "chat-1",
        taskTitle: null,
        browserTabTitle: null,
        title: activation.title,
        body: activation.body,
        createdAt: activation.createdAt,
        originHostId: activation.originHostId,
        activation,
      });

      expect(activateMock).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          payload,
          feedId: "host:approval-1",
          originHostId: "origin-host-1",
          // `expect.any` is an `any`-typed matcher; type it as the value it
          // stands in for so the object literal stays free of unsafe `any`.
          receivedAt: expect.any(Number) as number,
          onResult: expect.any(Function) as (
            outcome: NotificationActivationOutcome,
          ) => void,
        }),
      );
    });

    it("is a no-op when row.activation.payload is null", () => {
      const activation = makeMergedNotificationRow({
        feedId: "host:approval-1",
        hostKind: "approval.requested",
        severity: "needs_action",
        payload: null,
      });
      const result = renderActions();

      result.current.openPrompt({
        key: activation.feedId,
        kind: "approval",
        epicId: null,
        chatId: null,
        taskTitle: null,
        browserTabTitle: null,
        title: activation.title,
        body: activation.body,
        createdAt: activation.createdAt,
        originHostId: activation.originHostId,
        activation,
      });

      expect(activateMock).not.toHaveBeenCalled();
    });
  });
});
