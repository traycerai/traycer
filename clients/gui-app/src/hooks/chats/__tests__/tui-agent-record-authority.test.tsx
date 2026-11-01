/**
 * When `epic.listTuiAgents` counts as answered.
 *
 * `tuiAgentRecordListAuthoritative` is what lets a delete dialog state a number
 * of nested agents, so a true flag over an unanswered list understates rows
 * that exist. The suite drives the real hook against a real `QueryClient`, a
 * real `HostClient` over the mock messenger and a real open-epic store, because
 * the flag's meaning is the query's settled state as this hook reads it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import type { TuiAgentRecordSummaryV13 } from "@traycer/protocol/host/epic/tui-agent-records";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  EpicSessionContext,
  EpicSessionHostClientContext,
} from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useEpicSyncTuiAgentRecords } from "@/hooks/chats/use-epic-tui-agent-records";
import { useEpicTuiAgentRetraction } from "@/lib/epic-selectors";

const EPIC_ID = "epic-tui-authority";
const VIEWER_ID = "viewer-1";
const HOST_ID = mockLocalHostEntry.hostId;
const AGENT_ID = "tui-1";

const runtime: { client: HostClient<HostRpcRegistry> | null } = vi.hoisted(
  () => ({ client: null }),
);
vi.mock("@/lib/host/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host/runtime")>()),
  useHostClient: () => runtime.client,
  useHostRuntimeClient: () => runtime.client,
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: null },
}));
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    runtime.client === null
      ? null
      : { hostClient: runtime.client, hostId: null },
  useHostClient: () => runtime.client,
  useHostRuntimeClient: () => runtime.client,
}));

function tuiRow(): TuiAgentRecordSummaryV13 {
  return {
    tuiAgentId: AGENT_ID,
    ownerUserId: VIEWER_ID,
    hostId: HOST_ID,
    harnessId: "claude",
    harnessSessionId: null,
    parentId: null,
    title: "",
    isTitleEditedByUser: false,
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    archivedAt: null,
    workspaceFolders: [],
    workspaceMode: null,
    model: null,
    reasoningEffort: null,
    agentMode: "regular",
    profileId: null,
    terminalAgentArgs: null,
    terminalShellCommand: null,
    terminalShellArgs: null,
    revision: 1,
    docResident: false,
    origin: "registry",
    sessionState: null,
    lastExit: null,
  };
}

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: EPIC_ID,
      title: "Terminal-agent authority",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: VIEWER_ID,
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
    userId: VIEWER_ID,
    factories: { streamClientFactory: factory, laneSelection: null },
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("stream factory not invoked");
  const seed = new Y.Doc();
  seed.getMap("epic").set("chats", new Y.Map<unknown>());
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(seed));
  return handle;
}

type ListFailureCode = "E_HOST_UNSUPPORTED" | "RPC_ERROR";

interface Fixture {
  readonly queryClient: QueryClient;
  readonly handle: OpenedStoreForTest;
  readonly listCalls: { value: number };
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createFixture(listFailureCode: ListFailureCode | null): Fixture {
  const listCalls = { value: 0 };
  const requestSeq = { value: 0 };
  const queryClient = new QueryClient({
    defaultOptions: {
      // `retry` is the hook's own predicate, so a transient failure really
      // does run it out. Zero delay is only so that takes no wall-clock time.
      queries: { retryDelay: 0 },
      mutations: { retry: false },
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => {
        requestSeq.value += 1;
        return `req-${String(requestSeq.value)}`;
      },
      handlers: {
        "epic.listTuiAgents": () => {
          listCalls.value += 1;
          if (listFailureCode !== null) {
            return Promise.reject(
              new HostRpcError({
                code: listFailureCode,
                message: "terminal-agent list failed",
                requestId: `req-${String(requestSeq.value)}`,
                method: "epic.listTuiAgents",
                fatalDetails: null,
              }),
            );
          }
          return Promise.resolve({
            kind: "snapshot" as const,
            listStamp: null,
            tuiAgents: [tuiRow()],
          });
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  runtime.client = client;
  const handle = newSession();
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        EpicSessionContext.Provider,
        { value: handle },
        createElement(
          EpicSessionHostClientContext.Provider,
          { value: client },
          props.children,
        ),
      ),
    );
  return { queryClient, handle, listCalls, Wrapper };
}

let fixture: Fixture | null = null;

function mount(listFailureCode: ListFailureCode | null): Fixture {
  const mounted = createFixture(listFailureCode);
  fixture = mounted;
  renderHook(() => useEpicSyncTuiAgentRecords(EPIC_ID), {
    wrapper: mounted.Wrapper,
  });
  return mounted;
}

function readAuthority(mounted: Fixture): boolean {
  return mounted.handle.store.getState().tuiAgentRecordListAuthoritative;
}

beforeEach(() => {
  useAuthStore.setState({
    contextMetadata: { userId: VIEWER_ID, username: VIEWER_ID },
  });
});

afterEach(() => {
  cleanup();
  fixture?.handle.store.getState().dispose();
  fixture = null;
  runtime.client = null;
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

describe("terminal-agent list authority", () => {
  /**
   * Read at the FLIP, not after it: a count taken in that moment is the one a
   * dialog would show, and by the time a `waitFor` returns, a mark sent ahead
   * of the apply would have been overtaken by it.
   */
  it("holds once the list has answered, with the answer's rows already in the tree", async () => {
    const mounted = createFixture(null);
    fixture = mounted;
    const { store } = mounted.handle;
    expect(readAuthority(mounted)).toBe(false);
    const rowPresentAtFlip: boolean[] = [];
    const unsubscribe = store.subscribe((state, previous) => {
      if (
        state.tuiAgentRecordListAuthoritative &&
        !previous.tuiAgentRecordListAuthoritative
      ) {
        rowPresentAtFlip.push(Object.hasOwn(state.tree.nodeById, AGENT_ID));
      }
    });
    renderHook(() => useEpicSyncTuiAgentRecords(EPIC_ID), {
      wrapper: mounted.Wrapper,
    });

    await waitFor(() => {
      expect(readAuthority(mounted)).toBe(true);
    });
    unsubscribe();

    expect(rowPresentAtFlip).toEqual([true]);
  });

  it("treats E_HOST_UNSUPPORTED as an authoritative doc-only answer", async () => {
    const mounted = mount("E_HOST_UNSUPPORTED");

    await waitFor(() => {
      expect(readAuthority(mounted)).toBe(true);
    });

    expect(mounted.listCalls.value).toBe(1);
  });

  it("reads a retraction the record plane announced, for that agent alone", async () => {
    const mounted = mount(null);
    await waitFor(() => {
      expect(readAuthority(mounted)).toBe(true);
    });

    mounted.handle.store.getState().applyTuiAgentRecordDelta({
      kind: "tuiRemove",
      epicId: EPIC_ID,
      tuiAgentId: AGENT_ID,
      reason: "deleted",
    });

    const { result } = renderHook(
      () => ({
        retracted: useEpicTuiAgentRetraction(AGENT_ID),
        other: useEpicTuiAgentRetraction("tui-other"),
        none: useEpicTuiAgentRetraction(null),
      }),
      { wrapper: mounted.Wrapper },
    );

    await waitFor(() => {
      expect(result.current).toEqual({
        retracted: "deleted",
        other: null,
        none: null,
      });
    });
  });

  it("stays false through a transient failure, retries included", async () => {
    const mounted = mount("RPC_ERROR");

    await waitFor(() => {
      expect(
        mounted.queryClient
          .getQueryCache()
          .getAll()
          .some((query) => query.state.status === "error"),
      ).toBe(true);
    });

    expect(mounted.listCalls.value).toBe(3);
    expect(readAuthority(mounted)).toBe(false);
  });
});
