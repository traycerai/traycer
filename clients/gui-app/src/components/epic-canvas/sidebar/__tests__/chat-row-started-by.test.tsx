/**
 * "Started by <name>" on the hover of a chat's row in the Agents tree.
 *
 * THE PROOF: only a chat held on a TEAM computer names its starter. A personal
 * computer's chat, a chat with no recorded starter and a `"system"` starter
 * say nothing. The team check is the real `useHostOwnerTeamId` over a host
 * directory row; the starter is read from the real epic store's chat records.
 *
 * The rows are the real `ChatTreePanelBody` over a real epic store (the
 * harness `agent-row-reach-mark.test.tsx` proves), with the seams that suite
 * replaces: the task's hosts view, host reachability, the per-host client, the
 * owner PR references, the notification indicators, and the agent hover card
 * (a stand-in that renders `extraContent` inline, because the real card opens
 * on hover only).
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import * as Y from "yjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { remoteEntry } from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import type { HostOwnerPrincipal } from "@traycer/protocol/host/host-status";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type {
  ChatRecordSummaryV12,
  ChatRecordSummaryV15,
} from "@traycer/protocol/host/epic/chat-records";
import type {
  TaskHostPrincipal,
  TaskHostRow,
} from "@traycer/protocol/host/task-host-summary";
import { ChatTreePanelBody } from "@/components/epic-canvas/sidebar/epic-sidebar-chat-tree";
import { CHAT_TREE_MESSAGE_HITS_NONE } from "@/components/epic-canvas/sidebar/epic-sidebar-message-hits-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import { PersonMembersContext } from "@/hooks/identity/use-person-identity";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  reachSentence,
  REACH_UNNAMED_HOSTS,
} from "@/lib/sandboxes/sandbox-strings";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const hostState = vi.hoisted(() => {
  const view: { current: TaskHostsView } = { current: { kind: "none" } };
  return { view };
});
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (): HostReachability => ({
      status: "reachable",
      hostLabel: actual.UNNAMED_HOST_LABEL,
      unavailability: null,
      basis: "directory",
      hostKind: "unknown",
    }),
  };
});
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

const EPIC_ID = "epic-chat-row-started-by";
const TAB_ID = "tab-chat-row-started-by";
const USER_ID = "user-1";
const TEAM_HOST_ID = "host-team";
const PERSONAL_HOST_ID = "host-personal";
const TEAM_OWNER: HostOwnerPrincipal = {
  kind: "team",
  id: "team-acme",
  name: "Acme",
};
const PERSONAL_OWNER: HostOwnerPrincipal = { kind: "user", id: USER_ID };

/** Each chat by id, on the host its row is owned by, with the starter its record states. */
interface ChatCase {
  readonly hostId: string;
  readonly starterUserId: string | null;
}
const CHATS: ReadonlyMap<string, ChatCase> = new Map([
  ["chat-team-named", { hostId: TEAM_HOST_ID, starterUserId: "u-priya" }],
  ["chat-team-unnamed", { hostId: TEAM_HOST_ID, starterUserId: "u-gone" }],
  ["chat-team-none", { hostId: TEAM_HOST_ID, starterUserId: null }],
  ["chat-team-system", { hostId: TEAM_HOST_ID, starterUserId: "system" }],
  ["chat-personal", { hostId: PERSONAL_HOST_ID, starterUserId: "u-priya" }],
]);

const directoryPeople = new Map<
  string,
  { readonly displayName: string; readonly avatarUrl: string | null }
>();
const resolveDirectoryPerson: BotMemberResolver = (userId) =>
  directoryPeople.get(userId) ?? null;

function hostRow(
  hostId: string,
  principal: TaskHostPrincipal,
  reach: TaskHostRow["reach"],
): TaskHostRow {
  return { hostId, label: null, principal, reach, sandboxEnd: null };
}

function installDirectory(rows: ReadonlyArray<HostDirectoryEntry>): void {
  const byId = new Map(rows.map((row) => [row.hostId, row]));
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => byId.get(hostId) ?? null,
      onDirectoryChanged: () => ({ dispose: () => undefined }),
    },
    leases: null,
  });
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Chat row started by",
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
  for (const [id, chat] of CHATS) {
    chats.set(id, chatEntry(id, chat.hostId));
  }
  epic.set("title", "Chat row started by");
  epic.set("artifacts", new Y.Map<unknown>());
  epic.set("tuiAgents", new Y.Map<unknown>());
  epic.set("chats", chats);
  return Y.encodeStateAsUpdate(donor);
}

function chatRecord(
  chatId: string,
  chat: ChatCase,
): ChatRecordSummaryV12 & Pick<ChatRecordSummaryV15, "starterUserId"> {
  return {
    chatId,
    ownerUserId: USER_ID,
    originHostId: chat.hostId,
    title: `Chat ${chatId}`,
    isTitleEditedByUser: false,
    parentChatId: null,
    createdAt: 0,
    updatedAt: 0,
    archived: false,
    archivedAt: null,
    runSettingsSummary: null,
    revision: 1,
    visibility: "private",
    origin: "own",
    docResident: false,
    head: null,
    ...(chat.starterUserId === null
      ? {}
      : { starterUserId: chat.starterUserId }),
  };
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
  act(() => {
    handle.store.getState().applyChatRecords(
      [...CHATS].map(([chatId, chat]) => chatRecord(chatId, chat)),
      null,
    );
  });
  return handle;
}

const opened: OpenedStoreForTest[] = [];

function renderPanel(): void {
  const session = createSession();
  opened.push(session);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <PersonMembersContext.Provider value={resolveDirectoryPerson}>
          <EpicSessionContext.Provider value={session}>
            <ChatTreePanelBody
              epicId={EPIC_ID}
              tabId={TAB_ID}
              messageHits={CHAT_TREE_MESSAGE_HITS_NONE}
            />
          </EpicSessionContext.Provider>
        </PersonMembersContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function hoverOf(chatId: string): HTMLElement {
  // The row rendered, so an absent line below is not vacuous.
  expect(screen.getByTestId(`epic-sidebar-item-${chatId}`)).toBeTruthy();
  return screen.getByTestId(`hover-extra-${chatId}`);
}

beforeEach(() => {
  directoryPeople.clear();
  installDirectory([
    { ...remoteEntry(TEAM_HOST_ID, null), owner: TEAM_OWNER },
    { ...remoteEntry(PERSONAL_HOST_ID, null), owner: PERSONAL_OWNER },
  ]);
});

afterEach(() => {
  cleanup();
  for (const handle of opened.splice(0)) handle.dispose();
  resetHostConnectionRegistryForTest();
  hostState.view.current = { kind: "none" };
});

describe("a chat row's hover: who started it", () => {
  it("names the starter from the directory on a team computer's chat", () => {
    directoryPeople.set("u-priya", {
      displayName: "Priya",
      avatarUrl: "https://images.example.test/priya.png",
    });
    renderPanel();

    const line = within(hoverOf("chat-team-named")).getByTestId(
      "chat-row-started-by",
    );
    expect(line.textContent).toBe("Started by Priya");
    expect(screen.queryByText("u-priya", { exact: true })).toBeNull();
  });

  it("shows the starter's id when the directory cannot name that person", () => {
    renderPanel();

    const line = within(hoverOf("chat-team-unnamed")).getByTestId(
      "chat-row-started-by",
    );
    expect(line.textContent).toBe("Started by u-gone");
  });

  it("says nothing for a personal computer's chat, whose starter is recorded", () => {
    directoryPeople.set("u-priya", {
      displayName: "Priya",
      avatarUrl: null,
    });
    renderPanel();

    expect(
      within(hoverOf("chat-personal")).queryByTestId("chat-row-started-by"),
    ).toBeNull();
    expect(
      within(hoverOf("chat-personal")).queryByText(/Started by/u),
    ).toBeNull();
  });

  it("says nothing for a team chat with no starter recorded", () => {
    renderPanel();

    expect(
      within(hoverOf("chat-team-none")).queryByTestId("chat-row-started-by"),
    ).toBeNull();
  });

  it("says nothing for a team chat whose starter is system", () => {
    renderPanel();

    expect(
      within(hoverOf("chat-team-system")).queryByTestId("chat-row-started-by"),
    ).toBeNull();
    expect(
      within(hoverOf("chat-team-system")).queryByText(/Started by/u),
    ).toBeNull();
  });

  it("says nothing for a chat whose host the directory does not list", () => {
    installDirectory([]);
    renderPanel();

    expect(
      within(hoverOf("chat-team-named")).queryByTestId("chat-row-started-by"),
    ).toBeNull();
  });

  it("keeps the reach line after the starter line on a foreign team computer's chat", () => {
    directoryPeople.set("u-priya", {
      displayName: "Priya",
      avatarUrl: null,
    });
    hostState.view.current = {
      kind: "hosts",
      hosts: [
        hostRow(
          TEAM_HOST_ID,
          { kind: "team", id: TEAM_OWNER.id },
          "other_principal",
        ),
      ],
    };
    renderPanel();

    const hover = hoverOf("chat-team-named");
    const starter = within(hover).getByTestId("chat-row-started-by");
    const reach = within(hover).getByTestId("agent-hover-reach-line");
    expect(starter.textContent).toBe("Started by Priya");
    expect(reach.textContent).toBe(reachSentence(REACH_UNNAMED_HOSTS));
    expect(
      starter.compareDocumentPosition(reach) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
