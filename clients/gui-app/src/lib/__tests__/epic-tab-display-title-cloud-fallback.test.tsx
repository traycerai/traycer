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

const EPIC_ID = "epic-cloud-title";
const CHAT_ID = "chat-cloud-only";
const VIEWER_ID = "viewer-1";
const CLOUD_TITLE = "Skill Versioning System Design";

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
// so its snapshot name is the render fallback, and bound to the chat's host.
const tile = {
  id: CHAT_ID,
  name: "Untitled agent",
  type: "chat",
  hostId: mockLocalHostEntry.hostId,
};

function renderTitle(fixture: Fixture) {
  return renderHook(() => useEpicTabDisplayTitle(tile, EPIC_ID, null), {
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
  });

  it("reads the cloud title for a chat the projection holds no record of", async () => {
    const fixture = createFixture([
      cloudRow(true, mockLocalHostEntry.hostId, CLOUD_TITLE),
    ]);
    fixtures.push(fixture);
    const rendered = renderTitle(fixture);

    // Before the list answers the snapshot is all there is.
    expect(rendered.result.current).toBe("Untitled agent");
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
    const rendered = renderTitle(fixture);

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
    const rendered = renderTitle(fixture);

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
    const rendered = renderTitle(fixture);

    // The projection's "untitled" is an answer, not an absence: the list is
    // never requested and the snapshot stands.
    await act(async () => {
      await Promise.resolve();
    });
    expect(fixture.requests.value).toBe(0);
    expect(rendered.result.current).toBe("Untitled agent");
  });
});
