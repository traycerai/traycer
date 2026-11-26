import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  createHostRpcTierPlan,
  type HostServingDecision,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  buildConnectionManifest,
  SERVES_EVERY_INSTALLED_MAJOR,
} from "@traycer/protocol/framework/capability-manifest";
import { RELEASED_FLOOR_METHOD_NAMES } from "@traycer/protocol/host/released-floor";
import { MutableBearerLease } from "@traycer-clients/shared/auth/bearer-source";
import type {
  HostRequestOptions,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { RemoteHostMessenger } from "@traycer-clients/shared/host-transport/remote/remote-host-messenger";
import { RemoteSession } from "@traycer-clients/shared/host-transport/remote/remote-session";
import { NO_TRANSPORT_EVIDENCE } from "@traycer-clients/shared/host-selection/transport-evidence";
import { TEST_CLIENT_IDENTITY } from "@traycer-clients/shared/test-fixtures/client-identity";
import {
  emptyStreamRegistry,
  FakeRelayHost,
} from "@traycer-clients/shared/host-transport/remote/__tests__/fake-relay-host";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import {
  getNegotiatedHostMethodVersion,
  recordNegotiatedHostManifest,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  poolHostDirectoryEntry,
  POOL_HOST_ID,
  type HostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { ConnectionManifest } from "@traycer/protocol/framework/index";
import type { CommentThreadWire } from "@traycer/protocol/host/epic/unary-schemas";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { RemoteHostDirectoryEntry } from "@traycer-clients/shared/host-client/remote-fetcher";
import { EpicShell } from "@/components/epic-canvas/epic-shell";
import { CommentThreadCard } from "@/components/comments/comment-thread-card";
import { WindowHostModalHost } from "@/components/layout/dialogs/window-host-modal-host";
import { HostReadinessControllerContext } from "@/components/layout/host-readiness-controller-context";
import type {
  DefaultHostReadinessPresentation,
  HostReadinessController,
} from "@/components/layout/host-readiness-controller-context";
import { setMobileApp } from "@/lib/mobile-app";
import { useHostDoorStateStore } from "@/stores/host/host-door-state-store";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TestEpicSessionTab } from "@/lib/registries/test-support/test-epic-session-tab";
import { setTestEpicSessionHostClientResolver } from "@/lib/registries/test-support/epic-session-controller-test-support";
import { getEpicSessionController } from "@/lib/registries/epic-session-controller";
import { __getOpenEpicRegistryForTests } from "@/lib/registries/epic-session-registry";
import {
  __setEpicRuntimeWorkerFactoryForTests,
  getEpicRuntimeWorkerFactoryOverride,
} from "@/lib/registries/epic-runtime-worker-factory-slot";
import {
  createInProcessEpicRuntimeWorker,
  createProxiedInProcessEpicRuntimeWorker,
} from "@/stores/epics/open-epic/test-support/in-process-epic-runtime-worker";
import type { RuntimeWorkerLike } from "@/stores/epics/open-epic/runtime/worker/spawn-epic-runtime-worker";
import {
  clearSessionCreatedEpics,
  markEpicCreatedThisSession,
} from "@/lib/epics/session-created-epics";
import { resetFakeDurableStreamTransports } from "@/lib/host/test-support/fake-durable-stream-transport";
import type { AttributableDurableStreamTransport } from "@/lib/host/durable-stream-transport";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useSelectionAuthorityStore } from "@/stores/host/selection-authority-store";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useTaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import { useArtifactObjectTextQuery } from "@/hooks/files/use-artifact-object-text-query";
import { useEpicCreateArtifact } from "@/hooks/epic/use-epic-node-mutations";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import {
  composerEditorAt,
  typeIntoEditor,
} from "@/components/comments/__tests__/comment-submit-test-support";
import {
  assertTestFixture,
  FakePoolEndpoint,
  sendPoolTaskSnapshots,
} from "@/lib/registries/test-support/epic-session-pool-test-support";
import { ESTABLISHING_DEADLINE_MS } from "@/lib/host/bounded-load-budgets";

const EPIC_ID = "epic-older-host";
const TAB_ID = "epic-older-host-tab";
const WINDOW_HOST_ID = "window-host";
const TAB_HOST_ID = "tab-host";
const USER_ID = "user-older-host";
const RELAY_URL = "wss://relay.test/attach";
const ARTIFACT_SHA256 = "a".repeat(64);
type PoolTransportOpener = (
  hostId: string,
) => AttributableDurableStreamTransport;

const ORIGINAL_TASK_THREAD: CommentThreadWire = {
  threadId: "original-host-thread",
  resolved: false,
  createdAt: 1,
  comments: [
    {
      commentId: "original-host-comment",
      content: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Task note" }],
          },
        ],
      },
      createdAt: 1,
      updatedAt: null,
      author: { userId: USER_ID, fallbackHandle: "viewer" },
    },
  ],
  data: { createdByUserId: USER_ID, quotedText: "Task note" },
};

const seams = vi.hoisted(() => ({
  minimumHostVersion: "0.0.0",
  effectiveHostId: "window-host",
  rows: new Map<string, unknown>(),
  openAttempts: [] as string[],
  carriedHostIds: [] as string[],
  openedSettings: [] as unknown[],
  showSessionConsumers: false,
  showRequestClientProbe: false,
  showRealConnectionPill: false,
  showDraftPane: false,
  poolTransportOpener: null as PoolTransportOpener | null,
}));

vi.mock(
  "@/components/epic-canvas/panels/epic-connection-pill",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/components/epic-canvas/panels/epic-connection-pill")
      >();
    return {
      ...actual,
      EpicConnectionPill: (
        props: Parameters<typeof actual.EpicConnectionPill>[0],
      ) =>
        seams.showRealConnectionPill ? (
          <actual.EpicConnectionPill {...props} />
        ) : null,
    };
  },
);

vi.mock(
  "@traycer-clients/shared/host-client/minimum-host-version",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/minimum-host-version")
      >();
    return {
      ...actual,
      get MINIMUM_HOST_VERSION(): string {
        return seams.minimumHostVersion;
      },
    };
  },
);

const hostClient = vi.hoisted(() => ({
  createRequesterForHostId: (_hostId: string | null) => hostClient,
  getActiveHostId: () => "host-test",
  getActiveHost: () => null,
  getRequestContextUserId: (): string | null => "user-older-host",
  getRequestContext: () => null,
  onChange: () => () => undefined,
  onBearerRotated: (_listener: () => void) => () => undefined,
  onCloudVerdictChanged: (_listener: () => void) => () => undefined,
  notifyHostAvailabilityRecovered: (_hostId: string, _kind: string) =>
    undefined,
  request: () => Promise.resolve({ tasks: [], hasMore: false }),
}));

const directory = vi.hoisted(() => ({
  findById: (hostId: string): unknown =>
    seams.rows.get(hostId) ?? {
      hostId,
      label: hostId,
      kind: "remote",
      websocketUrl: "wss://relay.test/attach",
      version: "1.0.0",
      transportDialability: "dialable",
      publicKey: "pubkey-default",
      owner: null,
      relayFuseGrace: false,
      sandbox: null,
      remoteStatus: {
        connectivity: "connectable",
        viewerReachability: "ok",
        clientCloud: "ok",
        updateState: "current",
        appVersion: null,
        lastSeenAt: null,
      },
    },
  getLocalEntry: (): null => null,
  onChange: (_listener: () => void) => ({ dispose: () => undefined }),
  hasConcludedDiscovery: () => true,
  hasFailedDiscovery: () => false,
  getLocalHostId: (): string | null => null,
}));

vi.mock("@/lib/host", () => ({
  useHostClient: () => hostClient,
  useHostRuntimeClient: () => hostClient,
  useOptionalHostClient: () => hostClient,
  useHostBinding: () => ({ hostClient, directory }),
  useHostDirectory: () => directory,
  useAuthService: () => ({
    revalidateCurrentContext: () => Promise.resolve({ kind: "valid" }),
  }),
}));

const sessionHostClients = vi.hoisted(() => new Map<string, object>());
vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: (hostId: string | null) => {
    if (hostId === null) return null;
    const known = sessionHostClients.get(hostId);
    if (known !== undefined) return known;
    const created = {
      request: vi.fn(),
      getActiveHost: () => seams.rows.get(hostId) ?? null,
      getActiveHostId: () => hostId,
      getRequestContextUserId: () => "user-older-host",
    };
    sessionHostClients.set(hostId, created);
    return created;
  },
}));

vi.mock("@/hooks/host/use-effective-host-id", () => ({
  useEffectiveHostId: () => seams.effectiveHostId,
}));

vi.mock("@/hooks/host/use-selection-authority-attached", () => ({
  useSelectionAuthorityAttached: () => true,
}));

vi.mock("@/providers/use-runner-host", async () => {
  const { MockRunnerHost } =
    await import("@traycer-clients/shared/host-client/mock/mock-runner-host");
  const runnerHost = new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: null,
  });
  return {
    useRunnerHost: () => runnerHost,
    useRunnerHostOrNull: () => runnerHost,
  };
});

vi.mock(
  "@traycer-clients/shared/host-transport/remote/index",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-transport/remote/index")
      >();
    const { fakeDurableStreamTransports: fakes } =
      await import("@/lib/host/test-support/fake-durable-stream-transport");
    return {
      ...actual,
      createRemoteHostTransport: (options: { readonly hostId: string }) => ({
        session: { start: () => undefined },
        streamClient: fakes().opener(options.hostId).wsStreamClient,
      }),
    };
  },
);

vi.mock("@/lib/host/use-durable-stream-transport", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/lib/host/use-durable-stream-transport")
    >();
  const { useMemo } = await import("react");
  return {
    ...actual,
    useDurableStreamTransportFactory: () => {
      const real = actual.useDurableStreamTransportFactory();
      return useMemo(
        () => (hostId: string) => {
          seams.openAttempts.push(hostId);
          if (hostId === POOL_HOST_ID && seams.poolTransportOpener !== null) {
            return seams.poolTransportOpener(hostId);
          }
          return real(hostId);
        },
        [real],
      );
    },
  };
});

vi.mock(
  "@/components/settings/host-scope/carry-viewed-host-into-settings",
  () => ({
    carryViewedHostIntoSettingsScope: (hostId: string) => {
      seams.carriedHostIds.push(hostId);
    },
  }),
);
vi.mock("@/stores/tabs/use-system-tab-modal", () => ({
  useSystemTabModalActions: () => ({
    openSettings: (target: unknown) => {
      seams.openedSettings.push(target);
    },
  }),
}));

vi.mock("@/components/epic-canvas/chat-stream-prewarm", () => ({
  ChatStreamPrewarm: () => null,
}));
vi.mock("@/hooks/epic/use-epic-title-mutation", () => ({
  useEpicUpdateTitle: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
    isError: false,
    error: null,
    reset: vi.fn(),
    data: undefined,
    variables: undefined,
  }),
}));
vi.mock("@/components/epic-canvas/panels/epic-connection-toasts", () => ({
  EpicConnectionToasts: () => null,
}));
vi.mock(
  "@/hooks/terminal/use-plain-terminal-authority",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/terminal/use-plain-terminal-authority")
      >();
    const { useQuery } = await import("@tanstack/react-query");
    return {
      ...actual,
      useHostPlainTerminalAuthority: (
        args: Parameters<typeof actual.useHostPlainTerminalAuthority>[0],
      ) => ({
        hostId: args.hostId,
        scope: args.scope,
        capability: { status: "unknown" as const },
        collection: undefined,
        terminals: [],
        coverage: null,
        servingHostId: null,
        canMutate: false,
        query: useQuery({
          queryKey: ["plain-terminal-authority", args.hostId, args.scope],
          queryFn: () => Promise.resolve(undefined),
          enabled: false,
        }),
      }),
    };
  },
);
vi.mock("@/hooks/agent/use-agent-activity-presence-degraded", () => ({
  useAgentActivityPresenceDegraded: () => null,
}));
vi.mock("@/components/epic-canvas/canvas/tile-canvas", async () => {
  const { useState: useLocalState } = await import("react");
  return {
    TileCanvas: () => {
      const [draft, setDraft] = useLocalState("");
      return (
        <div data-testid="tile-canvas-stub">
          {seams.showDraftPane ? (
            <textarea
              aria-label="Pane draft"
              value={draft}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          ) : null}
        </div>
      );
    },
  };
});
vi.mock("@/providers/resources-stream-mount", () => ({
  EpicResourcesFallbackMount: () => null,
}));

function remoteRow(
  hostId: string,
  appVersion: string,
): RemoteHostDirectoryEntry {
  return {
    hostId,
    label: hostId,
    kind: "remote",
    websocketUrl: RELAY_URL,
    version: "1.0.0",
    transportDialability: "dialable",
    publicKey: "pubkey-tab",
    owner: null,
    relayFuseGrace: false,
    sandbox: null,
    remoteStatus: {
      connectivity: "connectable",
      viewerReachability: "ok",
      clientCloud: "ok",
      updateState: "current",
      appVersion,
      lastSeenAt: null,
    },
  };
}

function OriginalTaskSessionConsumers(): ReactNode {
  const sessionHostId = useEpicSessionHostId();
  const sessionClient = useEpicSessionHostClient();
  const taskHosts = useTaskHostsView(EPIC_ID);
  const artifact = useArtifactObjectTextQuery(sessionHostId ?? "", {
    epicId: EPIC_ID,
    sha256: ARTIFACT_SHA256,
  });
  const createArtifact = useEpicCreateArtifact();
  const [createResult, setCreateResult] = useState("idle");

  return (
    <section>
      <span data-testid="original-session-host">{sessionHostId}</span>
      <span data-testid="original-task-tree-view">{taskHosts.kind}</span>
      <span data-testid="original-artifact-read">
        {artifact.data?.kind === "text" ? artifact.data.text : "pending"}
      </span>
      <button
        type="button"
        onClick={() => {
          void createArtifact
            .mutateAsync({
              epicId: EPIC_ID,
              parentId: null,
              artifactType: "canvas",
              title: "Original host canvas",
            })
            .then(
              () => setCreateResult("sent"),
              () => setCreateResult("refused"),
            );
        }}
      >
        Create canvas on this task
      </button>
      <span data-testid="original-task-action-result">{createResult}</span>
      {sessionClient === null ? null : (
        <CommentThreadCard
          epicId={EPIC_ID}
          hostClient={sessionClient}
          artifactType="spec"
          artifactId="original-host-artifact"
          thread={ORIGINAL_TASK_THREAD}
          currentUserId={USER_ID}
          canModerate={false}
          isExpanded
          hasAnchor
          onExpandedChange={() => undefined}
          onActivateAnchor={() => undefined}
        />
      )}
    </section>
  );
}

const observedSessionClients: unknown[] = [];

function SessionRequestClientProbe(): ReactNode {
  const sessionHostId = useEpicSessionHostId();
  const sessionClient = useEpicSessionHostClient();
  useEffect(() => {
    observedSessionClients.push(sessionClient);
  }, [sessionClient]);
  return (
    <>
      <span data-testid="current-session-host">{sessionHostId}</span>
      <span data-testid="current-session-client-host">
        {sessionClient?.getActiveHostId() ?? "none"}
      </span>
    </>
  );
}

let previousWorkerFactory: (() => RuntimeWorkerLike) | null = null;
let routedTaskHostClient: HostClient<HostRpcRegistry> | null = null;
let originalTaskRemoteSession: RemoteSession<
  HostRpcRegistry,
  typeof emptyStreamRegistry
> | null = null;
let taskConsumerQueryClient: QueryClient | null = null;

class RecordingRemoteHostMessenger extends RemoteHostMessenger<
  HostRpcRegistry,
  typeof emptyStreamRegistry
> {
  readonly routedCalls: Array<{
    readonly method: string;
    readonly hostId: string;
    readonly requiredHostMethodVersion: HostRequestOptions["requiredHostMethodVersion"];
  }> = [];

  override request<Method extends keyof HostRpcRegistry & string>(
    method: Method,
    params: RequestOfMethod<HostRpcRegistry, Method>,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
    this.record(method, options);
    return super.request(method, params, options);
  }

  override requestWithResponseTimeout<
    Method extends keyof HostRpcRegistry & string,
  >(
    method: Method,
    params: RequestOfMethod<HostRpcRegistry, Method>,
    responseTimeoutMs: number,
    options: HostRequestOptions,
  ): Promise<ResponseOfMethod<HostRpcRegistry, Method>> {
    this.record(method, options);
    return super.requestWithResponseTimeout(
      method,
      params,
      responseTimeoutMs,
      options,
    );
  }

  private record(method: string, options: HostRequestOptions): void {
    this.routedCalls.push({
      method,
      hostId: options.authority.endpoint.hostId,
      requiredHostMethodVersion: options.requiredHostMethodVersion,
    });
  }
}

const emitRowChanged = vi.hoisted(() => ({ run: () => undefined }));

interface InstalledStreams {
  readonly opened: () => number;
  readonly currentIndex: () => number;
  readonly closed: () => number;
  readonly deliverSnapshot: (index: number) => void;
  readonly setStatus: (
    index: number,
    status: Parameters<EpicStreamCallbacks["onConnectionStatus"]>[0],
  ) => void;
}

function installStreams(): InstalledStreams {
  let opened = 0;
  let closed = 0;
  const callbacks: EpicStreamCallbacks[] = [];
  previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createInProcessEpicRuntimeWorker({
      streamClientFactory: (_epicId, streamCallbacks) => {
        opened += 1;
        callbacks.push(streamCallbacks);
        return {
          applyUpdate: () => undefined,
          awareness: () => undefined,
          applyArtifactRoomUpdate: () => undefined,
          artifactRoomAwareness: () => undefined,
          retryMigration: () => undefined,
          close: () => {
            closed += 1;
          },
        };
      },
      laneSelection: null,
    }).createWorker(),
  );
  return {
    opened: () => opened,
    currentIndex: () => {
      const index = callbacks.length - 1;
      if (index < 0) throw new Error("expected an installed epic stream");
      return index;
    },
    closed: () => closed,
    deliverSnapshot: (index) => {
      const stream = callbacks.at(index);
      if (stream === undefined) throw new Error("expected that stream");
      const meta: SnapshotMetaEpic = {
        schemaVersion: "2.0.0",
        roomId: "room-older-host",
        epicLight: null,
        permissionRole: "editor",
        repos: [],
        workspaces: [],
        repoMapping: [],
        workspaceFolders: [],
        unresolvedRepos: [],
        hostStateVectorBase64: "AA==",
      };
      act(() => {
        stream.onConnectionStatus("open", null, false, null);
        stream.onSnapshot(meta, new Uint8Array([0, 0]));
      });
    },
    setStatus: (index, status) => {
      const stream = callbacks.at(index);
      if (stream === undefined) throw new Error("expected that stream");
      stream.onConnectionStatus(status, null, false, null);
    },
  };
}

function installPoolEndpoint(endpoint: FakePoolEndpoint): void {
  const entry = poolHostDirectoryEntry(endpoint.url);
  assertTestFixture(entry, "expected a pool directory row");
  seams.rows.set(POOL_HOST_ID, entry);
  act(() => emitRowChanged.run());
  sessionHostClients.set(POOL_HOST_ID, {
    request: vi.fn(),
    getActiveHost: () => entry,
    getActiveHostId: () => POOL_HOST_ID,
    getRequestContextUserId: () => USER_ID,
  });
  const bearerSource = {
    identity: { userId: USER_ID },
    getBearerToken: () => "pool-shell-test-bearer",
  };
  seams.poolTransportOpener = (hostId) => {
    if (hostId !== POOL_HOST_ID) {
      throw new Error("the pool fake only opens the pool host");
    }
    return endpoint.openTransport(USER_ID, () => bearerSource).durableTransport;
  };
  __setEpicRuntimeWorkerFactoryForTests(() =>
    createProxiedInProcessEpicRuntimeWorker().createWorker(),
  );
}

function publishTabRow(appVersion: string): void {
  seams.rows.set(TAB_HOST_ID, remoteRow(TAB_HOST_ID, appVersion));
  act(() => {
    emitRowChanged.run();
  });
}

function installRows(): void {
  const listeners = new Set<() => void>();
  installHostConnectionRegistrySource({
    directory: {
      findById: (hostId) => (directory.findById(hostId) ?? null) as never,
      onDirectoryChanged: (listener) => {
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      },
    },
    leases: null,
  });
  emitRowChanged.run = () => {
    for (const listener of [...listeners]) listener();
  };
}

const EMPTY_PRESENTATION: DefaultHostReadinessPresentation = {
  targetKind: "unknown",
  localBootIntent: false,
  localHostState: "unknown",
  stage: "loading",
  progress: null,
  lastProgress: null,
  provisioningError: null,
  ensureFailure: null,
  provisioning: false,
  removed: false,
  hostBusy: false,
  canManageHost: false,
  retryProvisioning: () => undefined,
  forceProvisioning: () => undefined,
  reinstall: () => undefined,
  configureShell: () => undefined,
  refreshDirectory: () => undefined,
  openSettings: () => undefined,
  compatibility: {
    status: "compatible",
    degraded: false,
    unreachable: false,
    hostStatus: null,
  },
};

const READY_CONTROLLER: HostReadinessController = {
  readinessFor: () => ({ kind: "ready" }),
  defaultHostPresentation: EMPTY_PRESENTATION,
  hasBeenDefaultHostReady: true,
};

function renderTabOnTheWindowsComputer(): void {
  seams.effectiveHostId = TAB_HOST_ID;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  // Served before, so the drop below the floor reads as a computer that stopped
  // being usable, not a first launch.
  act(() => {
    useSelectionAuthorityStore.getState().applyKernelSnapshot({
      attached: true,
      preferredHostId: null,
      targetHostId: TAB_HOST_ID,
      effectiveHostId: TAB_HOST_ID,
      servingPeer: { kind: "computer", hostId: TAB_HOST_ID },
      noPeerPresentation: null,
      leases: [{ hostId: TAB_HOST_ID, status: "ready", dead: null }],
      selectionRevision: 1,
    });
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <HostReadinessControllerContext.Provider value={READY_CONTROLLER}>
          <TestEpicSessionTab epicId={EPIC_ID} tabId={TAB_ID}>
            <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
          </TestEpicSessionTab>
          <WindowHostModalHost bypassed={false} />
        </HostReadinessControllerContext.Provider>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderTabOnAnotherComputer(seededOnTabComputer: boolean): void {
  if (seededOnTabComputer) markEpicCreatedThisSession(EPIC_ID, TAB_HOST_ID);
  else seams.effectiveHostId = TAB_HOST_ID;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TestEpicSessionTab epicId={EPIC_ID} tabId={TAB_ID}>
          <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
        </TestEpicSessionTab>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

function renderFollowingTab(queryClient: QueryClient): {
  readonly moveTo: (hostId: string) => void;
  readonly mountSessionConsumers: () => void;
} {
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <TestEpicSessionTab epicId={EPIC_ID} tabId={TAB_ID}>
          <>
            <EpicShell epicId={EPIC_ID} tabId={TAB_ID} active />
            {seams.showSessionConsumers ? (
              <OriginalTaskSessionConsumers />
            ) : null}
            {seams.showRequestClientProbe ? (
              <SessionRequestClientProbe />
            ) : null}
          </>
        </TestEpicSessionTab>
      </TooltipProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    moveTo: (hostId) => {
      seams.effectiveHostId = hostId;
      act(() => {
        view.rerender(tree());
      });
    },
    mountSessionConsumers: () => {
      seams.showSessionConsumers = true;
      act(() => {
        view.rerender(tree());
      });
    },
  };
}

async function waitForTaskShown(): Promise<void> {
  await waitFor(() => {
    expect(screen.getByTestId("tile-canvas-stub")).toBeTruthy();
  });
}

describe("a task tab whose computer falls below the minimum host version", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    previousWorkerFactory = getEpicRuntimeWorkerFactoryOverride();
    seams.minimumHostVersion = "2.0.0";
    seams.rows.clear();
    seams.openAttempts.length = 0;
    seams.carriedHostIds.length = 0;
    seams.openedSettings.length = 0;
    seams.showSessionConsumers = false;
    seams.showRequestClientProbe = false;
    seams.showRealConnectionPill = false;
    seams.showDraftPane = false;
    seams.poolTransportOpener = null;
    observedSessionClients.length = 0;
    sessionHostClients.clear();
    routedTaskHostClient = null;
    originalTaskRemoteSession = null;
    taskConsumerQueryClient = null;
    resetNegotiatedManifests();
    resetHostConnectionRegistryForTest();
    resetFakeDurableStreamTransports();
    clearSessionCreatedEpics();
    __getOpenEpicRegistryForTests().disposeAll();
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: USER_ID, userName: USER_ID, email: USER_ID },
      contextMetadata: { userId: USER_ID, username: USER_ID },
    });
    setTestEpicSessionHostClientResolver((hostId) => {
      const resolved = sessionHostClients.get(hostId) ?? null;
      if (resolved !== null) return resolved as never;
      return null;
    });
    installRows();
    for (const hostId of [WINDOW_HOST_ID, TAB_HOST_ID]) {
      sessionHostClients.set(hostId, {
        request: vi.fn(),
        getActiveHost: () => seams.rows.get(hostId) ?? null,
        getActiveHostId: () => hostId,
        getRequestContextUserId: () => USER_ID,
      });
    }
  });

  afterEach(() => {
    cleanup();
    originalTaskRemoteSession?.close();
    originalTaskRemoteSession = null;
    routedTaskHostClient?.dispose();
    routedTaskHostClient = null;
    taskConsumerQueryClient?.clear();
    taskConsumerQueryClient = null;
    __getOpenEpicRegistryForTests().disposeAll();
    __setEpicRuntimeWorkerFactoryForTests(previousWorkerFactory);
    clearSessionCreatedEpics();
    seams.minimumHostVersion = "0.0.0";
    seams.poolTransportOpener = null;
    vi.useRealTimers();
    useSelectionAuthorityStore.getState().reset();
    useHostDoorStateStore.setState({ byHost: new Map() });
    seams.effectiveHostId = WINDOW_HOST_ID;
    resetNegotiatedManifests();
    setMobileApp(false);
  });

  it("shows Host update needed and Update now alone when the tab's original host is the computer below the floor", async () => {
    installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer(true);
    await waitForTaskShown();

    publishTabRow("1.5.4");

    const card = await screen.findByTestId("epic-repoint-failure");
    expect(within(card).getByText("Host update needed")).toBeTruthy();
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Update now"]);
    expect(within(card).queryByText(/Retry/)).toBeNull();
    expect(screen.queryByText(/Couldn't load this task/)).toBeNull();
    expect(screen.queryByTestId("tile-canvas-stub")).toBeNull();
  });

  it("shows Update now alone when the tab never had a session to go back to", async () => {
    installStreams();
    publishTabRow("1.5.4");

    renderTabOnAnotherComputer(false);

    const card = await screen.findByTestId("epic-repoint-failure");
    expect(within(card).getByText("Host update needed")).toBeTruthy();
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Update now"]);
    expect(within(card).queryByText(/Retry/)).toBeNull();
  });

  it("keeps Open on original host for a tab re-pointed away, and it goes back there", async () => {
    const streams = installStreams();
    const originalEntry = remoteRow(WINDOW_HOST_ID, "2.0.0");
    const servingEntry = remoteRow(TAB_HOST_ID, "2.0.0");
    seams.rows.set(WINDOW_HOST_ID, originalEntry);
    seams.rows.set(TAB_HOST_ID, servingEntry);
    const poolEntry = poolHostDirectoryEntry("wss://pool.test/rpc");
    if (poolEntry === null) throw new Error("pool fixture must build");
    const originalManifest = {
      "epic.listTaskHosts": { major: 1, minor: 0 },
      "epic.readArtifactObject": { major: 1, minor: 0 },
      "epic.listCollaborators": { major: 1, minor: 0 },
      "epic.replyToCommentThread": { major: 1, minor: 0 },
      "epic.createArtifact": { major: 1, minor: 0 },
    } satisfies ConnectionManifest;
    const servingManifest = {
      ...originalManifest,
      "epic.createArtifact": { major: 1, minor: 1 },
    } satisfies ConnectionManifest;
    recordNegotiatedHostManifest(TAB_HOST_ID, servingManifest);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    taskConsumerQueryClient = queryClient;
    const relay = new FakeRelayHost();
    const releasedFloorMethods = new Set(RELEASED_FLOOR_METHOD_NAMES);
    const currentHostManifest = buildConnectionManifest(
      hostRpcRegistry,
      SERVES_EVERY_INSTALLED_MAJOR,
    );
    const floorManifest: Record<string, { major: number; minor: number }> = {};
    const optionalManifest: Record<string, { major: number; minor: number }> =
      {};
    for (const [method, version] of Object.entries(currentHostManifest)) {
      if (releasedFloorMethods.has(method)) {
        floorManifest[method] =
          method === "epic.createArtifact" ? { major: 1, minor: 0 } : version;
      } else {
        optionalManifest[method] = version;
      }
    }
    relay.floorRpcManifest = floorManifest;
    relay.optionalRpcManifest = optionalManifest;
    relay.unaryResponseFor = ({ method }) => {
      const result = {
        "epic.listTaskHosts": { hosts: [] },
        "epic.readArtifactObject": {
          kind: "text",
          text: "Original host artifact body",
          mediaType: "text/plain",
          networkPolicy: "open",
        },
        "epic.listCollaborators": {
          collaborators: [],
          collaboratorsAvailable: true,
        },
        "epic.replyToCommentThread": { ok: true },
      }[method];
      return { result: result ?? relay.unaryResult, error: null };
    };
    const lease = new MutableBearerLease("original-host-token", USER_ID);
    let remoteRequestId = 0;
    originalTaskRemoteSession = new RemoteSession({
      hostId: WINDOW_HOST_ID,
      attachBaseUrl: RELAY_URL,
      hostStaticPublicKey: relay.hostStaticPublicKey,
      grantProvider: () =>
        Promise.resolve({
          kind: "ok" as const,
          grant: { grant: "grant-jws", expiresInSeconds: 300 },
        }),
      hostToken: () => lease.getBearerToken(),
      auth: null,
      door: null,
      clock: null,
      livenessProbe: null,
      rpcRegistry: hostRpcRegistry,
      streamRegistry: emptyStreamRegistry,
      webSocketFactory: relay.factory,
      requestId: () => `original-host-${String((remoteRequestId += 1))}`,
      evidence: NO_TRANSPORT_EVIDENCE,
      clientIdentity: TEST_CLIENT_IDENTITY,
    });
    originalTaskRemoteSession.start();
    await waitFor(() => {
      expect(originalTaskRemoteSession?.isReady()).toBe(true);
    });
    const messenger = new RecordingRemoteHostMessenger(
      originalTaskRemoteSession,
    );
    const entries = new Map<string, HostDirectoryEntry>([
      [WINDOW_HOST_ID, originalEntry],
      [TAB_HOST_ID, servingEntry],
      [poolEntry.hostId, poolEntry],
    ]);
    routedTaskHostClient = new HostClient<HostRpcRegistry>({
      registry: hostRpcRegistry,
      invalidator: createHostQueryInvalidator(queryClient),
      findHostById: (hostId) => entries.get(hostId) ?? null,
      messenger,
      routing: {
        plan: createHostRpcTierPlan(poolEntry),
        selectedHostId: () => TAB_HOST_ID,
        serving: (): HostServingDecision => ({
          servingPeer: servingEntry,
          servingPeerMethods: new Set(Object.keys(servingManifest)),
          servingPeerEnvironmentId: null,
        }),
      },
    });
    routedTaskHostClient.setRequestContext(
      createRequestContextFixture({
        origin: "renderer",
        bearerToken: "original-host-token",
        identity: {
          userId: USER_ID,
          username: USER_ID,
          providerHandle: USER_ID,
        },
      }),
    );
    publishTabRow("2.0.0");
    seams.effectiveHostId = WINDOW_HOST_ID;
    const view = renderFollowingTab(queryClient);
    await waitFor(() => {
      expect(streams.opened()).toBe(1);
    });
    streams.deliverSnapshot(0);
    await waitForTaskShown();
    view.moveTo(TAB_HOST_ID);
    await waitFor(() => {
      expect(streams.opened()).toBe(2);
    });
    streams.deliverSnapshot(1);
    await waitFor(() => {
      expect(streams.closed()).toBe(1);
    });
    publishTabRow("1.5.4");

    const card = await screen.findByTestId("epic-repoint-failure");
    expect(
      within(card)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Update now", "Open on original host"]);

    sessionHostClients.set(
      WINDOW_HOST_ID,
      routedTaskHostClient.createRequesterForHostId(WINDOW_HOST_ID),
    );
    sessionHostClients.set(
      TAB_HOST_ID,
      routedTaskHostClient.createRequesterForHostId(TAB_HOST_ID),
    );

    fireEvent.click(
      within(card).getByRole("button", { name: "Open on original host" }),
    );

    await waitForTaskShown();
    expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
    expect(seams.openAttempts.at(-1)).toBe(WINDOW_HOST_ID);
    expect(seams.effectiveHostId).toBe(TAB_HOST_ID);
    view.mountSessionConsumers();
    await waitFor(() => {
      expect(screen.getByTestId("original-session-host").textContent).toBe(
        WINDOW_HOST_ID,
      );
      expect(screen.getByTestId("original-task-tree-view").textContent).toBe(
        "none",
      );
      expect(screen.getByTestId("original-artifact-read").textContent).toBe(
        "Original host artifact body",
      );
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Create canvas on this task" }),
    );
    await waitFor(() => {
      expect(
        screen.getByTestId("original-task-action-result").textContent,
      ).toBe("refused");
    });
    expect(
      getNegotiatedHostMethodVersion(WINDOW_HOST_ID, "epic.createArtifact"),
    ).toEqual({ major: 1, minor: 0 });
    expect(
      relay.unaryRequests.filter(
        (request) => request.method === "epic.createArtifact",
      ),
    ).toEqual([]);
    expect(
      messenger.routedCalls.filter(
        (call) => call.method === "epic.createArtifact",
      ),
    ).toEqual([
      {
        method: "epic.createArtifact",
        hostId: WINDOW_HOST_ID,
        requiredHostMethodVersion: {
          method: "epic.createArtifact",
          version: { major: 1, minor: 1 },
        },
      },
    ]);

    await screen.findByRole("button", { name: /^Reply/ });
    typeIntoEditor(composerEditorAt(0), "reply on the original task");
    fireEvent.click(screen.getByRole("button", { name: /^Reply/ }));
    await waitFor(() => {
      expect(
        messenger.routedCalls.filter(
          (call) => call.method === "epic.replyToCommentThread",
        ),
      ).toHaveLength(1);
    });

    for (const method of [
      "epic.listTaskHosts",
      "epic.readArtifactObject",
      "epic.replyToCommentThread",
    ]) {
      expect(
        messenger.routedCalls
          .filter((call) => call.method === method)
          .map((call) => call.hostId),
      ).toEqual([WINDOW_HOST_ID]);
      expect(
        relay.unaryRequests.filter((request) => request.method === method),
      ).toHaveLength(1);
    }
  });

  it.each(["fresh", "held"] as const)(
    "shows the pool timeout over a mounted pane only when one was already loaded (%s open)",
    async (kind) => {
      const endpoint = new FakePoolEndpoint(
        "wss://pool.test/task-before-snapshot",
        { omittedStreamMethods: [], acknowledgeOpen: true },
      );
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      taskConsumerQueryClient = queryClient;
      seams.showDraftPane = kind === "held";
      seams.showRequestClientProbe = true;
      let computerStreams: InstalledStreams | null = null;

      if (kind === "held") {
        seams.effectiveHostId = WINDOW_HOST_ID;
        computerStreams = installStreams();
      } else {
        seams.effectiveHostId = POOL_HOST_ID;
        installPoolEndpoint(endpoint);
      }

      const view = renderFollowingTab(queryClient);
      const controller = getEpicSessionController();
      const registry = __getOpenEpicRegistryForTests();
      let outgoingHandle = registry.peek(EPIC_ID);
      let outgoingRequestClient: unknown = null;

      if (kind === "held") {
        assertTestFixture(
          computerStreams,
          "expected the source computer stream",
        );
        await waitFor(() => expect(computerStreams.opened()).toBe(1));
        computerStreams.deliverSnapshot(0);
        await waitForTaskShown();
        fireEvent.change(screen.getByRole("textbox", { name: "Pane draft" }), {
          target: { value: "keep this pane draft" },
        });
        await waitFor(() => {
          expect(
            screen.getByTestId("current-session-client-host").textContent,
          ).toBe(WINDOW_HOST_ID);
        });
        outgoingHandle = registry.peek(EPIC_ID);
        assertTestFixture(
          outgoingHandle,
          "expected the loaded computer handle",
        );
        outgoingRequestClient = observedSessionClients.at(-1);
        expect(outgoingRequestClient).not.toBeNull();
        installPoolEndpoint(endpoint);
        view.moveTo(POOL_HOST_ID);
      }

      await waitFor(() => {
        const socket = endpoint.sockets.at(0);
        assertTestFixture(socket, "expected the initial pool socket");
        expect(socket.subscriptions.map(({ method }) => method)).toEqual(
          expect.arrayContaining([
            "epic.status.subscribe",
            "epic.state.subscribe",
          ]),
        );
      });
      const lostSocket = endpoint.sockets.at(0);
      assertTestFixture(lostSocket, "expected the initial pool socket");
      lostSocket.closeFromServer();
      expect(lostSocket.serverClosed).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(ESTABLISHING_DEADLINE_MS);
      });
      const card = await screen.findByTestId("epic-repoint-failure");
      expect(
        within(card).getByText("Couldn't load this task from Traycer cloud."),
      ).toBeTruthy();
      expect(
        within(card)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(
        kind === "held" ? ["Retry", "Open on original host"] : ["Retry"],
      );

      if (kind === "fresh") {
        expect(screen.queryByTestId("tile-canvas-stub")).toBeNull();
      } else {
        expect(outgoingHandle).not.toBeNull();
        expect(registry.peek(EPIC_ID)).toBe(outgoingHandle);
        const pane = screen.getByTestId("tile-canvas-stub");
        const paneGate = pane.parentElement;
        assertTestFixture(paneGate, "expected the task pane gate");
        expect(paneGate.getAttribute("data-epic-repoint-read-only")).toBe(
          "true",
        );
        expect(paneGate.hasAttribute("inert")).toBe(true);
        expect(
          (paneGate.compareDocumentPosition(card) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
            0,
        ).toBe(true);
        expect(card.parentElement?.classList.contains("z-50")).toBe(true);
        expect(
          screen.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Pane draft",
          }).value,
        ).toBe("keep this pane draft");
        expect(screen.getByTestId("current-session-host").textContent).toBe(
          WINDOW_HOST_ID,
        );
        expect(
          screen.getByTestId("current-session-client-host").textContent,
        ).toBe(WINDOW_HOST_ID);
        expect(observedSessionClients.at(-1)).toBe(outgoingRequestClient);
      }

      const subscriptionsAtFailure = endpoint.sockets.reduce(
        (count, socket) => count + socket.subscriptions.length,
        0,
      );
      fireEvent.click(within(card).getByRole("button", { name: "Retry" }));
      await waitFor(() => {
        const totalSubscriptions = endpoint.sockets.reduce(
          (count, socket) => count + socket.subscriptions.length,
          0,
        );
        expect(totalSubscriptions).toBeGreaterThan(subscriptionsAtFailure);
        const retrySocket = endpoint.sockets.at(-1);
        assertTestFixture(retrySocket, "expected the retried pool socket");
        expect(retrySocket.subscriptions.map(({ method }) => method)).toEqual(
          expect.arrayContaining([
            "epic.status.subscribe",
            "epic.state.subscribe",
          ]),
        );
      });
      const retrySocket = endpoint.sockets.at(-1);
      assertTestFixture(retrySocket, "expected the retried pool socket");
      sendPoolTaskSnapshots(retrySocket, "retry-authority", "Retry task");
      await waitFor(() => {
        const currentHandle = registry.peek(EPIC_ID);
        expect(currentHandle).not.toBeNull();
        if (kind === "held") {
          expect(currentHandle).not.toBe(outgoingHandle);
        }
        expect(
          controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
        ).toBe("ready");
      });
      expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
      expect(screen.getByTestId("tile-canvas-stub")).toBeTruthy();
      if (kind === "held") {
        expect(
          screen.getByRole<HTMLTextAreaElement>("textbox", {
            name: "Pane draft",
          }).value,
        ).toBe("keep this pane draft");
      }
      expect(screen.getByTestId("current-session-host").textContent).toBe(
        POOL_HOST_ID,
      );
      expect(
        screen.getByTestId("current-session-client-host").textContent,
      ).toBe(POOL_HOST_ID);
    },
  );

  it.each([
    {
      servingPeer: { kind: "computer" as const, hostId: TAB_HOST_ID },
      effectiveHostId: TAB_HOST_ID,
      label: "no pool address, with another computer serving the app",
    },
    {
      servingPeer: { kind: "pool" as const },
      effectiveHostId: null,
      label: "the pool serving the app",
    },
  ])(
    "keeps a loaded original-host task's link status and view when its lease is dead: $label",
    async ({ servingPeer, effectiveHostId }) => {
      const streams = installStreams();
      seams.showRealConnectionPill = true;
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      });
      taskConsumerQueryClient = queryClient;
      seams.effectiveHostId = WINDOW_HOST_ID;

      const view = renderFollowingTab(queryClient);
      await waitFor(() => expect(streams.opened()).toBe(1));
      streams.deliverSnapshot(0);
      await waitForTaskShown();

      const controller = getEpicSessionController();
      controller.openOnOriginalHost(EPIC_ID);
      expect(controller.readEpicHostId(EPIC_ID)).toBe(WINDOW_HOST_ID);
      view.moveTo(effectiveHostId ?? POOL_HOST_ID);
      await waitFor(() => {
        expect(controller.readEpicHostId(EPIC_ID)).toBe(WINDOW_HOST_ID);
      });
      streams.deliverSnapshot(streams.currentIndex());
      await waitFor(() => {
        expect(screen.getByTestId("epic-connection-pill").textContent).toBe(
          "Connected",
        );
      });

      useSelectionAuthorityStore.getState().applyKernelSnapshot({
        attached: true,
        preferredHostId: null,
        targetHostId: servingPeer.kind === "pool" ? POOL_HOST_ID : TAB_HOST_ID,
        effectiveHostId,
        servingPeer,
        noPeerPresentation: null,
        leases: [
          {
            hostId: WINDOW_HOST_ID,
            status: "dead",
            dead: { reason: "offline" },
          },
        ],
        selectionRevision: 2,
      });

      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("ready");
      expect(controller.readTabSnapshot(EPIC_ID, TAB_ID).sessionHostId).toBe(
        WINDOW_HOST_ID,
      );
      expect(screen.getByTestId("epic-connection-pill").textContent).toBe(
        "Connected",
      );

      act(() => streams.setStatus(streams.currentIndex(), "reconnecting"));
      const epicHandle = __getOpenEpicRegistryForTests().get(EPIC_ID);
      if (epicHandle === null)
        throw new Error("expected the pinned task handle");
      await waitFor(() => {
        expect(epicHandle.store.getState().hostTransportStatus).toBe(
          "reconnecting",
        );
      });
      await waitFor(() => {
        expect(
          screen.getByTestId("epic-connection-pill").textContent,
        ).toContain("Connecting…");
      });
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("ready");
      expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();

      act(() => streams.setStatus(streams.currentIndex(), "closed"));
      await waitFor(() => {
        expect(screen.getByTestId("epic-connection-pill").textContent).toBe(
          "Offline",
        );
      });
      expect(
        controller.readTabSnapshot(EPIC_ID, TAB_ID).presentation.kind,
      ).toBe("ready");
      expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
      expect(screen.getByTestId("tile-canvas-stub")).toBeTruthy();
    },
  );

  it("starts no further rebuild while the row stays below the floor, past fifteen minutes", async () => {
    installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer(true);
    await waitForTaskShown();
    expect(seams.openAttempts).toEqual([TAB_HOST_ID]);
    publishTabRow("1.5.4");
    await screen.findByTestId("epic-repoint-failure");
    // Two local refusals before any dial: the run key's demand segment moves once
    // after a failed rebuild that follows a release.
    const attemptsAtFailure = [...seams.openAttempts];
    expect(attemptsAtFailure).toEqual([TAB_HOST_ID, TAB_HOST_ID, TAB_HOST_ID]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(seams.openAttempts).toEqual(attemptsAtFailure);
    expect(screen.getByTestId("epic-repoint-failure")).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16 * 60_000);
    });
    expect(seams.openAttempts).toEqual(attemptsAtFailure);
  });

  it("acquires once and shows the task again when the row rises back to the floor", async () => {
    const streams = installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer(true);
    await waitForTaskShown();
    publishTabRow("1.5.4");
    await screen.findByTestId("epic-repoint-failure");
    const attemptsBefore = seams.openAttempts.length;
    const streamsBefore = streams.opened();

    publishTabRow("2.0.0");

    await waitForTaskShown();
    expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
    expect(seams.openAttempts).toHaveLength(attemptsBefore + 1);
    expect(streams.opened()).toBe(streamsBefore + 1);
  });

  it("opens Settings, Host, Updates for the tab's computer from Update now", async () => {
    installStreams();
    publishTabRow("2.0.0");
    renderTabOnAnotherComputer(true);
    await waitForTaskShown();
    publishTabRow("1.5.4");
    const card = await screen.findByTestId("epic-repoint-failure");

    fireEvent.click(within(card).getByRole("button", { name: "Update now" }));

    expect(seams.carriedHostIds).toEqual([TAB_HOST_ID]);
    expect(seams.openedSettings).toEqual([
      {
        section: "host",
        resetToGeneral: false,
        tab: "updates",
        draft: null,
        hostId: null,
      },
    ]);
  });
  describe.each([
    {
      form: "the desktop's modal",
      mobile: false,
      cover: "window-host-modal",
    },
    {
      form: "the phone's startup card",
      mobile: true,
      cover: "window-host-startup-card",
    },
  ])("when the tab's computer is the window's own, on $form", (testCase) => {
    it("narrates in the window's cover and draws no task card", async () => {
      setMobileApp(testCase.mobile);
      installStreams();
      publishTabRow("2.0.0");
      renderTabOnTheWindowsComputer();
      await waitForTaskShown();

      publishTabRow("1.5.4");

      const cover = await screen.findByTestId(testCase.cover);
      expect(within(cover).getByText("Host update needed")).toBeTruthy();
      await waitFor(() => {
        expect(screen.queryByTestId("tile-canvas-stub")).toBeNull();
      });
      expect(screen.queryByTestId("epic-repoint-failure")).toBeNull();
      expect(screen.queryByTestId("tile-canvas-loading")).toBeNull();
    });
  });
});
