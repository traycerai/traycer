import type { ReactNode } from "react";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import { useEpicTabDisplayTitle } from "@/lib/epic-selectors";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

// Neither arm is under test, and each reaches a plane this suite does not
// stand up (the terminal authority, the managed-command store).
vi.mock("@/hooks/terminal/use-terminal-display-title", () => ({
  useTerminalDisplayTitle: () => null,
}));
vi.mock("@/stores/managed-commands/managed-commands-for-chat", () => ({
  useManagedCommandOnHost: () => null,
}));

// The environment arm is a team environment's own stream, the one external
// source a team host's chat reaches this client through.
const armRows = vi.hoisted((): { value: readonly CloudChatSummary[] } => ({
  value: [],
}));
vi.mock("@/hooks/environment/use-environment-arms", () => ({
  useEnvironmentArmChats: (taskId: string) =>
    taskId.length === 0 ? [] : armRows.value,
}));

const EPIC_ID = "epic-cloud-title";
const CHAT_ID = "chat-cloud-only";
const VIEWER_ID = "viewer-1";
const CLOUD_TITLE = "Skill Versioning System Design";
const ENVIRONMENT_ID = "env-pool";
const ARM_TITLE = "E2E Sandbox Test";

const fakeStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function cloudRow(
  isOwnedByViewer: boolean,
  ownerHostId: string,
  title: string,
): CloudChatSummary {
  return {
    identity: {
      taskId: EPIC_ID,
      chatId: CHAT_ID,
      ownerUserId: isOwnedByViewer ? VIEWER_ID : "collaborator-1",
    },
    ownerHostId,
    createdAt: 1,
    visibility: "task",
    title,
    isTitleEditedByUser: false,
    parentChatId: null,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 2,
    headSha256: null,
    publishedAt: null,
    throughRecordSeq: null,
    isOwnedByViewer,
  };
}

// The team environment's row for the chat: filed under the environment, on
// the host the creator sent it to.
function armRow(ownerHostId: string, title: string): CloudChatSummary {
  return {
    ...cloudRow(false, ownerHostId, title),
    identity: { taskId: EPIC_ID, chatId: CHAT_ID, ownerUserId: ENVIRONMENT_ID },
  };
}

function projectedChat(title: string): ChatProjection {
  return {
    id: CHAT_ID,
    title,
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    userId: VIEWER_ID,
    ownedByViewer: true,
    hostId: mockLocalHostEntry.hostId,
    isTitleEditedByUser: false,
    docResident: false,
    archivedAt: null,
    settings: null,
  };
}

interface Fixture {
  readonly handle: OpenedStoreForTest;
  readonly queryClient: QueryClient;
  readonly requests: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createFixture(rows: readonly CloudChatSummary[]): Fixture {
  const requests = { value: 0 };
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `cloud-list-${String(requests.value + 1)}`,
      handlers: {
        "epic.listCloudChats": () => {
          requests.value += 1;
          return Promise.resolve({ chats: [...rows] });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    userId: VIEWER_ID,
    factories: {
      streamClientFactory: fakeStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={handle}>
        <EpicSessionHostClientContext.Provider value={client}>
          {props.children}
        </EpicSessionHostClientContext.Provider>
      </EpicSessionContext.Provider>
    </QueryClientProvider>
  );
  return { handle, queryClient, requests, Wrapper };
}

// The tile as the canvas persisted it: opened before the title was generated,
// by a build that baked the "Untitled agent" fallback into its snapshot name,
// and bound to the chat's host.
const tile = {
  id: CHAT_ID,
  name: "Untitled agent",
  type: "chat",
  hostId: mockLocalHostEntry.hostId,
};

function renderTitle(fixture: Fixture, node: typeof tile) {
  return renderHook(() => useEpicTabDisplayTitle(node, EPIC_ID, null), {
    wrapper: fixture.Wrapper,
  });
}

describe("useEpicTabDisplayTitle cloud-list fallback", () => {
  const fixtures: Fixture[] = [];

  beforeEach(() => {
    useAuthStore.setState({
      status: "signed-in",
      contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
    });
  });

  afterEach(() => {
    cleanup();
    for (const fixture of fixtures) {
      fixture.handle.dispose();
      fixture.queryClient.clear();
    }
    fixtures.length = 0;
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    armRows.value = [];
  });

  it("reads the cloud title for a chat the projection holds no record of", async () => {
    const fixture = createFixture([
      cloudRow(true, mockLocalHostEntry.hostId, CLOUD_TITLE),
    ]);
    fixtures.push(fixture);
    const rendered = renderTitle(fixture, tile);

    // Before the list answers the snapshot is all there is.
    expect(rendered.result.current).toBe("New agent");
    await waitFor(() => {
      expect(rendered.result.current).toBe(CLOUD_TITLE);
    });

    // The record plane catching up hands the title back to the projection
    // without a flicker through the snapshot.
    act(() => {
      fixture.handle.store.setState({
        chats: {
          allIds: [CHAT_ID],
          byId: { [CHAT_ID]: projectedChat("Renamed") },
        },
      });
    });
    expect(rendered.result.current).toBe("Renamed");
  });

  // The wrong row is listed FIRST in each case below, so a lookup that matched
  // on the id alone would take it on list order.
  it("ignores a collaborator's row sharing the host-minted id", async () => {
    const fixture = createFixture([
      cloudRow(false, mockLocalHostEntry.hostId, "Collaborator's chat"),
      cloudRow(true, mockLocalHostEntry.hostId, CLOUD_TITLE),
    ]);
    fixtures.push(fixture);
    const rendered = renderTitle(fixture, tile);

    await waitFor(() => {
      expect(rendered.result.current).toBe(CLOUD_TITLE);
    });
  });

  it("ignores the viewer's own row minted on another host under the same id", async () => {
    const fixture = createFixture([
      cloudRow(true, mockRemoteHostEntry.hostId, "Other host's chat"),
      cloudRow(true, mockLocalHostEntry.hostId, CLOUD_TITLE),
    ]);
    fixtures.push(fixture);
    const rendered = renderTitle(fixture, tile);

    await waitFor(() => {
      expect(rendered.result.current).toBe(CLOUD_TITLE);
    });
  });

  it("does not consult the cloud list when the projection holds the record untitled", async () => {
    const fixture = createFixture([
      cloudRow(true, mockLocalHostEntry.hostId, CLOUD_TITLE),
    ]);
    fixtures.push(fixture);
    fixture.handle.store.setState({
      chats: { allIds: [CHAT_ID], byId: { [CHAT_ID]: projectedChat("") } },
    });
    const rendered = renderTitle(fixture, tile);

    // The projection's "untitled" is an answer, not an absence: the list is
    // never requested and the snapshot stands.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.requests.value).toBe(0);
    expect(rendered.result.current).toBe("New agent");
  });
  it.each([
    ["Untitled agent", "New agent"],
    ["Untitled chat", "Untitled chat"],
  ])(
    "reads a tile snapshot named %j as %j when no source has a title",
    async (name, shown) => {
      const fixture = createFixture([]);
      fixtures.push(fixture);
      const rendered = renderTitle(fixture, { ...tile, name });
      await act(async () => {
        await Promise.resolve();
      });

      expect(rendered.result.current).toBe(shown);
    },
  );

  it("a team host's chat, held as the creator's untitled stand-in, takes the arm row's title", () => {
    const fixture = createFixture([]);
    fixtures.push(fixture);
    armRows.value = [armRow(mockLocalHostEntry.hostId, ARM_TITLE)];
    // The creator's stand-in: filed under the viewer, untitled, on the host
    // the create went to - the only record a team host's chat ever gets here.
    fixture.handle.store.setState({
      chats: { allIds: [CHAT_ID], byId: { [CHAT_ID]: projectedChat("") } },
    });
    const rendered = renderTitle(fixture, tile);

    expect(rendered.result.current).toBe(ARM_TITLE);
  });

  it("after the stand-in retires, the tab keeps the arm row's title", () => {
    const fixture = createFixture([]);
    fixtures.push(fixture);
    armRows.value = [armRow(mockLocalHostEntry.hostId, ARM_TITLE)];
    const rendered = renderTitle(fixture, tile);

    expect(rendered.result.current).toBe(ARM_TITLE);
  });
  it("a tab bound to one host never takes the title of a same-id chat held on another", () => {
    const fixture = createFixture([]);
    fixtures.push(fixture);
    // Host A's chat is held, untitled, and A's arm row has a title; the tab is
    // bound to a different chat that host B minted under the same id.
    armRows.value = [
      armRow(mockLocalHostEntry.hostId, "Host A's chat"),
      armRow(mockRemoteHostEntry.hostId, ARM_TITLE),
    ];
    fixture.handle.store.setState({
      chats: { allIds: [CHAT_ID], byId: { [CHAT_ID]: projectedChat("") } },
    });
    const rendered = renderHook(
      () =>
        useEpicTabDisplayTitle(
          { ...tile, hostId: mockRemoteHostEntry.hostId },
          EPIC_ID,
          null,
        ),
      { wrapper: fixture.Wrapper },
    );

    expect(rendered.result.current).toBe(ARM_TITLE);
  });
});
