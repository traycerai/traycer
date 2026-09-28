/**
 * `StripLiveAgentsPortal` / `StripLiveAgents` (D9): the Activity view's live
 * agents list. The epic's tree comes through `@/hooks/use-epic-store` and
 * `@/lib/epic-selectors`, mocked here the same way the panel's own Agents
 * tree suite (`epic-sidebar-selection-mode.test.tsx`) mocks them - a small
 * fixture tree rather than the full Y.Doc runtime, which this component does
 * not touch directly. What stays REAL: the notification indicator plumbing
 * (`useAppLocalNotificationsStore`, `NotificationIndicatorsContext`,
 * `chatDescendantKind`) and the activity-tier crossing, which is the actual
 * logic this component owns.
 */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostNotificationsIndicatorState } from "@traycer/protocol/host/notifications/contracts";
import { StripLiveAgentsPortal } from "@/components/epic-canvas/sidebar/strip-live-agents";
import { publishLiveAgentsSlot } from "@/components/layout/tabs/side-strip/live-agents-slot-store";
import type { UseHostNotificationIndicatorsArgs } from "@/hooks/notifications/use-host-notification-indicators-query";
import type { AgentActivityTier } from "@/lib/agent-activity";
import type { TileOpenIntent } from "@/lib/canvas/tile-open/intent";
import type { NestedFocusTarget } from "@/lib/epic-nested-focus-route";
import {
  EpicSessionContext,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
} from "@/stores/agent-activity-store";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { TreeNode, TreeSlice } from "@/stores/epics/open-epic/types";
import { useAppLocalNotificationsStore } from "@/stores/notifications/app-local-notifications-store";

const EPIC_ID = "epic-live";
const TAB_ID = "tab-live";
const HOST_ID = "host-live";

interface ChatFixture {
  readonly hostId: string;
  readonly userId: string;
}

const testState = vi.hoisted(() => ({
  tree: {
    rootIds: [],
    childrenByParent: {},
    nodeById: {},
  } as TreeSlice,
  chatById: {} as Record<string, ChatFixture>,
  activityTierById: new Map<string, AgentActivityTier>(),
  hostIndicatorByChatId: new Map<string, HostNotificationsIndicatorState>(),
}));

const openTileSpy = vi.hoisted(() =>
  vi.fn<(intent: TileOpenIntent) => NestedFocusTarget | null>(),
);

// `useOpenEpicHandle` stays REAL: a fixture tree stands in for the Y.Doc
// runtime this component does not touch, but the null-handle throw a brand
// new task's `<EpicSessionProvider>` starts with (G7) is exactly the crash
// this suite's "still opening" cases are about, and only the real hook still
// enforces it.
vi.mock("@/hooks/use-epic-store", async () => {
  const { useOpenEpicHandle } =
    await import("@/providers/use-open-epic-handle");
  return {
    useEpicStore: (selector: (state: { tree: TreeSlice }) => unknown) => {
      useOpenEpicHandle();
      return selector({ tree: testState.tree });
    },
  };
});

function chatFixture(nodeId: string): ChatFixture | null {
  return Object.hasOwn(testState.chatById, nodeId)
    ? testState.chatById[nodeId]
    : null;
}

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTreeIndex: () => testState.tree,
  useEpicAgentActivityTiers: () => testState.activityTierById,
  useEpicNodeHostId: (nodeId: string) => chatFixture(nodeId)?.hostId ?? null,
  useEpicNodeHostIds: (nodeIds: ReadonlyArray<string>) =>
    nodeIds.map((nodeId) => chatFixture(nodeId)?.hostId ?? null),
  useEpicNodeOwnerUserId: (nodeId: string) =>
    chatFixture(nodeId)?.userId ?? null,
  useEpicNodeUpdatedAt: (nodeId: string) =>
    Object.hasOwn(testState.tree.nodeById, nodeId)
      ? testState.tree.nodeById[nodeId].updatedAt
      : 0,
}));

vi.mock("@/hooks/epic/use-epic-tile-navigation", () => ({
  useEpicTileNavigation: () => ({ openTile: openTileSpy }),
}));

vi.mock("@/components/epic-canvas/sidebar/use-chat-row-open-ref", () => ({
  useChatRowOpenRef: (args: { readonly nodeId: string }) => () => ({
    id: args.nodeId,
    instanceId: `instance-${args.nodeId}`,
    type: "chat",
    name: args.nodeId,
    hostId: HOST_ID,
  }),
}));

// `ChatIndicatorHostScopes` asks each chat's host for its indicator state
// through a real host RPC query; this suite is about the tree/activity/local-
// failure crossing, not the host indicator wire, so each host answers from
// `testState.hostIndicatorByChatId` (empty by default) instead of a live RPC.
vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-host-notification-indicators-query")
      >();
    return {
      ...actual,
      useHostNotificationIndicators: (
        args: Pick<UseHostNotificationIndicatorsArgs, "chatIds">,
      ) => ({
        data: {
          epics: {},
          chats: Object.fromEntries(
            args.chatIds.flatMap((chatId) => {
              const state = testState.hostIndicatorByChatId.get(chatId);
              return state === undefined ? [] : [[chatId, state] as const];
            }),
          ),
        },
      }),
    };
  },
);

function chatNode(
  id: string,
  parentId: string | null,
  updatedAt: number,
): TreeNode {
  return {
    id,
    parentId,
    title: `Agent ${id}`,
    type: "chat",
    status: null,
    createdAt: 1,
    updatedAt,
  };
}

/** A flat tree of chats, root-ordered as given. Children nest under `parentId`. */
function setTree(nodes: ReadonlyArray<TreeNode>): void {
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const node of nodes) {
    nodeById[node.id] = node;
    if (node.parentId === null) {
      rootIds.push(node.id);
    } else {
      (childrenByParent[node.parentId] ??= []).push(node.id);
    }
    testState.chatById[node.id] = { hostId: HOST_ID, userId: "user-1" };
  }
  testState.tree = { rootIds, childrenByParent, nodeById };
}

function handle(): OpenEpicStoreHandle {
  const value = {} as OpenEpicStoreHandle;
  handleHostIds.set(value, HOST_ID);
  return value;
}

function renderPortal() {
  return render(
    <EpicSessionContext value={handle()}>
      <StripLiveAgentsPortal epicId={EPIC_ID} tabId={TAB_ID} />
    </EpicSessionContext>,
  );
}

function seedLocalFailure(chatId: string): void {
  const notifications = useAppLocalNotificationsStore.getState();
  if (notifications.activeUserId === null) {
    notifications.activateIdentity("test-user");
  }
  useAppLocalNotificationsStore.getState().upsert({
    id: `local-failure:${chatId}`,
    originHostId: HOST_ID,
    updatedAt: Date.now(),
    readAt: null,
    kind: "host.error",
    sourceRef: null,
    payload: { kind: "chat", epicId: EPIC_ID, chatId },
    message: "Test non-terminal failure",
    detail: null,
  });
}

function clearLocalFailure(chatId: string): void {
  useAppLocalNotificationsStore
    .getState()
    .markEntityAsRead(HOST_ID, { epicId: EPIC_ID, chatId }, Date.now());
}

/**
 * An unread TERMINAL failure - a closed/crashed run the feed still carries as
 * history. Unlike {@link seedLocalFailure}'s non-terminal failure, this alone
 * does not raise `attentionTone`; it only reaches a row through
 * `terminalFailureTone` / `chatDescendantKind`'s dedicated fallback.
 */
function seedTerminalFailure(chatId: string): void {
  const notifications = useAppLocalNotificationsStore.getState();
  if (notifications.activeUserId === null) {
    notifications.activateIdentity("test-user");
  }
  useAppLocalNotificationsStore.getState().upsert({
    id: `terminal-failure:${chatId}`,
    originHostId: HOST_ID,
    updatedAt: Date.now(),
    readAt: null,
    kind: "terminal.closed",
    sourceRef: null,
    payload: { kind: "chat", epicId: EPIC_ID, chatId },
    message: "Test terminal failure",
    detail: null,
  });
}

function seedHostIndicator(
  chatId: string,
  overrides: Partial<HostNotificationsIndicatorState>,
): void {
  testState.hostIndicatorByChatId.set(chatId, {
    pendingApproval: false,
    pendingInterview: false,
    pendingFork: false,
    unreadFailure: false,
    unreadDone: false,
    ...overrides,
  });
}

beforeEach(() => {
  testState.tree = { rootIds: [], childrenByParent: {}, nodeById: {} };
  testState.chatById = {};
  testState.activityTierById = new Map();
  testState.hostIndicatorByChatId = new Map();
  openTileSpy.mockClear();
});

afterEach(() => {
  cleanup();
  useAppLocalNotificationsStore.getState().resetForTests();
  __resetAgentActivityStoreForTests();
});

describe("<StripLiveAgentsPortal />", () => {
  it("renders nothing while the strip has published no slot", () => {
    setTree([chatNode("chat-a", null, 100)]);
    testState.activityTierById.set("chat-a", "turn");

    renderPortal();

    expect(screen.queryByTestId("strip-live-agents")).toBeNull();
  });

  it("lists only running, background and unread-failed agents, excluding idle ones", () => {
    setTree([
      chatNode("chat-running", null, 100),
      chatNode("chat-background", null, 100),
      chatNode("chat-failed", null, 100),
      chatNode("chat-idle", null, 100),
    ]);
    testState.activityTierById.set("chat-running", "turn");
    testState.activityTierById.set("chat-background", "background");

    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });
    seedLocalFailure("chat-failed");

    renderPortal();

    const list = screen.getByTestId("strip-live-agents");
    expect(list.querySelectorAll("li")).toHaveLength(3);
    expect(screen.getByTestId("strip-live-agent-chat-running")).toBeTruthy();
    expect(screen.getByTestId("strip-live-agent-chat-background")).toBeTruthy();
    expect(screen.getByTestId("strip-live-agent-chat-failed")).toBeTruthy();
    expect(screen.queryByTestId("strip-live-agent-chat-idle")).toBeNull();
    expect(
      screen.getByTestId("strip-live-agent-chat-running").dataset.liveKind,
    ).toBe("running");
    expect(
      screen.getByTestId("strip-live-agent-chat-background").dataset.liveKind,
    ).toBe("background");
    expect(
      screen.getByTestId("strip-live-agent-chat-failed").dataset.liveKind,
    ).toBe("failure");
    // The tone titles from the notification vocabulary, not the row's own
    // wording - so the Activity list can never drift from the Agents tree.
    expect(
      screen
        .getByTestId("strip-live-agent-chat-running")
        .getAttribute("aria-label"),
    ).toContain("Agent in progress");
    expect(
      screen
        .getByTestId("strip-live-agent-chat-background")
        .getAttribute("aria-label"),
    ).toContain("Background activity — agent idle");
    expect(
      screen
        .getByTestId("strip-live-agent-chat-failed")
        .getAttribute("aria-label"),
    ).toContain("Task needs attention");
  });

  it("renders nothing (not an empty list) when no agent is live", () => {
    setTree([chatNode("chat-idle", null, 100)]);
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();

    expect(screen.queryByTestId("strip-live-agents")).toBeNull();
  });

  it("updates live as an agent starts and stops running", () => {
    setTree([chatNode("chat-a", null, 100)]);
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    const { rerender } = renderPortal();
    expect(screen.queryByTestId("strip-live-agents")).toBeNull();

    testState.activityTierById = new Map([["chat-a", "turn"]]);
    rerender(
      <EpicSessionContext value={handle()}>
        <StripLiveAgentsPortal epicId={EPIC_ID} tabId={TAB_ID} />
      </EpicSessionContext>,
    );
    expect(screen.getByTestId("strip-live-agent-chat-a")).toBeTruthy();

    testState.activityTierById = new Map();
    rerender(
      <EpicSessionContext value={handle()}>
        <StripLiveAgentsPortal epicId={EPIC_ID} tabId={TAB_ID} />
      </EpicSessionContext>,
    );
    expect(screen.queryByTestId("strip-live-agent-chat-a")).toBeNull();
  });

  it("updates live as a local failure is seeded and cleared", () => {
    setTree([chatNode("chat-a", null, 100)]);
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();
    expect(screen.queryByTestId("strip-live-agents")).toBeNull();

    act(() => {
      seedLocalFailure("chat-a");
    });
    expect(screen.getByTestId("strip-live-agent-chat-a").dataset.liveKind).toBe(
      "failure",
    );

    act(() => {
      clearLocalFailure("chat-a");
    });
    expect(screen.queryByTestId("strip-live-agent-chat-a")).toBeNull();
  });

  it("indents a live child under its live parent", () => {
    setTree([chatNode("parent", null, 100), chatNode("child", "parent", 100)]);
    testState.activityTierById.set("parent", "turn");
    testState.activityTierById.set("child", "background");
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();

    const parentRow = screen.getByTestId("strip-live-agent-parent");
    const childRow = screen.getByTestId("strip-live-agent-child");
    const parentIndent = Number.parseInt(
      parentRow.style.paddingInlineStart,
      10,
    );
    const childIndent = Number.parseInt(childRow.style.paddingInlineStart, 10);
    expect(childIndent).toBeGreaterThan(parentIndent);
  });

  it("a live child of an idle parent sits at the parent's own depth", () => {
    setTree([
      chatNode("idle-parent", null, 100),
      chatNode("live-child", "idle-parent", 100),
    ]);
    testState.activityTierById.set("live-child", "turn");
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();

    expect(screen.queryByTestId("strip-live-agent-idle-parent")).toBeNull();
    const childRow = screen.getByTestId("strip-live-agent-live-child");
    // Same base indent a ROOT live row draws at (depth 0): the idle ancestor
    // contributes no indentation of its own.
    expect(childRow.style.paddingInlineStart).toBe("8px");
  });

  it("opens the chat through the tile-open seam on click", () => {
    setTree([chatNode("chat-a", null, 100)]);
    testState.activityTierById.set("chat-a", "turn");
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();
    fireEvent.click(screen.getByTestId("strip-live-agent-chat-a"));

    expect(openTileSpy).toHaveBeenCalledTimes(1);
    const [intent] = openTileSpy.mock.calls[0];
    expect(intent.node.id).toBe("chat-a");
    expect(intent.target).toEqual({ tabId: TAB_ID });
    expect(intent.gesture).toBe("single");
  });

  // A waiting chip (fork/interview/approval) needs the host indicator
  // pipeline's `attentionTone`, whose own kind mapping is already pinned by
  // `chatDescendantKind`'s dedicated suite in
  // `epic-sidebar-selection-mode.test.tsx` ("chat descendant status rollup").
  // What is left to this suite is that a kind with NO chip mapping (running,
  // background) draws the idle time instead - the chip/time branch this
  // component owns.
  it("shows the idle time, not a waiting chip, for a running or background kind", () => {
    setTree([chatNode("chat-a", null, 5_000)]);
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });
    testState.activityTierById.set("chat-a", "turn");

    renderPortal();

    const row = screen.getByTestId("strip-live-agent-chat-a");
    expect(screen.queryByTestId("strip-live-agent-waiting-chip")).toBeNull();
    const idleTime = within(row).getByTestId("chat-row-idle-time");
    expect(idleTime.textContent).not.toBe("");
  });

  it("shows a waiting chip instead of the idle time when the agent needs a reply", () => {
    setTree([chatNode("chat-a", null, 5_000)]);
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });
    testState.activityTierById.set("chat-a", "turn");
    seedHostIndicator("chat-a", { pendingInterview: true });

    renderPortal();

    const row = screen.getByTestId("strip-live-agent-chat-a");
    expect(row.dataset.liveKind).toBe("interview");
    const chip = within(row).getByTestId("strip-live-agent-waiting-chip");
    expect(chip.textContent).toBe("Reply");
    expect(within(row).queryByTestId("chat-row-idle-time")).toBeNull();
  });

  // Finding 2: `chatDescendantKind`'s failure-first order is for a COLLAPSED
  // parent aggregating a distinct failed child. An agent's OWN row must not
  // apply that order to itself - `ownChatStatusKind` lets a newer live turn
  // own the row over its own historical unread terminal failure, matching
  // what the agent's own glyph (`NotificationIndicatorIcon`) already shows.
  it("an agent's own unread terminal failure does not outrank its own live turn", () => {
    setTree([chatNode("chat-a", null, 100)]);
    testState.activityTierById.set("chat-a", "turn");
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();

    act(() => {
      seedTerminalFailure("chat-a");
    });

    expect(screen.getByTestId("strip-live-agent-chat-a").dataset.liveKind).toBe(
      "running",
    );
  });
});

/**
 * Per-agent `AgentActivityCoverage` (F8): each row asks coverage of its OWN
 * host (`selectAgentActivityCoverage`), not the tab's session host, so an
 * agent the activity plane cannot see for its own machine lists as unknown
 * instead of silently vanishing like an idle one does.
 */
describe("<StripLiveAgentsPortal /> per-agent activity coverage", () => {
  it("lists an unserved host's idle agent as unknown, drops a covered host's and a null host's idle agents, and lets attention outrank unknown", () => {
    setTree([
      chatNode("chat-unserved", null, 100),
      chatNode("chat-covered", null, 100),
      chatNode("chat-null-host", null, 100),
      chatNode("chat-attention", null, 100),
    ]);
    // `setTree` puts every node on `HOST_ID` by default; give each row the
    // host this case is actually about.
    testState.chatById["chat-unserved"] = {
      hostId: "host-b",
      userId: "user-1",
    };
    testState.chatById["chat-covered"] = { hostId: "host-a", userId: "user-1" };
    // No fixture at all -> `useEpicNodeHostIds` reads it as a null host, the
    // "registry holds a session with no host yet" case `selectAgentActivityCoverage`
    // documents as staying `indeterminate`.
    delete testState.chatById["chat-null-host"];
    testState.chatById["chat-attention"] = {
      hostId: "host-b",
      userId: "user-1",
    };
    seedHostIndicator("chat-attention", { pendingApproval: true });

    // Only host-a's slice answers and covers itself; the plane answers overall
    // but excludes host-b, which is exactly the `unserved` arm.
    __setHostAgentActivityHealthForTests("host-a", {
      connectionStatus: "open",
      servedBy: "local",
      cloudSyncStatus: null,
      stateFrameSeenThisEpoch: true,
    });

    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    renderPortal();

    const unserved = screen.getByTestId("strip-live-agent-chat-unserved");
    expect(unserved.dataset.liveKind).toBe("unknown");
    expect(unserved.getAttribute("aria-label")).toContain(
      "Agent status unknown",
    );
    expect(screen.queryByTestId("strip-live-agent-chat-covered")).toBeNull();
    expect(screen.queryByTestId("strip-live-agent-chat-null-host")).toBeNull();
    expect(
      screen.getByTestId("strip-live-agent-chat-attention").dataset.liveKind,
    ).toBe("approval");
  });
});

/**
 * G7: a brand new task's `<EpicSessionProvider>` starts with a null handle
 * while the session opens, and `useEpicStore` (used by both `StripLiveAgents`
 * and `LiveAgentRowButton`) throws outside one. `StripLiveAgentsPortal` wraps
 * its content in `<EpicSessionGate fallback={null}>` so the strip's slot
 * renders nothing during that window instead of crashing the window, then
 * shows the list once the session hands the surface a real handle.
 */
describe("<StripLiveAgentsPortal /> while the session is still opening (G7)", () => {
  it("renders nothing and does not throw with a null session handle, then lists once a real handle arrives", () => {
    setTree([chatNode("chat-a", null, 100)]);
    testState.activityTierById.set("chat-a", "turn");
    const slotEl = document.createElement("div");
    document.body.appendChild(slotEl);
    act(() => {
      publishLiveAgentsSlot(TAB_ID, slotEl);
    });

    const { rerender } = render(
      <EpicSessionContext value={null}>
        <StripLiveAgentsPortal epicId={EPIC_ID} tabId={TAB_ID} />
      </EpicSessionContext>,
    );

    expect(screen.queryByTestId("strip-live-agents")).toBeNull();
    expect(screen.queryByTestId("strip-live-agent-chat-a")).toBeNull();

    rerender(
      <EpicSessionContext value={handle()}>
        <StripLiveAgentsPortal epicId={EPIC_ID} tabId={TAB_ID} />
      </EpicSessionContext>,
    );

    expect(screen.getByTestId("strip-live-agent-chat-a")).toBeTruthy();
  });
});
