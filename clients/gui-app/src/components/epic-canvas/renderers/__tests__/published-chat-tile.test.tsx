import {
  cleanup,
  render as renderWithoutQueryClient,
  screen,
  waitFor,
  within,
  type RenderResult,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import {
  readCloudChat,
  type CloudChatRead,
} from "@traycer-clients/shared/cloud-chat/cloud-chat-reader";
import { InMemoryChatPartCache } from "@traycer-clients/shared/cloud-chat/part-cache";
import { webCryptoSha256Hex } from "@traycer-clients/shared/cloud-chat/bytes";
import type { JsonObject } from "@traycer/protocol/persistence/chat-sync/json";
import {
  DEFAULT_PUBLISH,
  FIRST_COHORT,
  IDENTITY,
  SECOND_COHORT,
  publishCloudChat,
  recordingPort,
  servingBehaviour,
} from "@traycer-clients/shared/cloud-chat/__tests__/__fixtures__/published-cloud-chat";
import type { ChatReplicaReadResponse } from "@traycer/protocol/host/epic/chat-replica-read";
import type {
  EnvironmentHostRecordV12,
  EnvironmentListResponse,
} from "@traycer/protocol/host/environment/contracts";
import {
  recordNegotiatedHostMethods,
  resetNegotiatedManifests,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import {
  installHostConnectionRegistrySource,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  poolEntry,
  remoteEntry,
  sandboxFacts,
} from "@traycer-clients/shared/host-client/__tests__/routing-entry-fixtures";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  HostUnavailability,
  RemoteHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/remote-fetcher";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import {
  UNNAMED_HOST_LABEL,
  type HostReachabilityHostKind,
} from "@/hooks/agent/use-host-reachability";
import { TabBodySelectedContext } from "@/components/epic-canvas/canvas/tab-body-selected-context";
import { PaneVisibilityContext } from "@/components/epic-tabs/pane-visibility-context";
import { useAuthStore } from "@/stores/auth/auth-store";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { RpcErrorCode } from "@traycer/protocol/framework/index";
import { TILE_KIND_PUBLISHED_CHAT } from "@/stores/epics/canvas/tile-kinds";
import type { PublishedChatTileRef } from "@/stores/epics/canvas/types";
import {
  composeCloudChatTranscriptState,
  type CloudChatTranscriptState,
} from "@/lib/chats/cloud-chat-transcript-state";
import type { ChatDeadTileBannerReason } from "@/components/epic-canvas/renderers/dead-tile-banner";
import type { PublishedChatSessionHandle } from "@/lib/chats/published-chat-session";
import { PublishedChatTile } from "@/components/epic-canvas/renderers/published-chat-tile";
import { ChatServingWitnessContext } from "@/lib/chats/chat-serving-witness";
import type { RetainingChatServingWitness } from "@/lib/chats/pool-chat-serving-witness";
import {
  recordHostOlderThanDataRefusal,
  resetHostOlderThanDataRefusalsForTests,
} from "@/lib/chats/host-older-than-data-refusals";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { collectPanes } from "@/stores/epics/canvas/tile-tree";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { ChatProjection } from "@/stores/epics/open-epic/types";

// A narrow stand-in for `UseQueryResult`, not the real thing: the tile only
// ever reads `.data` and `.isPending` off this query, and hand-building a
// whole `UseQueryResult` (twenty-odd required fields, most meaningless for a
// synchronous mock) would buy nothing but cast noise. Same convention as
// `use-epic-collaborators-query.test.tsx`'s `MockQueryResult` - mock at the
// hook boundary with only the fields the component under test actually uses.
interface MockReplicaQueryResult {
  readonly data: ChatReplicaReadResponse | undefined;
  readonly isPending: boolean;
  /** Absent on the happy paths, like the real result's `false`. */
  readonly isError?: boolean;
  readonly error?: HostRpcError;
}

interface MockHostReachability {
  readonly status: "reachable" | "unreachable";
  readonly hostLabel: string;
  /** Only the offline-owner recovery cases read these two. */
  readonly unavailability?: HostUnavailability | null;
  readonly hostKind?: HostReachabilityHostKind;
}

/**
 * The props the tile handed `ChatDeadTileBannerContainer`, per mount. The
 * container's own hook wiring (clone offer, owner lookup) is `chat-tile`'s
 * unit; what THIS suite owns is which props the copy's tile threads into it -
 * in particular that the ref's `ownerUserId` rides along instead of being
 * re-resolved from the cloud list.
 */
interface DeadTileBannerContainerProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly chatId: string;
  readonly sourceHostId: string;
  readonly hostLabel: string | null;
  readonly reason: ChatDeadTileBannerReason;
  readonly showsPublishedCopy: boolean;
  readonly testId: string;
  readonly sourceOwnerUserId?: string;
}

const deadTileBannerContainerProps: DeadTileBannerContainerProps[] = [];

/**
 * Every `ChatTileSessionView` render, recording the `handle` prop it
 * received - the head-keyed refresh suite's whole assertion is that a LATER
 * ready state hands the same `handle` object back rather than a fresh one.
 */
interface ChatTileSessionViewProps {
  readonly readOnlyNotice: string | null;
  readonly restingSandbox?: ChatSandboxState;
  readonly handle: PublishedChatSessionHandle;
}
const chatTileSessionViewCalls: ChatTileSessionViewProps[] = [];

const mockUseCloudChatTranscript = vi.fn<() => CloudChatTranscriptState>();
const mockUseChatReplicaRead =
  vi.fn<(args: { readonly enabled: boolean }) => MockReplicaQueryResult>();
const mockUseHostReachability =
  vi.fn<(hostId: string) => MockHostReachability>();

// The two facts a chat's owner is told apart by: whether the build has a server
// pool (the team environment list exists at all) and what that list answers.
// The list query is stubbed at its own seam so the REAL ownership hook, the
// REAL directory-row read and the REAL lock sentences are what the footer
// cases exercise.
const environments = vi.hoisted(
  (): { pool: boolean; list: EnvironmentListResponse | undefined } => ({
    pool: false,
    list: undefined,
  }),
);

vi.mock(
  "@traycer-clients/shared/host-client/host-rpc-routing",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@traycer-clients/shared/host-client/host-rpc-routing")
      >();
    return {
      ...actual,
      readProcessHostRpcTierPlan: () =>
        environments.pool
          ? actual.createHostRpcTierPlan(poolEntry)
          : actual.NO_POOL_HOST_RPC_TIER_PLAN,
    };
  },
);
vi.mock("@/hooks/bots/use-environment-list-query", () => ({
  useEnvironmentListQuery: () => ({ data: environments.list }),
}));
vi.mock("@/providers/use-runner-host", () => ({
  useRunnerHost: () => ({ signInUrl: "https://example.test" }),
  useRunnerHostOrNull: () => ({ signInUrl: "https://example.test" }),
}));
// The REAL host client over a recording messenger, so the owner recovery read
// travels through the real `useHostQuery`, readiness gate and named requester.
const runtime = vi.hoisted(
  (): {
    client: HostClient<HostRpcRegistry> | null;
    messenger: MockHostMessenger<HostRpcRegistry> | null;
  } => ({ client: null, messenger: null }),
);

function runtimeClient(): HostClient<HostRpcRegistry> {
  if (runtime.client === null) {
    throw new Error("test host client not configured");
  }
  return runtime.client;
}

// The app-wide client: none, as a tile under test usually has, unless a case
// hands one in. The account's environment host lists are read through it.
const appHost = vi.hoisted(
  (): {
    client: HostClient<HostRpcRegistry> | null;
    hostsByEnvironmentId: Map<string, EnvironmentHostRecordV12[]>;
  } => ({ client: null, hostsByEnvironmentId: new Map() }),
);
vi.mock("@/lib/host", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/host")>()),
  useOptionalHostClient: () => appHost.client,
}));
// Narrow seam: the named requester over the real `HostClient`, so the REAL
// `useHostQuery`, readiness gate and transport path run for the owner read.
vi.mock("@/hooks/host/use-host-client-for-host-id", async () => {
  const { useMemo } = await import("react");
  // Memoized on [binding, hostId] like production, so one runtime client
  // yields one requester across renders.
  function useHostClientForHostId(hostId: string): HostClient<HostRpcRegistry> {
    const binding = runtimeClient();
    return useMemo(
      () => binding.createRequesterForHostId(hostId),
      [binding, hostId],
    );
  }
  return { useHostClientForHostId };
});

vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => ({ getActiveHostId: () => "host-1" }),
}));
// The serving host the tile binds via `useTabHostId()` - the tab is bound to
// the ref's `hostId` ("host-1" in every fixture below), same as the real
// `<TabHostProvider>` would resolve for this tab.
vi.mock("@/components/epic-canvas/hooks/use-tab-host-id", () => ({
  useTabHostId: () => "host-1",
}));
// A case that hands in a directory runs the REAL reachability hook over it;
// every other case answers from `mockUseHostReachability`.
const realDirectory = vi.hoisted(
  (): { entries: HostDirectoryEntry[] | null } => ({ entries: null }),
);
vi.mock(
  "@/hooks/host/use-host-directory-list-query",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/host/use-host-directory-list-query")
      >();
    return {
      ...actual,
      useHostDirectoryList: () => {
        const real = actual.useHostDirectoryList();
        return realDirectory.entries === null
          ? real
          : {
              ...real,
              data: realDirectory.entries,
              fetchStatus: "idle" as const,
            };
      },
    };
  },
);
vi.mock("@/hooks/agent/use-host-reachability", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/agent/use-host-reachability")
    >();
  return {
    ...actual,
    useHostReachability: (hostId: string) => {
      const real = actual.useHostReachability(hostId);
      return realDirectory.entries === null
        ? mockUseHostReachability(hostId)
        : real;
    },
  };
});
// The chat's sandbox state and the viewer's epic role, stubbed at their own
// seams: both hooks have their own suites, and this one is about the tile's
// wiring of what they answer. With `sources` set, the REAL state hook runs
// instead, over these stand-ins for the task's hosts, the viewer's sandbox
// list and the directory row: the cases where what the tile shows depends on
// how the hook reads a sandbox it cannot place yet.
const sandboxSurface = vi.hoisted(
  (): {
    state: ChatSandboxState;
    role: "owner" | "editor" | "viewer" | null;
    sources: {
      taskHosts: TaskHostsView;
      /** `null`: the list read failed, or is disabled, with nothing cached. */
      sandboxes: SandboxSummary[] | null;
      entry: HostDirectoryEntry | null;
    } | null;
  } => ({ state: { kind: "none" }, role: null, sources: null }),
);
vi.mock("@/hooks/sandboxes/use-chat-sandbox-state", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/sandboxes/use-chat-sandbox-state")
    >();
  return {
    useChatSandboxState: (
      epicId: string,
      hostId: string | null,
      reachable: boolean,
    ) =>
      sandboxSurface.sources === null
        ? sandboxSurface.state
        : actual.useChatSandboxState(epicId, hostId, reachable),
  };
});
vi.mock("@/hooks/epic/use-task-hosts-view", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/epic/use-task-hosts-view")>();
  return {
    ...actual,
    useTaskHostsView: (epicId: string) =>
      sandboxSurface.sources === null
        ? actual.useTaskHostsView(epicId)
        : sandboxSurface.sources.taskHosts,
  };
});
vi.mock("@/hooks/sandboxes/use-sandbox-list-query", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/sandboxes/use-sandbox-list-query")
    >();
  return {
    ...actual,
    useSandboxList: () => {
      const sources = sandboxSurface.sources;
      if (sources === null) return actual.useSandboxList();
      return {
        data:
          sources.sandboxes === null
            ? undefined
            : { sandboxes: sources.sandboxes },
        isLoading: false,
      };
    },
  };
});
vi.mock(
  "@/hooks/sandboxes/use-sandbox-configurations",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/sandboxes/use-sandbox-configurations")
      >();
    return {
      ...actual,
      useSandboxConfigurations: () =>
        sandboxSurface.sources === null
          ? actual.useSandboxConfigurations()
          : {
              configurations: [{ kind: "personal" }],
              teamEnvironmentIds: new Set<string>(),
              complete: true,
            },
    };
  },
);
vi.mock("@/hooks/host/use-host-directory-entry", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/hooks/host/use-host-directory-entry")
    >();
  return {
    ...actual,
    useHostDirectoryEntry: (hostId: string | null) => {
      const sources = sandboxSurface.sources;
      if (sources === null) return actual.useHostDirectoryEntry(hostId);
      return sources.entry?.hostId === hostId ? sources.entry : null;
    },
  };
});
// The footer's Stop is a mutation behind a runner host this suite does not
// mount; its boundary is stubbed and the footer's own text stays real.
vi.mock("@/hooks/sandboxes/use-sandbox-verb-mutation", () => ({
  useSandboxVerb: () => ({ mutate: () => undefined, isPending: false }),
}));
vi.mock("@/lib/epic-selectors", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/epic-selectors")>()),
  useEpicPermissionRole: () => sandboxSurface.role,
}));
vi.mock("@/hooks/chats/use-cloud-chat-transcript", () => ({
  useCloudChatTranscript: () => mockUseCloudChatTranscript(),
}));
vi.mock("@/hooks/chats/use-chat-replica-read", () => ({
  useChatReplicaRead: (args: { readonly enabled: boolean }) =>
    mockUseChatReplicaRead(args),
}));
// The real banner's Report action reaches for app context this suite does
// not mount; the banner around it (message, Clone button) stays real.
vi.mock("@/components/report-issue/report-issue-action", () => ({
  ReportIssueAction: () => null,
}));
vi.mock("@/components/epic-canvas/renderers/chat-tile", async () => {
  const { ChatDeadTileBanner } = await vi.importActual<
    typeof import("@/components/epic-canvas/renderers/dead-tile-banner")
  >("@/components/epic-canvas/renderers/dead-tile-banner");
  const { useContext } = await import("react");
  const { ChatStateLineContext } = await vi.importActual<
    typeof import("@/components/epic-canvas/renderers/chat-state-line")
  >("@/components/epic-canvas/renderers/chat-state-line");
  return {
    // The composer slot as the real one fills it: a sandbox state line with
    // its actions when the tile hands one, else the read-only notice.
    ChatTileSessionView: (props: ChatTileSessionViewProps) => {
      chatTileSessionViewCalls.push(props);
      const stateLine = useContext(ChatStateLineContext);
      return (
        <div data-testid="chat-tile-session-view">
          {stateLine === null ? (
            props.readOnlyNotice
          ) : (
            <>
              {stateLine.line}
              {stateLine.actions}
            </>
          )}
        </div>
      );
    },
    // The real actions run the clone offer, like the container below; their
    // own buttons are pinned by `dead-tile-banner-container.test.tsx`.
    SandboxEndActions: (props: { readonly sourceHostId: string }) => (
      <span
        data-testid="sandbox-end-actions"
        data-source-host={props.sourceHostId}
      />
    ),
    // Stubbed at the container boundary - the real container runs the clone
    // offer's host-runtime subscription and the owner lookup's cloud query,
    // neither of which this suite mounts providers for. It records the props
    // and renders the REAL `ChatDeadTileBanner`, so the Clone affordance the
    // tests assert on is the genuine article.
    ChatDeadTileBannerContainer: (props: DeadTileBannerContainerProps) => {
      deadTileBannerContainerProps.push(props);
      return (
        <ChatDeadTileBanner
          hostLabel={props.hostLabel}
          reason={props.reason}
          // The real container resolves these from the signed-in identity
          // and the epic role; this suite mounts neither, and what it owns
          // is the tile→container prop threading, so the banner renders the
          // pre-collaborator defaults. `showsPublishedCopy` IS threading, so
          // it forwards. The ownership wiring itself is pinned by
          // `dead-tile-banner-container.test.tsx` against the real container.
          ownedByViewer
          environmentOwned={false}
          cloneAllowed
          showsPublishedCopy={props.showsPublishedCopy}
          onClone={() => undefined}
          continueTargetLabel={null}
          cloning={false}
          className={undefined}
          testId={props.testId}
        />
      );
    },
  };
});
vi.mock("@/components/epic-canvas/renderers/published-chat-notice", () => ({
  // The notice's own copy is its unit's business; what this suite asserts is
  // WHICH state the tile hands it, so the state kind is surfaced as an attribute.
  PublishedChatNotice: (props: {
    readonly state: { readonly kind: string };
  }) => (
    <div
      data-testid="published-chat-notice"
      data-state-kind={props.state.kind}
    />
  ),
}));
vi.mock("@/lib/chats/published-chat-source-provider", () => ({
  PublishedChatSourceProvider: (props: { readonly children: ReactNode }) => (
    <>{props.children}</>
  ),
}));

const NODE: PublishedChatTileRef = {
  id: "published:task-1:user-1:chat-1",
  instanceId: "instance-1",
  type: TILE_KIND_PUBLISHED_CHAT,
  name: "Some agent",
  hostId: "host-1",
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "user-1",
  ownerHostId: "owner-host-1",
};

/**
 * The SAME ref shape the canvas builds when this device's own connected host
 * answers `CHAT_NOT_VISIBLE` for one of its chats (tickets 47/48): the
 * serving host and the owning host are one machine, which is exactly what
 * `hostId === ownerHostId` says. Nothing about it is probed - the copy's
 * footer has to read that off the ref.
 */
const SAME_HOST_NODE: PublishedChatTileRef = {
  ...NODE,
  ownerHostId: NODE.hostId,
};

function refusedUnpublished(): CloudChatTranscriptState {
  const read: CloudChatRead = { chat: null, outcome: { kind: "unpublished" } };
  return { kind: "refused", read };
}

function refusedCorrupt(): CloudChatTranscriptState {
  const read: CloudChatRead = {
    chat: null,
    outcome: {
      kind: "corrupt",
      reason: "head-digest-mismatch",
      message: "This chat could not be verified.",
      diagnostic: "digest mismatch",
    },
  };
  return { kind: "refused", read };
}

function replicaOk(): MockReplicaQueryResult {
  return {
    isPending: false,
    data: {
      outcome: {
        status: "ok",
        chat: {
          chatId: "chat-1",
          title: "Replica title",
          userId: "user-1",
          hostId: "owner-host-1",
          createdAt: 1,
          updatedAt: 2,
        },
        messages: [],
        events: [],
      },
    },
  };
}

/**
 * A replica read whose one message carries a block this build cannot parse -
 * exercises `convertReplicaChat`'s real placeholder-swap path (not mocked
 * here), so `unreadableCount` on the resulting conversion is genuinely `1`,
 * the same way it would be in production.
 */
function replicaOkWithUnreadableBlock(): MockReplicaQueryResult {
  return {
    isPending: false,
    data: {
      outcome: {
        status: "ok",
        chat: {
          chatId: "chat-1",
          title: "Replica title",
          userId: "user-1",
          hostId: "owner-host-1",
          createdAt: 1,
          updatedAt: 2,
        },
        messages: [
          {
            role: "assistant",
            messageId: "m1",
            timestamp: 1,
            turnId: null,
            usage: null,
            sender: {
              type: "agent",
              harnessId: "claude",
              agentId: "a1",
              displayName: null,
              reply: { expectsReply: false },
              inReplyTo: null,
            },
            blocks: [
              {
                blockId: "b1",
                status: "completed",
                timestamp: 1,
                parentBlockId: null,
                // A type outside this build's vocabulary.
                type: "holodeck",
                payload: { deck: 7 },
              },
            ],
          },
        ],
        events: [],
      },
    },
  };
}

function replicaAbsent(): MockReplicaQueryResult {
  return { isPending: false, data: { outcome: { status: "absent" } } };
}

function replicaFailed(code: RpcErrorCode): MockReplicaQueryResult {
  return {
    isPending: false,
    data: undefined,
    isError: true,
    error: new HostRpcError({
      code,
      message: "boom",
      requestId: "r",
      method: "epic.chatReplicaRead",
      fatalDetails: null,
    }),
  };
}

function replicaNotFetched(): MockReplicaQueryResult {
  return { isPending: true, data: undefined };
}

let queryClient = new QueryClient();

function render(ui: ReactNode): RenderResult {
  return renderWithoutQueryClient(ui, {
    wrapper: (props: { readonly children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    ),
  });
}

/** Rows the recovery cases dial: the serving host and the copy's owner. */
const OWNER_BASE_ROW = remoteEntry("owner-host-1", null);
const OFFLINE_OWNER_ROW: RemoteHostDirectoryEntry = {
  ...OWNER_BASE_ROW,
  transportDialability: "not-dialable",
  remoteStatus: { ...OWNER_BASE_ROW.remoteStatus, connectivity: "offline" },
};
const HOST_ROWS: readonly HostDirectoryEntry[] = [
  remoteEntry("host-1", null),
  OFFLINE_OWNER_ROW,
];

beforeEach(() => {
  queryClient = new QueryClient();
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "req-1",
    handlers: {
      "host.status": () => ({
        ready: true,
        hostVersion: "1.2.3",
        protocolVersion: { major: 1, minor: 0 },
        busy: false,
        busySessionCount: 0,
        updateProgress: null,
        busyBreakdown: null,
        updateOperation: null,
        updateTransaction: null,
        storeFormats: null,
        install: null,
        processMemory: null,
        crossHostMessaging: null,
        sessions: null,
        updatesExternallyManaged: null,
      }),
      "environment.host.list": ({ environmentId }) => ({
        hosts: appHost.hostsByEnvironmentId.get(environmentId) ?? [],
      }),
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      HOST_ROWS.find((row) => row.hostId === hostId) ?? null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  runtime.client = client;
  runtime.messenger = messenger;
  mockUseHostReachability.mockReturnValue({
    status: "unreachable",
    hostLabel: "Ada's Mac",
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  runtime.client?.dispose();
  runtime.client = null;
  runtime.messenger = null;
  appHost.client = null;
  appHost.hostsByEnvironmentId.clear();
  realDirectory.entries = null;
  resetNegotiatedManifests();
  vi.clearAllMocks();
  deadTileBannerContainerProps.length = 0;
  chatTileSessionViewCalls.length = 0;
  environments.pool = false;
  environments.list = undefined;
  sandboxSurface.state = { kind: "none" };
  sandboxSurface.role = null;
  sandboxSurface.sources = null;
  resetHostConnectionRegistryForTest();
  useAuthStore.setState(useAuthStore.getInitialState(), true);
});

import type { ChatSandboxState } from "@/lib/sandboxes/chat-sandbox-state";
import type { TaskHostsView } from "@/hooks/epic/use-task-hosts-view";
import type { SandboxSummary } from "@traycer/protocol/host/sandbox-control";
import type { TaskHostRow } from "@traycer/protocol/host/task-host-summary";
import { sandboxSummaryFixture } from "@/hooks/sandboxes/__tests__/sandbox-fixtures";

describe("PublishedChatTile - doc-replica fallback", () => {
  it("renders the transcript with the replica lock reason when the cloud read is unpublished and the replica has content", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    expect(view.textContent).toContain("This agent lives on Ada's Mac");
    expect(view.textContent).toContain("showing this device's synced copy");
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
  });

  it("keeps today's notice when the cloud read is unpublished and the replica has no content", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaAbsent());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-notice")).not.toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
  });

  it('says the replica read FAILED rather than repeating "not published yet"', () => {
    // Retries exhausted, `data` undefined - identical to an absent replica from
    // the notice's point of view, and the difference matters: one means no copy
    // exists, the other means the lookup never completed and is worth retrying.
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaFailed("RPC_ERROR"));

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.getByTestId("published-chat-notice").dataset.stateKind).toBe(
      "failed",
    );
  });

  it("keeps the cloud refusal when the serving host has no replica RPC", () => {
    // An older host did not fail - it has no second source at all, so the
    // cloud's own answer is still the honest one.
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaFailed("E_HOST_UNSUPPORTED"));

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.getByTestId("published-chat-notice").dataset.stateKind).toBe(
      "refused",
    );
  });

  it("does not fall back to the replica for a non-unpublished refusal", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedCorrupt());
    // Even if the replica happened to have content, a corrupt-publication
    // refusal must not be masked by it.
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-notice")).not.toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
  });

  it("never enables the replica query for a non-unpublished refusal", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedCorrupt());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(mockUseChatReplicaRead).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it("enables the replica query once the cloud read settles unpublished", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(mockUseChatReplicaRead).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true }),
    );
  });

  it("shows the loading state instead of the notice while the replica read is enabled and still pending", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    // Neither the notice NOR the transcript yet - a stale "not published"
    // flash is exactly the bug this branch exists to prevent. The bounded
    // load state (not a bare spinner testid) is what covers the window now -
    // see `published-chat-tile.tsx`'s `boundedLoad` arm. This suite never
    // seeds `useSelectionAuthorityStore`, so the lease read is null and the
    // load answers "connecting" (pending, host itself not yet up) rather than
    // "loading" (host up, content still pending) - either is a non-ready,
    // non-terminal pending arm, which is all this test asserts.
    const loadState = screen.queryByTestId(
      `published-chat-tile-load-${NODE.id}`,
    );
    expect(loadState).not.toBeNull();
    expect(loadState?.getAttribute("data-load-kind")).toBe("connecting");
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
  });

  it("uses the reachable-owner sentence once the owner comes back while the replica view is open", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "reachable",
      hostLabel: "Ada's Mac",
    });

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    // The cloud read can stay `unpublished` forever (a legacy chat, or a
    // server declining this viewer the row) even after the owner is back
    // online, so the lock reason must say so honestly instead of repeating
    // the "which is offline" sentence past the point it stopped being true.
    expect(view.textContent).toContain("which lives on Ada's Mac");
    expect(view.textContent).not.toContain("which is offline");
  });

  it("drops the other-machine phrasing when the copy's owner IS the serving host", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "reachable",
      hostLabel: "Ada's Mac",
    });

    render(
      <PublishedChatTile
        node={SAME_HOST_NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    // Same state as the test above (reachable owner, synced copy) - only the
    // ref differs, and that alone must move the footer off copy that reads
    // the reader's own machine as somewhere else.
    expect(view.textContent).toContain("no longer on this host");
    expect(view.textContent).not.toContain("lives on");
    expect(view.textContent).not.toContain("from this device");
  });

  it("appends the unreadable-item count to the replica lock reason", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOkWithUnreadableBlock());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    const view = screen.getByTestId("chat-tile-session-view");
    expect(view.textContent).toContain(
      "1 item needs a newer version of Traycer to render",
    );
  });
});

describe("PublishedChatTile - dead-tile clone banner", () => {
  it("mounts the clone banner above the transcript when the owner is unreachable and not this host", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    const banner = screen.getByTestId("published-chat-dead-tile-chat-1");
    expect(banner).not.toBeNull();
    // The genuine Clone affordance, not just the banner chrome.
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    // The banner sits ABOVE the transcript, not under it.
    const view = screen.getByTestId("chat-tile-session-view");
    expect(
      banner.compareDocumentPosition(view) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("threads the ref's owner into the container instead of leaving it to the cloud-list lookup", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(deadTileBannerContainerProps).toHaveLength(1);
    expect(deadTileBannerContainerProps[0]).toEqual({
      epicId: "epic-1",
      tabId: "tab-1",
      chatId: "chat-1",
      sourceHostId: "owner-host-1",
      hostLabel: "Ada's Mac",
      reason: "host-offline",
      // This tile really does render a copy under the banner, so the
      // foreign-owner sentence may claim one.
      showsPublishedCopy: true,
      testId: "published-chat-dead-tile-chat-1",
      // Off the ref - a post-restart host with swept registry facts cannot
      // answer the lookup, and the ref knew the owner the whole time.
      sourceOwnerUserId: "user-1",
    });
  });

  it("hands the banner no host name when nothing names the owner", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "unreachable",
      hostLabel: UNNAMED_HOST_LABEL,
    });

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(deadTileBannerContainerProps).toHaveLength(1);
    expect(deadTileBannerContainerProps[0]?.hostLabel).toBeNull();
    const banner = screen.getByTestId("published-chat-dead-tile-chat-1");
    expect(banner.textContent).not.toContain("owner-host-1");
  });

  it("mounts no banner once the owner is reachable", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue({
      status: "reachable",
      hostLabel: "Ada's Mac",
    });

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
  });

  it("mounts the banner when the copy's owner IS the serving host, too", () => {
    // The canvas-substitution case. This tile owns the unreachable-owner
    // banner in every mount; `tab-group-view` draws one above it only for a
    // REACHABLE host's "not here" answer, so nothing doubles.
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());

    render(
      <PublishedChatTile
        node={SAME_HOST_NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(
      screen.getByTestId("published-chat-dead-tile-chat-1"),
    ).not.toBeNull();
    expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
  });

  // The canvas no longer draws a banner over this tile for an unreachable
  // owner, so the tile's own has to be there on every branch - a reader
  // stuck on the load state or a refused read still needs the host sentence
  // and the Clone way out (PR #1818 review). Neither branch has a copy on
  // screen, so neither may claim one.
  it("keeps the banner above the load state before the first copy", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(
      screen.queryByTestId(`published-chat-tile-load-${NODE.id}`),
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    expect(deadTileBannerContainerProps).toHaveLength(1);
    expect(deadTileBannerContainerProps[0]?.showsPublishedCopy).toBe(false);
  });

  it("keeps the banner above the notice when no copy could be read", () => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaAbsent());

    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(screen.queryByTestId("published-chat-notice")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Clone agent" })).toBeTruthy();
    expect(deadTileBannerContainerProps).toHaveLength(1);
    expect(deadTileBannerContainerProps[0]?.showsPublishedCopy).toBe(false);
  });
});

/** A `ready` transcript built through the real publish → read → compose pipeline. */
async function readyState(
  cohorts: readonly (readonly JsonObject[])[],
): Promise<CloudChatTranscriptState> {
  const published = await publishCloudChat({
    ...DEFAULT_PUBLISH,
    cohorts,
  });
  const read = await readCloudChat({
    identity: IDENTITY,
    port: recordingPort(servingBehaviour(published)),
    cache: new InMemoryChatPartCache(),
    sha256Hex: webCryptoSha256Hex,
  });
  return composeCloudChatTranscriptState({
    read,
    readError: null,
    payloadsOutcome: undefined,
    payloadsSettled: true,
  });
}

/**
 * The head-keyed refresh: once a copy has been shown, a LATER read for a
 * newer record head is applied INTO the same store (`applyConversion`)
 * rather than by remounting the surface - see `published-chat-tile.tsx`'s
 * own doc comment ("The copy FOLLOWS the owner's publications, in place").
 * These build the `ready` state through the REAL pipeline
 * (`publishCloudChat` -> `readCloudChat` -> `composeCloudChatTranscriptState`)
 * rather than hand-rolling a `PresentedChat`, so the conversion each `ready`
 * state carries is exactly what production would produce.
 *
 * Ablation each test guards against: gate the store creation on anything
 * other than "no store yet" (e.g. re-create per read) and the SAME-handle
 * assertions below fail - `ChatTileSessionView` would receive a fresh
 * `handle` on every publication, dropping every subscription the rendered
 * surface (scroll, memoized rows) held on the old one.
 */
describe("PublishedChatTile - head-keyed refresh", () => {
  function renderTile(): RenderResult {
    return render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
  }

  function rerenderTile(rerender: (ui: ReactNode) => void): void {
    rerender(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
  }

  it("renders the bounded load state, never the notice, for a loading or not-yet-applied ready transcript before the first copy", async () => {
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());
    mockUseCloudChatTranscript.mockReturnValue({ kind: "loading" });

    const { unmount } = renderTile();
    expect(
      screen.queryByTestId(`published-chat-tile-load-${NODE.id}`),
    ).not.toBeNull();
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
    expect(screen.queryByTestId("chat-tile-session-view")).toBeNull();
    unmount();

    // A `ready` state the effect has not yet applied is the SAME gate, not
    // the notice branch - the notice would flash "not published yet" for a
    // chat that is, in fact, about to render.
    const v1 = await readyState([FIRST_COHORT]);
    mockUseCloudChatTranscript.mockReturnValue(v1);
    renderTile();
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
    await waitFor(() => {
      expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
    });
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
  });

  it("keeps rendering the session view through a loading refresh, and hands the SAME handle back once the next read is applied", async () => {
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());
    const v1 = await readyState([FIRST_COHORT]);
    mockUseCloudChatTranscript.mockReturnValue(v1);

    const { rerender } = renderTile();
    await waitFor(() => {
      expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
    });
    expect(chatTileSessionViewCalls).toHaveLength(1);
    const firstHandle = chatTileSessionViewCalls[0].handle;
    const firstMessageCount = firstHandle.store.getState().messages.length;
    expect(firstMessageCount).toBeGreaterThan(0);

    // A re-read for a newer head is in flight: the previous transcript stays
    // on screen, and the footer says so instead of a load gate or a notice.
    mockUseCloudChatTranscript.mockReturnValue({ kind: "loading" });
    rerenderTile(rerender);

    const loadingView = screen.getByTestId("chat-tile-session-view");
    expect(loadingView).not.toBeNull();
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
    expect(loadingView.textContent).toContain("A newer copy is being fetched.");

    // The re-read lands: applied into the SAME handle, never a fresh one.
    const v2 = await readyState([FIRST_COHORT, SECOND_COHORT]);
    mockUseCloudChatTranscript.mockReturnValue(v2);
    rerenderTile(rerender);

    await waitFor(() => {
      const last =
        chatTileSessionViewCalls[chatTileSessionViewCalls.length - 1];
      expect(last.handle.store.getState().messages.length).toBeGreaterThan(
        firstMessageCount,
      );
    });
    const laterHandle =
      chatTileSessionViewCalls[chatTileSessionViewCalls.length - 1].handle;
    expect(laterHandle).toBe(firstHandle);
  });

  it("keeps the session view after a copy has been shown, and states the retry story when the re-read FAILED", async () => {
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());
    const v1 = await readyState([FIRST_COHORT]);
    mockUseCloudChatTranscript.mockReturnValue(v1);

    const { rerender } = renderTile();
    await waitFor(() => {
      expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
    });

    mockUseCloudChatTranscript.mockReturnValue({
      kind: "failed",
      error: new HostRpcError({
        code: "RPC_ERROR",
        message: "boom",
        requestId: "r",
        method: "epic.resolveCloudChatHead",
        fatalDetails: null,
      }),
    });
    rerenderTile(rerender);

    const view = screen.getByTestId("chat-tile-session-view");
    expect(view).not.toBeNull();
    expect(view.textContent).toContain("could not be fetched");
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
  });

  it("keeps the session view after a copy has been shown, states the refusal, and does not fall back to the replica read", async () => {
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());
    const v1 = await readyState([FIRST_COHORT]);
    mockUseCloudChatTranscript.mockReturnValue(v1);

    const { rerender } = renderTile();
    await waitFor(() => {
      expect(screen.getByTestId("chat-tile-session-view")).not.toBeNull();
    });

    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    rerenderTile(rerender);

    const view = screen.getByTestId("chat-tile-session-view");
    expect(view).not.toBeNull();
    expect(view.textContent).toContain("A newer copy could not be read");
    expect(screen.queryByTestId("published-chat-notice")).toBeNull();
    // A copy is already on screen, so the replica fallback - which exists
    // only for the BEFORE-first-copy case - must stay disabled.
    expect(mockUseChatReplicaRead).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });
});

/**
 * The name the footer and the banner give an owner host the directory does
 * not list: its own report in the account's environment host lists, read
 * through the REAL `useHostQueries` over the app-wide client, or "the host" -
 * never its id.
 */
describe("PublishedChatTile - an unlisted owner's name", () => {
  const PERSONAL: EnvironmentListResponse = {
    environments: [
      {
        environmentId: "env-personal",
        ownerKind: "user",
        ownerId: "user-1",
        roomId: "room-personal",
        label: "Personal",
      },
    ],
  };
  const OWNER_RECORD: EnvironmentHostRecordV12 = {
    hostId: "owner-host-1",
    hostLabel: "windows-test-machine",
    hostPlatform: "win32",
    enrolledByUserId: "user-1",
    kind: "personal",
    boundAt: 1,
    reachable: false,
    lastReportedAt: 1,
    applied: [],
    hasLocalRow: false,
  };
  // What `useHostReachability` answers for a host its directory does not list.
  const UNLISTED_OWNER: MockHostReachability = {
    status: "unreachable",
    hostLabel: UNNAMED_HOST_LABEL,
    unavailability: "offline",
    hostKind: "unknown",
  };

  function hostListCalls(): readonly unknown[] {
    if (runtime.messenger === null) {
      throw new Error("test messenger not configured");
    }
    return runtime.messenger.calls
      .filter((call) => call.method === "environment.host.list")
      .map((call) => call.params);
  }

  /** Signed in as the chat's owner, on an app-wide host that has `methods`. */
  function signInOnAppHost(methods: ReadonlyArray<string>): void {
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: "user-1", userName: "Ada", email: "ada@example.com" },
      contextMetadata: { userId: "user-1", username: "Ada" },
    });
    environments.list = PERSONAL;
    appHost.client = runtimeClient().createRequesterForHostId("host-1");
    recordNegotiatedHostMethods("host-1", methods);
  }

  /** The tile over a published copy, the copy the runner saw. */
  async function renderTile(): Promise<RenderResult> {
    mockUseCloudChatTranscript.mockReturnValue(
      await readyState([FIRST_COHORT]),
    );
    mockUseChatReplicaRead.mockReturnValue(replicaNotFetched());
    return render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
  }

  async function settled(): Promise<void> {
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
  }

  it("names the host by what it reported to the account, in the footer and the banner", async () => {
    signInOnAppHost(["environment.list", "environment.host.list"]);
    appHost.hostsByEnvironmentId.set("env-personal", [OWNER_RECORD]);
    mockUseHostReachability.mockReturnValue(UNLISTED_OWNER);

    const view = await renderTile();

    await waitFor(() => {
      expect(
        screen.getByTestId("chat-tile-session-view").textContent,
      ).toContain(
        "This agent lives on windows-test-machine, which is offline — showing the last published copy. Sending resumes when that host is back.",
      );
    });
    expect(
      screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
    ).toContain(
      'Clone this agent to continue while "windows-test-machine" is offline; the original stays there.',
    );
    expect(view.container.textContent).not.toContain("owner-host-1");
  });

  it("never names the host from the previous account's list", async () => {
    signInOnAppHost(["environment.list", "environment.host.list"]);
    appHost.hostsByEnvironmentId.set("env-personal", [OWNER_RECORD]);
    mockUseHostReachability.mockReturnValue(UNLISTED_OWNER);
    const first = await renderTile();
    await waitFor(() => {
      expect(
        screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
      ).toContain('"windows-test-machine"');
    });
    first.unmount();

    // Another account on the same app: its list does not carry the machine.
    appHost.hostsByEnvironmentId.clear();
    useAuthStore.setState({
      status: "signed-in",
      profile: { userId: "user-2", userName: "Bo", email: "bo@example.com" },
      contextMetadata: { userId: "user-2", username: "Bo" },
    });
    const second = await renderTile();

    // The first frame, before any refetch: the cached answer is user-1's.
    expect(
      screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
    ).toContain("Clone this agent to continue while the host is offline");
    await settled();
    expect(second.container.textContent).not.toContain("windows-test-machine");
  });

  // A label the host reported that is its own id names nothing either: the
  // search goes on to the next environment, and stops at "the host".
  describe("an account record labelled with the host's own id", () => {
    const ID_LABELLED_RECORD: EnvironmentHostRecordV12 = {
      ...OWNER_RECORD,
      hostLabel: "owner-host-1",
    };

    it("takes the next environment's name for the host", async () => {
      signInOnAppHost(["environment.list", "environment.host.list"]);
      environments.list = {
        environments: [
          ...PERSONAL.environments,
          {
            environmentId: "env-team",
            ownerKind: "organization",
            ownerId: "org-1",
            roomId: "room-team",
            label: "acme",
          },
        ],
      };
      appHost.hostsByEnvironmentId.set("env-personal", [ID_LABELLED_RECORD]);
      appHost.hostsByEnvironmentId.set("env-team", [OWNER_RECORD]);
      mockUseHostReachability.mockReturnValue(UNLISTED_OWNER);

      const view = await renderTile();

      await waitFor(() => {
        expect(
          screen.getByTestId("chat-tile-session-view").textContent,
        ).toContain(
          "This agent lives on windows-test-machine, which is offline",
        );
      });
      expect(
        screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
      ).toContain(
        'Clone this agent to continue while "windows-test-machine" is offline',
      );
      expect(view.container.textContent).not.toContain("owner-host-1");
    });

    it('says "the host" when that is the only record', async () => {
      signInOnAppHost(["environment.list", "environment.host.list"]);
      appHost.hostsByEnvironmentId.set("env-personal", [ID_LABELLED_RECORD]);
      mockUseHostReachability.mockReturnValue(UNLISTED_OWNER);

      const view = await renderTile();
      await settled();

      expect(
        screen.getByTestId("chat-tile-session-view").textContent,
      ).toContain("This agent lives on the host, which is offline");
      expect(
        screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
      ).toContain("Clone this agent to continue while the host is offline");
      expect(view.container.textContent).not.toContain("owner-host-1");
    });
  });

  it.each([
    {
      name: "no environment lists the host",
      methods: ["environment.list", "environment.host.list"],
      asked: true,
    },
    {
      name: "the app-wide host predates environment.host.list",
      methods: ["environment.list"],
      asked: false,
    },
  ])(
    'says "the host", never its id, when $name',
    async ({ methods, asked }) => {
      signInOnAppHost(methods);
      mockUseHostReachability.mockReturnValue(UNLISTED_OWNER);

      const view = await renderTile();
      await settled();

      expect(
        screen.getByTestId("chat-tile-session-view").textContent,
      ).toContain(
        "This agent lives on the host, which is offline — showing the last published copy. Sending resumes when that host is back.",
      );
      expect(
        screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
      ).toContain("Clone this agent to continue while the host is offline");
      expect(view.container.textContent).not.toContain("owner-host-1");
      expect(hostListCalls()).toHaveLength(asked ? 1 : 0);
    },
  );

  it("asks the account nothing for a host the directory names", async () => {
    signInOnAppHost(["environment.list", "environment.host.list"]);
    appHost.hostsByEnvironmentId.set("env-personal", [OWNER_RECORD]);
    mockUseHostReachability.mockReturnValue({
      ...UNLISTED_OWNER,
      hostLabel: "Ada's Mac",
    });

    const view = await renderTile();
    await settled();

    expect(hostListCalls()).toHaveLength(0);
    expect(screen.getByTestId("chat-tile-session-view").textContent).toContain(
      "This agent lives on Ada's Mac, which is offline",
    );

    // The same mounted tile asks once the directory loses the name, so the
    // silence above is the gate and not a harness that cannot send.
    mockUseHostReachability.mockReturnValue(UNLISTED_OWNER);
    view.rerender(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
    await waitFor(() => {
      expect(hostListCalls()).toEqual([{ environmentId: "env-personal" }]);
    });
  });

  // The registry hands a host it has no display name for to the directory
  // labelled with its own id (`hostListItemToDirectoryEntry`). Through the
  // REAL reachability hook, that label is no name: the tile asks the account,
  // and says "the host" when the account has none either.
  describe("a listed owner whose directory label is its own id", () => {
    beforeEach(() => {
      realDirectory.entries = [
        remoteEntry("host-1", null),
        { ...OFFLINE_OWNER_ROW, label: "owner-host-1" },
      ];
    });

    it("takes the account's label for the host", async () => {
      signInOnAppHost(["environment.list", "environment.host.list"]);
      appHost.hostsByEnvironmentId.set("env-personal", [OWNER_RECORD]);

      const view = await renderTile();

      await waitFor(() => {
        expect(
          screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
        ).toContain(
          'Clone this agent to continue while "windows-test-machine" is offline; the original stays there.',
        );
      });
      expect(view.container.textContent).not.toContain("owner-host-1");
    });

    it('says "the host" when the account has no label for it either', async () => {
      signInOnAppHost(["environment.list", "environment.host.list"]);

      const view = await renderTile();
      await settled();

      expect(
        screen.getByTestId("published-chat-dead-tile-chat-1").textContent,
      ).toContain("Clone this agent to continue while the host is offline");
      expect(view.container.textContent).not.toContain("owner-host-1");
    });
  });
});

/**
 * Who the footer says the chat belongs to, with the REAL ownership hook under
 * the tile. A signed-in viewer who is not the ref's owner, in a build with a
 * pool: whether the owner is a collaborator or a team's sandbox is what the
 * environment list and the owner host's row say, and while neither has
 * answered the footer must not name a collaborator.
 */
describe("PublishedChatTile - footer ownership", () => {
  const TEAM_ENVIRONMENTS: EnvironmentListResponse = {
    environments: [
      {
        environmentId: NODE.ownerUserId,
        ownerKind: "organization",
        ownerId: "org-1",
        roomId: "room-team",
        label: "acme",
      },
    ],
  };
  const PERSONAL_ONLY_ENVIRONMENTS: EnvironmentListResponse = {
    environments: [
      {
        environmentId: "viewer-user",
        ownerKind: "user",
        ownerId: "viewer-user",
        roomId: "room-personal",
        label: "Personal",
      },
    ],
  };

  function signInAsAnotherUser(): void {
    environments.pool = true;
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: "viewer-user",
        userName: "Viewer",
        email: "viewer@example.com",
      },
      contextMetadata: { userId: "viewer-user", username: "Viewer" },
    });
  }

  function seedOwnerHostRow(row: HostDirectoryEntry): void {
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) => (hostId === row.hostId ? { ...row } : null),
        onDirectoryChanged: () => ({ dispose: () => undefined }),
      },
      leases: null,
    });
  }

  function renderFooter(): string | null {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
    return screen.getByTestId("chat-tile-session-view").textContent;
  }

  it("keeps the own-chat sentence, never a collaborator's, while the environment list has not answered", () => {
    signInAsAnotherUser();
    environments.list = undefined;

    const footer = renderFooter();

    expect(footer).toContain("This agent lives on Ada's Mac, which is offline");
    expect(footer).not.toContain("belongs to another collaborator");
  });

  it("names another collaborator once the list has answered without the owner", () => {
    signInAsAnotherUser();
    environments.list = PERSONAL_ONLY_ENVIRONMENTS;

    expect(renderFooter()).toContain("belongs to another collaborator");
  });

  it("says the sandbox is out when the owner host's row is a team sandbox, before the list answers", () => {
    signInAsAnotherUser();
    environments.list = undefined;
    seedOwnerHostRow(remoteEntry("owner-host-1", sandboxFacts("team-1")));

    const footer = renderFooter();

    expect(footer).toContain("This chat's sandbox isn't available");
    expect(footer).not.toContain("belongs to another collaborator");
  });

  it("says the sandbox is out when the answered list holds the owner as a team environment", () => {
    signInAsAnotherUser();
    environments.list = TEAM_ENVIRONMENTS;

    expect(renderFooter()).toContain("This chat's sandbox isn't available");
  });
});

describe("PublishedChatTile - offline owner recovery", () => {
  const OFFLINE_REMOTE_OWNER: MockHostReachability = {
    status: "unreachable",
    hostLabel: "Ada's Mac",
    unavailability: "offline",
    hostKind: "remote",
  };

  function statusCalls(): readonly { readonly hostId: string }[] {
    if (runtime.messenger === null) {
      throw new Error("test messenger not configured");
    }
    return runtime.messenger.calls
      .filter((call) => call.method === "host.status")
      .map((call) => ({ hostId: call.authority.endpoint.hostId }));
  }

  function tile(paneVisible: boolean, tabSelected: boolean): ReactNode {
    return (
      <PaneVisibilityContext.Provider value={paneVisible}>
        <TabBodySelectedContext.Provider value={tabSelected}>
          <PublishedChatTile
            node={NODE}
            viewTabId="tab-1"
            tileId="pane-1"
            isActive={false}
            epicId="epic-1"
          />
        </TabBodySelectedContext.Provider>
      </PaneVisibilityContext.Provider>
    );
  }

  async function settled(): Promise<void> {
    await waitFor(() => {
      expect(queryClient.isFetching()).toBe(0);
    });
  }

  beforeEach(() => {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    mockUseHostReachability.mockReturnValue(OFFLINE_REMOTE_OWNER);
  });

  it("asks the owner host for its status while the copy stays on the serving host", async () => {
    render(tile(true, true));

    await waitFor(() => {
      expect(statusCalls()).toEqual([{ hostId: "owner-host-1" }]);
    });
    await settled();
    expect(statusCalls()).toHaveLength(1);
    expect(screen.queryByTestId("chat-tile-session-view")).not.toBeNull();
  });

  it.each([
    { name: "its pane is hidden", paneVisible: false, tabSelected: true },
    { name: "its tab is not selected", paneVisible: true, tabSelected: false },
  ])(
    "sends nothing while $name and asks once more each time it is shown again",
    async ({ paneVisible, tabSelected }) => {
      const view = render(tile(paneVisible, tabSelected));
      expect(statusCalls()).toHaveLength(0);

      view.rerender(tile(true, true));
      await waitFor(() => {
        expect(statusCalls()).toHaveLength(1);
      });
      await settled();

      view.rerender(tile(paneVisible, tabSelected));
      await settled();
      expect(statusCalls()).toHaveLength(1);

      view.rerender(tile(true, true));
      await waitFor(() => {
        expect(statusCalls()).toHaveLength(2);
      });
      await settled();
      expect(statusCalls()).toHaveLength(2);
    },
  );

  it.each([
    {
      name: "a reachable owner",
      owner: { ...OFFLINE_REMOTE_OWNER, status: "reachable" as const },
    },
    {
      name: "a local owner",
      owner: { ...OFFLINE_REMOTE_OWNER, hostKind: "local" as const },
    },
    {
      name: "an owner of unknown kind",
      owner: { ...OFFLINE_REMOTE_OWNER, hostKind: "unknown" as const },
    },
  ])("never dials $name", async ({ owner }) => {
    mockUseHostReachability.mockReturnValue(owner);
    const view = render(tile(true, true));
    await settled();
    expect(statusCalls()).toHaveLength(0);

    // The same mounted tile dials as soon as the owner qualifies, so the
    // silence above is the gate and not a harness that cannot send.
    mockUseHostReachability.mockReturnValue(OFFLINE_REMOTE_OWNER);
    view.rerender(tile(true, true));
    await waitFor(() => {
      expect(statusCalls()).toHaveLength(1);
    });
  });
});

/**
 * The copy converting ITSELF into the live tile, against the REAL canvas
 * store and a REAL open-epic session: the tile kind is chosen once at the
 * tap, so a copy opened while the owner was away used to stay a copy for the
 * tab's life with no way out but close-and-reopen. The decision is the
 * sidebar row's own, re-run from inside the tile, plus the proof the row does
 * not have: the epic's record for this chat under this owner host.
 */
describe("PublishedChatTile - conversion to the live tile", () => {
  const TAB_ID = "tab-1";
  const EPIC_ID = "epic-1";
  const REACHABLE_OWNER: MockHostReachability = {
    status: "reachable",
    hostLabel: "Ada's Mac",
  };
  /** A witness that has heard nothing: its presence is all the hook reads. */
  const WITNESS: RetainingChatServingWitness = {
    verdictFor: () => "unknown",
    subscribe: () => () => undefined,
    retain: () => () => undefined,
    reopen: () => undefined,
    servingFor: () => null,
  };
  const noopStreamClientFactory: EpicStreamClientFactory = () => ({
    applyUpdate: () => undefined,
    awareness: () => undefined,
    applyArtifactRoomUpdate: () => undefined,
    artifactRoomAwareness: () => undefined,
    retryMigration: () => undefined,
    close: () => undefined,
  });
  let session: OpenedStoreForTest;

  /** The epic's record for the copy's chat, persisted under `hostId`. */
  function seedChatRecord(hostId: string): void {
    const chat: ChatProjection = {
      id: NODE.chatId,
      title: NODE.name,
      parentId: null,
      createdAt: 1,
      updatedAt: 2,
      userId: NODE.ownerUserId,
      ownedByViewer: true,
      hostId,
      isTitleEditedByUser: false,
      docResident: null,
      settings: null,
      archivedAt: null,
    };
    session.store.setState({
      chats: { allIds: [chat.id], byId: { [chat.id]: chat } },
    });
  }

  /** Opens the copy as a tab the way a row does; returns its pane. */
  function openPublishedTab(node: PublishedChatTileRef): string {
    const store = useEpicCanvasStore.getState();
    store.openEpicTabWithId(TAB_ID, EPIC_ID, "Epic");
    store.openTileInTab(TAB_ID, node);
    const root = useEpicCanvasStore.getState().canvasByTabId[TAB_ID]?.root;
    if (root === undefined || root === null) {
      throw new Error("expected a canvas root");
    }
    return collectPanes(root)[0].id;
  }

  /** Every tab of the tab's canvas, in strip order. */
  function openTabs(): readonly EpicCanvasTileRef[] {
    const canvas = useEpicCanvasStore.getState().canvasByTabId[TAB_ID];
    if (canvas === undefined || canvas.root === null) return [];
    return collectPanes(canvas.root).flatMap((pane) =>
      pane.tabInstanceIds.flatMap((instanceId) => {
        const ref = canvas.tilesByInstanceId[instanceId];
        return ref === undefined ? [] : [ref];
      }),
    );
  }

  function renderCopy(
    node: PublishedChatTileRef,
    paneId: string,
    witness: RetainingChatServingWitness | null,
  ): void {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    render(
      <EpicSessionContext value={session}>
        <ChatServingWitnessContext value={witness}>
          <PublishedChatTile
            node={node}
            viewTabId={TAB_ID}
            tileId={paneId}
            isActive
            epicId={EPIC_ID}
          />
        </ChatServingWitnessContext>
      </EpicSessionContext>,
    );
  }

  beforeEach(() => {
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
    session = openStoreForTest({
      epicId: EPIC_ID,
      userId: NODE.ownerUserId,
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    });
    mockUseHostReachability.mockReturnValue(REACHABLE_OWNER);
  });

  afterEach(() => {
    session.dispose();
    resetHostOlderThanDataRefusalsForTests();
    useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  });

  it("replaces the copy with the live chat tile bound to the owner, in the same slot, once the owner is reachable", async () => {
    seedChatRecord(NODE.ownerHostId);
    const paneId = openPublishedTab(NODE);

    renderCopy(NODE, paneId, null);

    await waitFor(() => {
      expect(openTabs()).toEqual([
        expect.objectContaining({
          type: "chat",
          id: NODE.chatId,
          hostId: NODE.ownerHostId,
        }),
      ]);
    });
    // The copy is gone for good: not a closed tile a reopen gesture or
    // Back/Forward could put back over the live chat.
    expect(
      useEpicCanvasStore.getState().closedTilePayloadsByTabId[TAB_ID],
    ).toBeUndefined();
  });

  it("keeps the copy while the reachable owner refuses the epic's store", () => {
    seedChatRecord(NODE.ownerHostId);
    // The tile keys the refusal on the ref's task (the epic, in production).
    recordHostOlderThanDataRefusal({
      hostId: NODE.ownerHostId,
      epicId: NODE.taskId,
      hostVersion: null,
      now: 1,
    });
    const paneId = openPublishedTab(NODE);

    renderCopy(NODE, paneId, null);

    expect(openTabs()).toEqual([NODE]);
  });

  it("keeps the copy when the epic holds no record for the chat under that owner", () => {
    // A record the id matches but another host persisted: a fork clone, or
    // a cloud-only row - not proof the owner holds this chat live.
    seedChatRecord("another-host");
    const paneId = openPublishedTab(NODE);

    renderCopy(NODE, paneId, null);

    expect(openTabs()).toEqual([NODE]);
  });

  it("keeps the copy when the owner is the host serving it", () => {
    seedChatRecord(SAME_HOST_NODE.ownerHostId);
    const paneId = openPublishedTab(SAME_HOST_NODE);

    renderCopy(SAME_HOST_NODE, paneId, null);

    expect(openTabs()).toEqual([SAME_HOST_NODE]);
  });

  it("converts for an unreachable owner that is a team sandbox at rest, as the row opens it live", async () => {
    seedChatRecord(NODE.ownerHostId);
    const sandboxRow = remoteEntry(NODE.ownerHostId, {
      ...sandboxFacts("team-1"),
      state: "suspended",
    });
    installHostConnectionRegistrySource({
      directory: {
        findById: (hostId) =>
          hostId === sandboxRow.hostId ? { ...sandboxRow } : null,
        onDirectoryChanged: () => ({ dispose: () => undefined }),
      },
      leases: null,
    });
    mockUseHostReachability.mockReturnValue({
      status: "unreachable",
      hostLabel: "Team sandbox",
    });
    const paneId = openPublishedTab(NODE);

    renderCopy(NODE, paneId, WITNESS);

    await waitFor(() => {
      expect(openTabs()).toEqual([
        expect.objectContaining({
          type: "chat",
          id: NODE.chatId,
          hostId: NODE.ownerHostId,
        }),
      ]);
    });
  });
});

describe("PublishedChatTile - the sandbox's own state", () => {
  const ROW = sandboxSummaryFixture({
    id: "sbx-p",
    hostId: "owner-host-1",
    displayName: "e2e-sbx-stop3",
  });
  const RESTING: ChatSandboxState = {
    kind: "resting",
    sandbox: ROW,
    configuration: { kind: "personal" },
    wakeChangesPayer: false,
  };

  function signInAsOwner(): void {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: NODE.ownerUserId,
        userName: "Owner",
        email: "owner@example.com",
      },
      contextMetadata: { userId: NODE.ownerUserId, username: "Owner" },
    });
  }

  function mountCopy(): void {
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
  }

  it("says a destroyed sandbox in one footer line with its actions, and draws no banner", () => {
    sandboxSurface.state = {
      kind: "destroyed",
      ended: {
        name: "e2e-sbx-p3",
        end: {
          state: "destroyed",
          destroyedAt: new Date(2026, 9, 28, 0, 55).getTime(),
          cause: "resting",
          actor: null,
          idleMinutes: null,
        },
      },
    };
    signInAsOwner();
    mountCopy();

    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
    const footer = screen.getByTestId("chat-tile-session-view");
    expect(footer.textContent).toBe(
      "e2e-sbx-p3 was destroyed on Oct 28 at 00:55 after resting. Its files are gone; this chat stays readable.",
    );
    // Its actions ride in the same line, for the chat's own owner host.
    const actions = within(footer).getByTestId("sandbox-end-actions");
    expect(actions.getAttribute("data-source-host")).toBe("owner-host-1");
  });

  it("passes a resting sandbox to the session view so the composer can send, with no offline banner and no lock sentence", () => {
    sandboxSurface.state = RESTING;
    sandboxSurface.role = "editor";
    signInAsOwner();
    mountCopy();

    const call = chatTileSessionViewCalls.at(-1);
    expect(call?.restingSandbox).toEqual(RESTING);
    expect(call?.readOnlyNotice).toBeNull();
    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
  });

  it("withholds the resting send from a viewer role, who keeps the lock sentence", () => {
    sandboxSurface.state = RESTING;
    sandboxSurface.role = "viewer";
    signInAsOwner();
    mountCopy();

    const call = chatTileSessionViewCalls.at(-1);
    expect(call?.restingSandbox).toBeUndefined();
    expect(call?.readOnlyNotice).not.toBeNull();
  });

  it("shows no clone banner for a sandbox that is awake but cannot be reached; its footer says so", () => {
    sandboxSurface.state = {
      kind: "unreachable",
      sandbox: ROW,
      lastSeenAt: null,
    };
    signInAsOwner();
    mountCopy();

    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
    expect(screen.getByText(/running, but Traycer can’t connect/)).toBeTruthy();
  });
});

/**
 * The REAL state hook over its data sources: what a sandbox chat shows while
 * its state is moving or not yet known to this device, as after a Stop and
 * after a reload of a destroyed chat (§10).
 */
describe("PublishedChatTile - a sandbox chat whose state is not known yet", () => {
  const TASK_ROW: TaskHostRow = {
    hostId: "owner-host-1",
    label: "e2e-sbx-p1",
    principal: { kind: "user", id: "user-1" },
    reach: "same_principal",
    sandboxEnd: null,
  };

  function mountOwnCopy(): RenderResult {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: NODE.ownerUserId,
        userName: "Owner",
        email: "owner@example.com",
      },
      contextMetadata: { userId: NODE.ownerUserId, username: "Owner" },
    });
    // The directory has no row for the host, so reachability falls back to
    // the raw id, as `useHostReachability` does.
    mockUseHostReachability.mockReturnValue({
      status: "unreachable",
      hostLabel: "owner-host-1",
    });
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    return render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
  }

  it("draws no offline banner, no Clone and no offline footer while the sandbox is stopping", () => {
    sandboxSurface.sources = {
      taskHosts: { kind: "hosts", hosts: [TASK_ROW] },
      sandboxes: [
        sandboxSummaryFixture({
          id: "sbx-p1",
          hostId: "owner-host-1",
          displayName: "e2e-sbx-p1",
          state: "stopping",
        }),
      ],
      entry: {
        ...remoteEntry("owner-host-1", sandboxFacts(null)),
        label: "e2e-sbx-p1",
      },
    };
    mountOwnCopy();

    expect(screen.queryByTestId("published-chat-dead-tile-chat-1")).toBeNull();
    expect(screen.queryByRole("button", { name: "Clone agent" })).toBeNull();
    // A known move says what it is, once, never the generic unknown line.
    const text = screen.getByTestId("chat-tile-session-view").textContent;
    expect(text).toBe("Stopping e2e-sbx-p1 · pending");
  });

  it("never prints the raw host id of a sandbox the task names and the directory no longer lists, before and after its end arrives", () => {
    sandboxSurface.sources = {
      taskHosts: { kind: "hosts", hosts: [TASK_ROW] },
      sandboxes: [],
      entry: null,
    };
    const view = mountOwnCopy();

    expect(view.container.textContent).not.toContain("owner-host-1");

    sandboxSurface.sources = {
      ...sandboxSurface.sources,
      taskHosts: {
        kind: "hosts",
        hosts: [
          {
            ...TASK_ROW,
            sandboxEnd: {
              state: "destroyed",
              destroyedAt: new Date(2026, 9, 28, 1, 27).getTime(),
              cause: "verb",
              actor: "you",
              idleMinutes: null,
            },
          },
        ],
      },
    };
    view.rerender(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );

    expect(view.container.textContent).not.toContain("owner-host-1");
    expect(chatTileSessionViewCalls.at(-1)?.readOnlyNotice).toBe(
      "e2e-sbx-p1 was destroyed on Oct 28 at 01:27 by you. Its files are gone; this chat stays readable.",
    );
  });
});

/**
 * One precedence on the copy, through the real hook: a task end, then a
 * listed row's known state, then a move, then a named sandbox not known here.
 * A host nothing names as a sandbox takes the surface's own path.
 */
describe("PublishedChatTile - a sandbox chat's state, by precedence", () => {
  function mountOwnCopy(): void {
    useAuthStore.setState({
      status: "signed-in",
      profile: {
        userId: NODE.ownerUserId,
        userName: "Owner",
        email: "owner@example.com",
      },
      contextMetadata: { userId: NODE.ownerUserId, username: "Owner" },
    });
    mockUseHostReachability.mockReturnValue({
      status: "unreachable",
      hostLabel: "owner-host-1",
    });
    mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
    mockUseChatReplicaRead.mockReturnValue(replicaOk());
    render(
      <PublishedChatTile
        node={NODE}
        viewTabId="tab-1"
        tileId="pane-1"
        isActive
        epicId="epic-1"
      />,
    );
  }

  function listed(overrides: Partial<SandboxSummary>): SandboxSummary {
    return sandboxSummaryFixture({
      id: "sbx-p1",
      hostId: "owner-host-1",
      displayName: "e2e-sbx-p1",
      ...overrides,
    });
  }

  const FAILED_AT = new Date(2026, 9, 28, 1, 2).getTime();
  const FAILED_TIME = new Date(FAILED_AT).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  it("takes the ordinary offline path for a host nothing names as a sandbox, when both the task's hosts and the list fail", () => {
    sandboxSurface.sources = {
      taskHosts: { kind: "error", retry: () => undefined },
      sandboxes: null,
      entry: null,
    };
    mountOwnCopy();

    expect(screen.getByTestId("published-chat-dead-tile-chat-1")).toBeTruthy();
    expect(chatTileSessionViewCalls.at(-1)?.readOnlyNotice).not.toContain(
      "isn't available",
    );
  });

  it.each([
    ["suspended", "e2e-sbx-p1 is suspended"],
    ["stopped", "e2e-sbx-p1 is stopped"],
  ] as const)(
    "says a listed %s team sandbox's state alone, read-only with no wake, before its configuration resolves",
    (state, line) => {
      sandboxSurface.sources = {
        taskHosts: { kind: "none" },
        sandboxes: [
          listed({
            state,
            environmentId: "env-not-loaded",
            createdBy: { userId: "member-2", displayName: "Dana" },
          }),
        ],
        entry: null,
      };
      mountOwnCopy();

      // The composer's place is the state line, so there is no Send to press.
      expect(chatTileSessionViewCalls.at(-1)?.restingSandbox).toBeUndefined();
      expect(screen.getByTestId("chat-tile-session-view").textContent).toBe(
        line,
      );
      expect(document.body.textContent).not.toContain("your next message");
      expect(document.body.textContent).not.toContain("isn't available");
    },
  );

  it.each([
    [
      "failed",
      {
        state: "failed",
        failureCode: "boot-timeout",
        lastTransitionAt: FAILED_AT,
      },
      `Couldn't start e2e-sbx-p1 at ${FAILED_TIME} · SBX-0414 · nothing was chargedRetry`,
    ],
    [
      "released",
      { state: "released", kind: "automation" },
      "e2e-sbx-p1 is suspended · files kept · the next shell starts it",
    ],
    [
      "destroyed before the task records its end",
      { state: "destroyed" },
      "Destroying e2e-sbx-p1 · pending",
    ],
  ] as const)(
    "says a listed %s sandbox's own line, never the unknown one",
    (_state, overrides, line) => {
      sandboxSurface.sources = {
        taskHosts: { kind: "none" },
        sandboxes: [listed(overrides)],
        entry: null,
      };
      mountOwnCopy();

      expect(
        screen.queryByTestId("published-chat-dead-tile-chat-1"),
      ).toBeNull();
      expect(screen.getByTestId("chat-tile-session-view").textContent).toBe(
        line,
      );
    },
  );
});

/**
 * The unknown line is the state's, never the role's: a team member and a
 * collaborator looking at a sandbox whose state this device cannot read get
 * the same line the owner does.
 */
describe("PublishedChatTile - an unknown sandbox state, for every role", () => {
  const TEAM_ENVIRONMENTS: EnvironmentListResponse = {
    environments: [
      {
        environmentId: NODE.ownerUserId,
        ownerKind: "organization",
        ownerId: "org-1",
        roomId: "room-team",
        label: "acme",
      },
    ],
  };
  const PERSONAL_ONLY_ENVIRONMENTS: EnvironmentListResponse = {
    environments: [
      {
        environmentId: "viewer-user",
        ownerKind: "user",
        ownerId: "viewer-user",
        roomId: "room-personal",
        label: "Personal",
      },
    ],
  };

  it.each([
    ["a team member", TEAM_ENVIRONMENTS],
    ["a collaborator", PERSONAL_ONLY_ENVIRONMENTS],
  ] as const)(
    "gives %s the unknown line, by the sandbox's name",
    (_role, list) => {
      environments.pool = true;
      environments.list = list;
      useAuthStore.setState({
        status: "signed-in",
        profile: {
          userId: "viewer-user",
          userName: "Viewer",
          email: "viewer@example.com",
        },
        contextMetadata: { userId: "viewer-user", username: "Viewer" },
      });
      sandboxSurface.sources = {
        taskHosts: {
          kind: "hosts",
          hosts: [
            {
              hostId: "owner-host-1",
              label: "e2e-sbx-p1",
              principal: { kind: "team", id: "team-1" },
              reach: "same_principal",
              sandboxEnd: null,
            },
          ],
        },
        sandboxes: null,
        entry: null,
      };
      mockUseHostReachability.mockReturnValue({
        status: "unreachable",
        hostLabel: "owner-host-1",
      });
      mockUseCloudChatTranscript.mockReturnValue(refusedUnpublished());
      mockUseChatReplicaRead.mockReturnValue(replicaOk());
      render(
        <PublishedChatTile
          node={NODE}
          viewTabId="tab-1"
          tileId="pane-1"
          isActive
          epicId="epic-1"
        />,
      );

      expect(screen.getByTestId("chat-tile-session-view").textContent).toBe(
        "e2e-sbx-p1 isn't available — this chat stays readable.",
      );
      expect(
        screen.queryByTestId("published-chat-dead-tile-chat-1"),
      ).toBeNull();
    },
  );
});
