/**
 * A member creates a chat on a TEAM host. The create files a stand-in in the
 * open-epic store's chat table keyed by the CREATOR's user id; the chat the
 * host then publishes is environment-owned and reaches the renderer only
 * through the environment arm, as a `CloudChatSummary` whose owner is the
 * environment id. These tests drive the REAL open-epic store with
 * `useEpicRouteSynchronization` and the click path (`useEpicAgentOpenRef`) on
 * top of it, and fake only the pool stream at its hook boundary.
 */
import { createElement, type ReactNode } from "react";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  type EpicRouteFocusIntent,
  useEpicRouteSynchronization,
} from "@/components/epic-canvas/hooks/use-epic-route-synchronization";
import { useEpicAgentOpenRef } from "@/hooks/epic/use-epic-agent-open-ref";
import { selectUnfoldedCloudChats } from "@/lib/chats/unified-chat-list";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-arm-stand-in";
const TAB_ID = "tab-arm-stand-in";
const CREATOR = "user-a";
const ENV = "env_team";
const TEAM_HOST = "host-team";
const OTHER_HOST = "host-other";
const SESSION_HOST = "host-session";
const CHAT_ID = "chat-created";

const harness = vi.hoisted(() => ({
  armChats: [] as CloudChatSummary[],
  ownerReachability: "reachable" as "reachable" | "unreachable",
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => Promise.resolve(),
  useRouter: () => ({
    history: {},
    state: { location: { pathname: `/epics/${EPIC_ID}/${TAB_ID}` } },
  }),
}));

vi.mock("@/lib/persistent-history", () => ({
  getHistoryController: () => null,
}));

vi.mock("@/lib/canvas/tile-open/open-tile", () => ({
  MANUAL_TILE_OPEN: { createTab: true, pipOrigin: "manual" },
  commitWithoutNavigation: (
    _epicId: string,
    _tabId: string,
    prepare: () => unknown,
  ) => prepare(),
  openTileWithNavigation: () => null,
}));

vi.mock("@/stores/epics/canvas/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/stores/epics/canvas/store")>();
  const canvasStore = {
    renameTab: () => undefined,
    applyNestedRouteFocus: () => undefined,
    closeCanvasTab: () => undefined,
    closedTilePayloadsByTabId: {},
    pendingCreateArtifactIds: new Set<string>(),
  };
  const emptyCanvas = {
    root: null,
    activePaneId: null,
    tilesByInstanceId: {},
    sizesByGroupId: {},
  };
  return {
    ...actual,
    useActiveEpicArtifactId: () => null,
    useEpicCanvas: () => emptyCanvas,
    useEpicCanvasStore: Object.assign(
      <T,>(selector: (store: typeof canvasStore) => T): T =>
        selector(canvasStore),
      { getState: () => canvasStore },
    ),
    useEpicTab: () => null,
  };
});

vi.mock("@/components/epic-canvas/hooks/use-canvas-host-id", () => ({
  useCanvasHostId: () => SESSION_HOST,
}));

vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));

vi.mock("@/hooks/epic/use-epic-session-host-id", () => ({
  useEpicSessionHostId: () => SESSION_HOST,
}));

vi.mock("@/lib/epic-auto-open", () => ({
  resolveAutoOpenTarget: () => null,
}));

vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostClient: () => null,
}));

vi.mock("@/hooks/agent/use-host-reachability", () => ({
  useHostReachability: () => ({ status: harness.ownerReachability }),
}));

vi.mock("@/hooks/chats/use-host-refuses-epic-store", () => ({
  useHostRefusesEpicStore: () => false,
}));

// A SETTLED, successful, empty cloud list: the sweep waits for an answer.
vi.mock("@/hooks/chats/use-cloud-chat-queries", () => ({
  useCloudChatList: () => ({
    data: { chats: [] },
    isEnabled: true,
    isSuccess: true,
    isError: false,
    isPending: false,
    isFetching: false,
    error: null,
  }),
  useCloudChatHasCloudAuthorization: () => true,
  isCloudChatListSettled: () => true,
  cloudChatListAuthorizesRecordSweep: () => true,
}));

// The external pool stream, faked at its hook boundary.
vi.mock("@/hooks/environment/use-environment-arms", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/hooks/environment/use-environment-arms")
  >()),
  useEnvironmentArmChats: () => harness.armChats,
}));

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Epic",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: CREATOR,
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenedStoreForTest {
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
    userId: CREATOR,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

function signedInAs(userId: string): void {
  useAuthStore
    .getState()
    .setSignedIn(
      { userId, userName: userId, email: `${userId}@example.com` },
      { userId, username: userId },
      [],
    );
}

function armRow(
  overrides: Partial<
    Pick<
      CloudChatSummary,
      "ownerHostId" | "headSha256" | "publishedAt" | "throughRecordSeq"
    >
  >,
): CloudChatSummary {
  return {
    identity: { taskId: EPIC_ID, chatId: CHAT_ID, ownerUserId: ENV },
    ownerHostId: TEAM_HOST,
    createdAt: 1,
    visibility: "task",
    title: "Served",
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 2,
    headSha256: "a".repeat(64),
    publishedAt: 3,
    throughRecordSeq: 1,
    isOwnedByViewer: false,
    ...overrides,
  };
}

const INTENT: EpicRouteFocusIntent = {
  epicId: EPIC_ID,
  tabId: TAB_ID,
  focusedAt: undefined,
  focusArtifactId: undefined,
  focusThreadId: undefined,
  focusPaneId: undefined,
  focusTileInstanceId: undefined,
};

function fileStandIn(handle: OpenedStoreForTest): void {
  handle.store.getState().beginPendingChatCreation({
    chatId: CHAT_ID,
    hostId: TEAM_HOST,
    parentChatId: null,
    title: "",
    ownerUserId: CREATOR,
  });
}

function beginStandIn(handle: OpenedStoreForTest): void {
  fileStandIn(handle);
  expect(handle.store.getState().chats.byId[CHAT_ID].userId).toBe(CREATOR);
}

function mountRouteSync(handle: OpenedStoreForTest) {
  const wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(
      EpicSessionContext.Provider,
      { value: handle },
      props.children,
    );
  return renderHook(
    (intent: EpicRouteFocusIntent) => {
      useEpicRouteSynchronization(intent);
      return useEpicAgentOpenRef({
        epicId: EPIC_ID,
        nodeId: CHAT_ID,
        name: "Created chat",
        type: "chat",
      });
    },
    { initialProps: INTENT, wrapper },
  );
}

/** What the arm serves for a chat whose host has not published a head yet. */
const NOT_PUBLISHED = {
  headSha256: null,
  publishedAt: null,
  throughRecordSeq: null,
} as const;

const SIBLING_ID = "chat-sibling";

/** A published arm row for a second chat, on the team host. */
function publishedSiblingRow(): CloudChatSummary {
  return {
    ...armRow({ ownerHostId: TEAM_HOST }),
    identity: { taskId: EPIC_ID, chatId: SIBLING_ID, ownerUserId: ENV },
  };
}

function fileSiblingStandIn(handle: OpenedStoreForTest): void {
  handle.store.getState().beginPendingChatCreation({
    chatId: SIBLING_ID,
    hostId: TEAM_HOST,
    parentChatId: null,
    title: "",
    ownerUserId: CREATOR,
  });
}

function siblingIsRetired(handle: OpenedStoreForTest): boolean {
  const chats = handle.store.getState().chats;
  return (
    !Object.hasOwn(chats.byId, SIBLING_ID) ||
    chats.byId[SIBLING_ID].userId !== CREATOR
  );
}

function standInSurvives(handle: OpenedStoreForTest): boolean {
  return !standInIsGone(handle);
}

function standInIsGone(handle: OpenedStoreForTest): boolean {
  const chats = handle.store.getState().chats;
  return (
    !Object.hasOwn(chats.byId, CHAT_ID) ||
    chats.byId[CHAT_ID].userId !== CREATOR
  );
}

/** Lets the route-sync effects run to quiescence before a "stays" claim. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 50);
  });
}

let handle: OpenedStoreForTest;

beforeEach(() => {
  harness.armChats = [];
  harness.ownerReachability = "reachable";
  signedInAs(CREATOR);
  handle = newSession();
});

afterEach(() => {
  cleanup();
  handle.dispose();
  useAuthStore.getState().setSignedOut();
});

describe("route sync and the environment arm's copy of a just-created chat", () => {
  it("retires the creator-keyed stand-in once the environment arm serves the same chat on the same host", async () => {
    beginStandIn(handle);
    harness.armChats = [armRow({ ownerHostId: TEAM_HOST })];

    mountRouteSync(handle);

    await waitFor(() => {
      expect(standInIsGone(handle)).toBe(true);
    });
  });

  it("the click no longer resolves to the creator-keyed copy", async () => {
    harness.ownerReachability = "unreachable";
    beginStandIn(handle);
    const row = armRow({ ownerHostId: TEAM_HOST });
    harness.armChats = [row];

    const view = mountRouteSync(handle);

    await waitFor(() => {
      view.rerender(INTENT);
      expect(view.result.current()).not.toMatchObject({
        type: "published-chat",
        ownerUserId: CREATOR,
      });
    });

    // The row the person clicks in the sidebar is the arm's, owned by the
    // environment, and it is not folded away behind a local entry.
    const unfolded = selectUnfoldedCloudChats({
      chats: harness.armChats,
      localChatIds: handle.store.getState().chats.allIds,
      publicationChatIdByChatId: new Map(),
    });
    expect(unfolded.map((chat) => chat.identity.ownerUserId)).toEqual([ENV]);
  });

  it("before first publication the stand-in stays and the click stays live", async () => {
    beginStandIn(handle);

    const view = mountRouteSync(handle);
    await settle();

    expect(handle.store.getState().chats.byId[CHAT_ID].userId).toBe(CREATOR);
    expect(view.result.current()).toMatchObject({
      type: "chat",
      id: CHAT_ID,
      hostId: TEAM_HOST,
    });
  });

  it("a metadata-only arm row (no published head) does not retire the stand-in", async () => {
    beginStandIn(handle);
    fileSiblingStandIn(handle);
    harness.armChats = [
      armRow({ ownerHostId: TEAM_HOST, ...NOT_PUBLISHED }),
      publishedSiblingRow(),
    ];

    mountRouteSync(handle);

    // The published sibling retiring proves the effect ran over this arm.
    await waitFor(() => {
      expect(siblingIsRetired(handle)).toBe(true);
    });
    expect(standInSurvives(handle)).toBe(true);
  });

  it("the first published head retires it", async () => {
    beginStandIn(handle);
    fileSiblingStandIn(handle);
    harness.armChats = [
      armRow({ ownerHostId: TEAM_HOST, ...NOT_PUBLISHED }),
      publishedSiblingRow(),
    ];
    const view = mountRouteSync(handle);
    await waitFor(() => {
      expect(siblingIsRetired(handle)).toBe(true);
    });
    expect(standInSurvives(handle)).toBe(true);

    harness.armChats = [
      armRow({ ownerHostId: TEAM_HOST }),
      publishedSiblingRow(),
    ];
    view.rerender(INTENT);

    await waitFor(() => {
      expect(standInIsGone(handle)).toBe(true);
    });
  });

  it("an arm row for the same chat on a DIFFERENT host does not retire the stand-in", async () => {
    beginStandIn(handle);
    // A sibling chat the arm DOES serve on its own host: its retirement proves
    // the effect has run over this arm before the other chat is read.
    handle.store.getState().beginPendingChatCreation({
      chatId: "chat-sibling",
      hostId: TEAM_HOST,
      parentChatId: null,
      title: "",
      ownerUserId: CREATOR,
    });
    harness.armChats = [
      armRow({ ownerHostId: OTHER_HOST }),
      {
        ...armRow({ ownerHostId: TEAM_HOST }),
        identity: { taskId: EPIC_ID, chatId: "chat-sibling", ownerUserId: ENV },
      },
    ];

    mountRouteSync(handle);

    await waitFor(() => {
      const chats = handle.store.getState().chats;
      expect(
        !Object.hasOwn(chats.byId, "chat-sibling") ||
          chats.byId["chat-sibling"].userId !== CREATOR,
      ).toBe(true);
    });
    expect(handle.store.getState().chats.byId[CHAT_ID].userId).toBe(CREATOR);
    expect(handle.store.getState().chats.byId[CHAT_ID].hostId).toBe(TEAM_HOST);
  });

  it("retires the stand-in when the arm row arrives after the hook mounted", async () => {
    beginStandIn(handle);
    const view = mountRouteSync(handle);
    await settle();
    expect(handle.store.getState().chats.byId[CHAT_ID].userId).toBe(CREATOR);

    harness.armChats = [armRow({ ownerHostId: TEAM_HOST })];
    view.rerender(INTENT);

    await waitFor(() => {
      expect(standInIsGone(handle)).toBe(true);
    });
  });

  it("retires a stand-in begun after the arm row is already present", async () => {
    harness.armChats = [armRow({ ownerHostId: TEAM_HOST })];
    mountRouteSync(handle);
    await settle();

    fileStandIn(handle);

    await waitFor(() => {
      expect(standInIsGone(handle)).toBe(true);
    });
  });
});
