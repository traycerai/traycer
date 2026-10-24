/**
 * The reach mark on the Agents tree's rows.
 *
 * THE PROOF: the mark renders from `reach` alone, never from connectivity. A
 * host the viewer's principal cannot work with is a fact about OWNERSHIP,
 * served by the task's host list (`TaskHostRow.reach`); an offline host is a
 * fact about the MACHINE, and it already has its own lock. The two are
 * independent in both directions, and every row case below pins both halves: a
 * reachable-but-foreign owner shows the mark and no lock, an offline-but-own
 * owner shows the lock and no mark.
 *
 * The local-row cases use the real `ChatTreePanelBody` over a real epic store
 * (`openStoreForTest`, the harness `sidebar-chat-row-node-churn.test.tsx`
 * proves), with exactly three seams replaced: the task's hosts view, host
 * reachability and the agent hover card (replaced by a stand-in that renders
 * `extraContent` inline, because the real card opens on hover only).
 */
import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
  within,
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { AgentReach } from "@traycer/protocol/host/agent/shared";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import {
  otherPrincipalHostIds,
  TASK_HOST_UNREACHABLE_LINE,
} from "@/components/epic-canvas/sidebar/task-host-groups-model";
import {
  AgentReachHoverLine,
  AgentReachMark,
} from "@/components/epic-canvas/sidebar/agent-reach-mark";
import { EpicSidebarCloudChatRow } from "@/components/epic-canvas/sidebar/epic-sidebar-cloud-chat-row";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  TaskHostReachContext,
  useOwnerHostNotReachable,
} from "@/hooks/epic/use-task-host-reach";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import type {
  HostReachability,
  HostReachabilityStatus,
} from "@/hooks/agent/use-host-reachability";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

/** What the test says about each host the rows live on. */
const hostState = vi.hoisted(() => {
  // Annotated, not inferred: an inferred `{ kind: "none" }` widens `kind` to
  // `string`, which no `TaskHostsView` arm accepts.
  const view: { current: TaskHostsView } = { current: { kind: "none" } };
  return {
    reachability: new Map<string, "reachable" | "unreachable">(),
    view,
  };
});

vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (hostId: string): HostReachability => {
      const status: HostReachabilityStatus =
        hostState.reachability.get(hostId) ?? "reachable";
      return {
        status,
        hostLabel: hostId,
        unavailability: null,
        basis: "directory",
        hostKind: "unknown",
      };
    },
  };
});

// The three seams `sidebar-chat-row-node-churn` stubs because each throws
// outside a `<HostRuntimeProvider>`, which this suite does not stand up: the
// per-host client (a null client disables the queries beneath it), a row's
// owner PR references, and the notification indicator query.
vi.mock("@/hooks/host/use-host-client-for-host-id", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-client-for-host-id")
    >();
  return { ...actual, useHostClientForHostId: () => null };
});

const OWNER_PR_REFERENCES = vi.hoisted(() =>
  Object.freeze({
    references: [],
    isPending: false,
    error: false,
    sendRefresh: () => undefined,
  }),
);
vi.mock("@/hooks/pr/use-owner-pr-references", () => ({
  useOwnerListPrReferences: () => OWNER_PR_REFERENCES,
}));

vi.mock(
  "@/hooks/notifications/use-host-notification-indicators-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/notifications/use-host-notification-indicators-query")
      >();
    const { EMPTY_INDICATOR_STATE_RESPONSE } =
      await import("@/stores/notifications/notification-indicator-state");
    const frozen = {
      data: EMPTY_INDICATOR_STATE_RESPONSE,
      isPending: false,
      isFetching: false,
      error: null,
      refetch: (): Promise<void> => Promise.resolve(),
    } as const;
    return { ...actual, useHostNotificationIndicators: () => frozen };
  },
);

vi.mock("@/hooks/epic/use-task-hosts-view", () => ({
  useTaskHostsView: (): TaskHostsView => hostState.view.current,
}));

// The real card opens on hover only; this one puts `extraContent` where a
// test can read it, per node.
vi.mock("@/components/epic-canvas/sidebar/agent-hover-tooltip", () => ({
  AgentHoverTooltip: (props: {
    readonly trigger: ReactElement;
    readonly nodeId: string;
    readonly extraContent: ReactElement | null;
  }): ReactNode => (
    <div>
      {props.trigger}
      <div data-testid={`hover-extra-${props.nodeId}`}>
        {props.extraContent}
      </div>
    </div>
  ),
}));

const EPIC_ID = "epic-agent-reach-mark";
const TAB_ID = "tab-agent-reach-mark";
const USER_ID = "user-1";

const VIEWER: TaskHostPrincipal = { kind: "user", id: USER_ID };
const TEAM: TaskHostPrincipal = { kind: "team", id: "team-acme" };

function hostRow(
  hostId: string,
  reach: AgentReach,
  principal: TaskHostPrincipal,
): TaskHostRow {
  return { hostId, label: null, principal, reach };
}

function hostsView(hosts: readonly TaskHostRow[]): TaskHostsView {
  return { kind: "hosts", hosts };
}

afterEach(() => {
  cleanup();
  hostState.reachability.clear();
  hostState.view.current = { kind: "none" };
});

describe("otherPrincipalHostIds", () => {
  it("is exactly the hosts whose reach is other_principal", () => {
    const ids = otherPrincipalHostIds([
      hostRow("h-mine", "same_principal", VIEWER),
      hostRow("h-team", "other_principal", TEAM),
      hostRow("h-theirs", "other_principal", { kind: "user", id: "user-2" }),
      hostRow("h-mine-2", "same_principal", VIEWER),
    ]);
    expect([...ids].sort()).toEqual(["h-team", "h-theirs"]);
  });

  it("is empty for no hosts and for hosts that all reach", () => {
    expect(otherPrincipalHostIds([]).size).toBe(0);
    expect(
      otherPrincipalHostIds([hostRow("h-mine", "same_principal", VIEWER)]).size,
    ).toBe(0);
  });
});

describe("useOwnerHostNotReachable", () => {
  function renderOwnerHook(
    ownerHostId: string | null,
    provided: ReadonlySet<string> | null,
  ): boolean {
    const { result } = renderHook(() => useOwnerHostNotReachable(ownerHostId), {
      wrapper: (props: { readonly children: ReactNode }) =>
        provided === null ? (
          props.children
        ) : (
          <TaskHostReachContext.Provider value={provided}>
            {props.children}
          </TaskHostReachContext.Provider>
        ),
    });
    return result.current;
  }

  it("is false for a row with no owner host, whatever the set holds", () => {
    expect(renderOwnerHook(null, new Set(["h-1"]))).toBe(false);
  });

  it("is true for a member of the provided set", () => {
    expect(renderOwnerHook("h-1", new Set(["h-1", "h-2"]))).toBe(true);
  });

  it("is false for a host the set does not name", () => {
    expect(renderOwnerHook("h-3", new Set(["h-1", "h-2"]))).toBe(false);
  });

  it("is false with no provider: the default is the empty set", () => {
    expect(renderOwnerHook("h-1", null)).toBe(false);
  });
});

describe("AgentReachHoverLine", () => {
  it("renders the line, verbatim, under its own test id", () => {
    render(<AgentReachHoverLine />);
    expect(screen.getByTestId("agent-hover-reach-line").textContent).toBe(
      AGENT_REACH_LINE,
    );
  });
});

describe("AgentReachMark", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is an aria-hidden icon under the given test id", () => {
    render(
      <TooltipProvider>
        <AgentReachMark testId="the-mark" side="right" align={undefined} />
      </TooltipProvider>,
    );
    expect(screen.getByTestId("the-mark").getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("says the line in its tooltip", async () => {
    const user = userEvent.setup({
      delay: null,
      advanceTimers: vi.advanceTimersByTimeAsync,
    });
    render(
      <TooltipProvider delayDuration={150}>
        <AgentReachMark testId="the-mark" side="top" align="start" />
      </TooltipProvider>,
    );
    const mark = screen.getByTestId("the-mark");

    // The hover starts before the timers advance: `user.hover`'s own `act`
    // waits on the pending open timer (the idiom of
    // `lazy-sidebar-tooltip-wrapper.test.tsx`). The empty advance lands the
    // lazy mount, if the mark uses one, before Radix's delay starts counting.
    const hovered = user.hover(mark);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(155);
    });
    await hovered;

    const texts = screen
      .queryAllByRole("tooltip")
      .map((element) => element.textContent);
    expect(texts).toContain(AGENT_REACH_LINE);
  });
});

const CLOUD_CHAT: CloudChatSummary = {
  identity: {
    taskId: "d60781ca-e0d3-4318-bf2a-e03d8ce4e3a7",
    chatId: "56254cae-aa80-4d06-914c-5086cdd65e3c",
    ownerUserId: "user-2",
  },
  ownerHostId: "host-owner",
  createdAt: 100,
  visibility: "task",
  title: "Reviewer",
  isTitleEditedByUser: false,
  parentChatId: null,
  isArchived: false,
  runSettingsSummary: null,
  metadataUpdatedAt: 300,
  headSha256: null,
  publishedAt: 300,
  throughRecordSeq: null,
  isOwnedByViewer: false,
};

const CLOUD_CHAT_ID = CLOUD_CHAT.identity.chatId;
const CLOUD_ROW_TESTID = `epic-sidebar-cloud-item-${CLOUD_CHAT_ID}`;
const CLOUD_REACH_TESTID = `epic-sidebar-cloud-reach-${CLOUD_CHAT_ID}`;
const CLOUD_LOCK_TESTID = `epic-sidebar-cloud-lock-${CLOUD_CHAT_ID}`;
const AGENT_REACH_LINE =
  "Agents here cannot work with the agents on your hosts; the task still shares its files and chats.";

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Agent reach mark",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "user",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: "AA==",
  };
}

/** Local chats by id, each on the host its row is owned by. */
const LOCAL_CHAT_HOSTS: ReadonlyMap<string, string> = new Map([
  ["chat-foreign", "host-foreign"],
  ["chat-offline", "host-offline"],
  ["chat-both", "host-both"],
  ["chat-plain", "host-plain"],
]);

function chatEntry(id: string, hostId: string): Y.Map<unknown> {
  const entry = new Y.Map<unknown>();
  entry.set("id", id);
  entry.set("title", `Chat ${id}`);
  entry.set("parentId", null);
  entry.set("createdAt", 1);
  entry.set("updatedAt", 1);
  entry.set("userId", USER_ID);
  entry.set("hostId", hostId);
  entry.set("archivedAt", null);
  entry.set("messages", new Y.Array<unknown>());
  return entry;
}

function seedDoc(): Uint8Array {
  const donor = new Y.Doc();
  const epic = donor.getMap<unknown>("epic");
  const chats = new Y.Map<unknown>();
  for (const [id, hostId] of LOCAL_CHAT_HOSTS) {
    chats.set(id, chatEntry(id, hostId));
  }
  epic.set("title", "Agent reach mark");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

function createSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: USER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), seedDoc());
  return handle;
}

const opened: OpenedStoreForTest[] = [];

afterEach(() => {
  for (const handle of opened.splice(0)) handle.dispose();
});

function renderUnderSession(children: ReactNode): void {
  const session = createSession();
  opened.push(session);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <EpicSessionContext.Provider value={session}>
          {children}
        </EpicSessionContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderCloudRow(
  ownerHostId: string,
  reachSet: ReadonlySet<string> | null,
): void {
  const row = (
    <EpicSidebarCloudChatRow
      chat={{ ...CLOUD_CHAT, ownerHostId }}
      childEntries={[]}
      expansion={{
        expandedIds: new Set<string>(),
        toggleExpanded: () => undefined,
      }}
      tabId={TAB_ID}
      depth={0}
      selectionMode={false}
    />
  );
  renderUnderSession(
    reachSet === null ? (
      row
    ) : (
      <TaskHostReachContext.Provider value={reachSet}>
        {row}
      </TaskHostReachContext.Provider>
    ),
  );
}

function cloudRowLabel(): string {
  return screen.getByTestId(CLOUD_ROW_TESTID).getAttribute("aria-label") ?? "";
}

describe("EpicSidebarCloudChatRow: the reach mark comes from reach alone", () => {
  it("marks a foreign owner's row even though its host is reachable, with no lock", () => {
    hostState.reachability.set("host-owner", "reachable");
    renderCloudRow("host-owner", new Set(["host-owner"]));

    expect(screen.getByTestId(CLOUD_REACH_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(CLOUD_LOCK_TESTID)).toBeNull();
    expect(cloudRowLabel()).toContain(TASK_HOST_UNREACHABLE_LINE);
  });

  it("locks an offline owner's row without marking it when the owner is the viewer's own principal", () => {
    hostState.reachability.set("host-owner", "unreachable");
    renderCloudRow("host-owner", new Set(["some-other-host"]));

    expect(screen.getByTestId(CLOUD_LOCK_TESTID)).toBeTruthy();
    expect(screen.queryByTestId(CLOUD_REACH_TESTID)).toBeNull();
    expect(cloudRowLabel()).not.toContain(TASK_HOST_UNREACHABLE_LINE);
  });

  it("carries both when the owner is foreign and offline: the two are independent", () => {
    hostState.reachability.set("host-owner", "unreachable");
    renderCloudRow("host-owner", new Set(["host-owner"]));

    expect(screen.getByTestId(CLOUD_REACH_TESTID)).toBeTruthy();
    expect(screen.getByTestId(CLOUD_LOCK_TESTID)).toBeTruthy();
    expect(cloudRowLabel()).toContain(TASK_HOST_UNREACHABLE_LINE);
    expect(cloudRowLabel()).toContain("offline");
  });

  it("carries no mark when no host list was provided", () => {
    hostState.reachability.set("host-owner", "reachable");
    renderCloudRow("host-owner", null);

    expect(screen.queryByTestId(CLOUD_REACH_TESTID)).toBeNull();
    expect(cloudRowLabel()).not.toContain(TASK_HOST_UNREACHABLE_LINE);
  });

  it("keeps a plain reachable row's accessible name to its title", () => {
    hostState.reachability.set("host-owner", "reachable");
    renderCloudRow("host-owner", new Set<string>());

    expect(cloudRowLabel()).toBe("Reviewer");
  });
});

function renderLocalPanel(): void {
  renderUnderSession(
    <ChatTreePanelBody
      epicId={EPIC_ID}
      tabId={TAB_ID}
      messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
    />,
  );
}

function localRowLabel(nodeId: string): string {
  return (
    screen
      .getByTestId(`epic-sidebar-item-${nodeId}`)
      .getAttribute("aria-label") ?? ""
  );
}

function localHoverExtra(nodeId: string): HTMLElement {
  return screen.getByTestId(`hover-extra-${nodeId}`);
}

describe("the Agents tree's local rows: the reach mark comes from reach alone", () => {
  it("marks a row whose owner host is other_principal and reachable, in its name and its hover card, with no lock", () => {
    hostState.view.current = hostsView([
      hostRow("host-foreign", "other_principal", TEAM),
      hostRow("host-plain", "same_principal", VIEWER),
    ]);
    hostState.reachability.set("host-foreign", "reachable");
    hostState.reachability.set("host-plain", "reachable");
    renderLocalPanel();

    expect(
      screen.getByTestId("epic-sidebar-tree-reach-chat-foreign"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("epic-sidebar-tree-lock-chat-foreign"),
    ).toBeNull();
    expect(localRowLabel("chat-foreign")).toContain(TASK_HOST_UNREACHABLE_LINE);
    expect(
      within(localHoverExtra("chat-foreign")).getByTestId(
        "agent-hover-reach-line",
      ).textContent,
    ).toBe(AGENT_REACH_LINE);
  });

  it("leaves a row on the viewer's own principal unmarked, with no hover line", () => {
    hostState.view.current = hostsView([
      hostRow("host-foreign", "other_principal", TEAM),
      hostRow("host-plain", "same_principal", VIEWER),
    ]);
    hostState.reachability.set("host-foreign", "reachable");
    hostState.reachability.set("host-plain", "reachable");
    renderLocalPanel();

    expect(
      screen.queryByTestId("epic-sidebar-tree-reach-chat-plain"),
    ).toBeNull();
    expect(localRowLabel("chat-plain")).not.toContain(
      TASK_HOST_UNREACHABLE_LINE,
    );
    expect(
      within(localHoverExtra("chat-plain")).queryByTestId(
        "agent-hover-reach-line",
      ),
    ).toBeNull();
  });

  it("locks an offline same-principal owner's row without marking it", () => {
    hostState.view.current = hostsView([
      hostRow("host-offline", "same_principal", VIEWER),
      hostRow("host-foreign", "other_principal", TEAM),
    ]);
    hostState.reachability.set("host-offline", "unreachable");
    renderLocalPanel();

    expect(
      screen.getByTestId("epic-sidebar-tree-lock-chat-offline"),
    ).toBeTruthy();
    expect(
      screen.queryByTestId("epic-sidebar-tree-reach-chat-offline"),
    ).toBeNull();
    expect(localRowLabel("chat-offline")).not.toContain(
      TASK_HOST_UNREACHABLE_LINE,
    );
    expect(
      within(localHoverExtra("chat-offline")).queryByTestId(
        "agent-hover-reach-line",
      ),
    ).toBeNull();
  });

  it("carries both on a foreign, offline owner's row", () => {
    hostState.view.current = hostsView([
      hostRow("host-both", "other_principal", TEAM),
    ]);
    hostState.reachability.set("host-both", "unreachable");
    renderLocalPanel();

    expect(
      screen.getByTestId("epic-sidebar-tree-reach-chat-both"),
    ).toBeTruthy();
    expect(screen.getByTestId("epic-sidebar-tree-lock-chat-both")).toBeTruthy();
    expect(localRowLabel("chat-both")).toContain(TASK_HOST_UNREACHABLE_LINE);
  });

  it("marks nothing when the task's hosts view is none", () => {
    hostState.view.current = { kind: "none" };
    hostState.reachability.set("host-foreign", "reachable");
    renderLocalPanel();

    for (const nodeId of LOCAL_CHAT_HOSTS.keys()) {
      expect(
        screen.queryByTestId(`epic-sidebar-tree-reach-${nodeId}`),
      ).toBeNull();
      expect(localRowLabel(nodeId)).not.toContain(TASK_HOST_UNREACHABLE_LINE);
    }
  });

  it("marks nothing when the task's hosts view is a retryable error", () => {
    hostState.view.current = { kind: "error", retry: () => undefined };
    hostState.reachability.set("host-foreign", "reachable");
    renderLocalPanel();

    // The panel did render its rows, so the absence below is not vacuous.
    expect(screen.getByTestId("epic-sidebar-item-chat-foreign")).toBeTruthy();
    for (const nodeId of LOCAL_CHAT_HOSTS.keys()) {
      expect(
        screen.queryByTestId(`epic-sidebar-tree-reach-${nodeId}`),
      ).toBeNull();
    }
  });
});
