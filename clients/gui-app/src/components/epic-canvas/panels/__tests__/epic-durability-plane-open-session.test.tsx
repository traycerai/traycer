import type { ReactNode } from "react";
import * as Y from "yjs";
import "../../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  POOL_HOST_ID,
  poolHostDirectoryEntry,
} from "@traycer-clients/shared/host-client/host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { MockRunnerHost } from "@traycer-clients/shared/host-client/mock/mock-runner-host";
import type { IHostMessenger } from "@traycer-clients/shared/host-transport/host-messenger";
import {
  HostRpcError,
  HostTransportFailureError,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  HostRuntimeProvider,
  type HostRpcRegistry,
} from "@/lib/host";
import { RunnerHostProvider } from "@/providers/runner-host-provider";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { fleetHost } from "@traycer-clients/shared/host-selection/__tests__/selection-authority-harness";
import { epicStateSubscribeServerFrameSchemaV11 } from "@traycer/protocol/host/epic/state-subscribe";
import { artifactSubscribeServerFrameSchemaV13 } from "@traycer/protocol/host/epic/artifact-subscribe";
import { epicStatusSubscribeServerFrameSchemaV12 } from "@traycer/protocol/host/epic/status-subscribe";
import type { CreateCommentThreadResponse } from "@traycer/protocol/host/epic/unary-schemas";
import type {
  EpicStatusSnapshotFrame,
  EpicStatusStreamCallbacks,
} from "@traycer-clients/shared/host-transport/epic-status-stream-client";
import type {
  EpicStateDeltaFrame,
  EpicStateStreamCallbacks,
  EpicStateSnapshotFrame,
} from "@traycer-clients/shared/host-transport/epic-state-stream-client";
import type { ArtifactStreamCallbacks } from "@traycer-clients/shared/host-transport/artifact-stream-client";
import type {
  ArtifactStreamClientFactory,
  EpicStateStreamClientFactory,
  EpicStatusStreamClientFactory,
} from "@traycer-clients/shared/epic-lanes";
import type { EpicLaneSelectionSources } from "@/stores/epics/open-epic/runtime/epic-replica-runtime";
import { absentLaneUnaries } from "@/stores/epics/open-epic/test-support/absent-lane-unaries";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { EpicConnectionPill } from "@/components/epic-canvas/panels/epic-connection-pill";
import { CLOUD_LINK_GRACE_MS } from "@/components/epic-canvas/panels/use-cloud-link-grace";
import { useEpicDurabilityPlane } from "@/components/epic-canvas/panels/epic-durability-plane";
import { useCreateCommentThreadForClient } from "@/hooks/comments/use-comment-thread-mutations";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useEpicCommentRoomAvailability } from "@/lib/epic-selectors";
import {
  __getOpenEpicRegistryForTests,
  epicHasUnsyncedEdits,
  EpicSessionContext,
} from "@/lib/registries/epic-session-registry";
import { useAuthStore } from "@/stores/auth/auth-store";
import { mountTestSelectionAuthority } from "@/lib/host/test-support/selection-authority-fixture";
import {
  __resetAgentActivityStoreForTests,
  __setHostAgentActivityHealthForTests,
} from "@/stores/agent-activity-store";
import {
  openStoreForTestAtHost,
  type OpenStoreForTestOptions,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-durability-open-session";
const BODY_ARTIFACT_ID = "artifact-status-coverage";
const INITIAL_TITLE = "Durability evidence";
const POOL_EPOCH = "pool-mux-epoch-1";
const PRESENCE_HOST_ID = "status-pill-presence-feed";
const COMPUTER_HOST_ID = "status-pill-computer";
const STREAM_DOWN_GRACE_MS = 2_000;
const STALE_AGENT_MESSAGE =
  "Live agent activity is unavailable. Agent status may be stale or unknown until it reconnects.";

interface PresenceHostRouting {
  localHostId: string | null;
  servingHostId: string | null;
}

const presenceHostRouting = vi.hoisted((): PresenceHostRouting => ({
  localHostId: null,
  servingHostId: null,
}));

vi.mock("@/hooks/host/use-reactive-local-host-id", () => ({
  useReactiveLocalHostId: () => presenceHostRouting.localHostId,
}));

vi.mock(
  "@/hooks/host/use-notifications-serving-host-entry",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@/hooks/host/use-notifications-serving-host-entry")
      >();
    const { useState } = await import("react");
    function useMockNotificationsServingHostId(): string | null {
      useState(0);
      return presenceHostRouting.servingHostId;
    }
    return {
      ...actual,
      useNotificationsServingHostId: useMockNotificationsServingHostId,
    };
  },
);

// Captured from task-read-protocol.test.ts through the pool's real mux status
// subscription. The pool's @1.6 status producer emits cloud durability at the
// top level and does not emit a localProtection answer.
const POOL_SNAPSHOT: EpicStatusSnapshotFrame = parseStatusSnapshot({
  kind: "snapshot",
  authorityEpoch: POOL_EPOCH,
  securityEpoch: 1,
  permissionRole: "editor",
  cloudSyncStatus: "connected",
  dirty: null,
  migration: null,
  deletion: { state: "none" },
  durability: "cloud",
  hasBinaryPayload: false,
});
const UNKNOWN_COMMENT_NOTICE =
  "No reply came back from the Traycer host, so this may or may not have gone through.";
function routePresenceFeed(hostId: string | null): void {
  presenceHostRouting.localHostId = hostId;
  presenceHostRouting.servingHostId = hostId;
}

function setStreamDownPresenceFeed(): void {
  routePresenceFeed(PRESENCE_HOST_ID);
  __setHostAgentActivityHealthForTests(PRESENCE_HOST_ID, {
    connectionStatus: "reconnecting",
  });
}

function setHealthyPresenceFeed(): void {
  routePresenceFeed(PRESENCE_HOST_ID);
  __setHostAgentActivityHealthForTests(PRESENCE_HOST_ID, {
    connectionStatus: "open",
    cloudSyncStatus: "connected",
  });
}

function setCloudDownPresenceFeed(): void {
  routePresenceFeed(PRESENCE_HOST_ID);
  __setHostAgentActivityHealthForTests(PRESENCE_HOST_ID, {
    connectionStatus: "open",
    cloudSyncStatus: "disconnected",
  });
}

function statusSnapshotWithArtifactSync(
  authorityEpoch: string,
  rooms: "retrying" | "stopped",
): EpicStatusSnapshotFrame {
  return parseStatusSnapshot({
    ...POOL_SNAPSHOT,
    authorityEpoch,
    artifactSync: { rooms, waitingNewArtifacts: 1 },
  });
}

function statusSnapshotForComputerWithArmedProtection(): EpicStatusSnapshotFrame {
  return parseStatusSnapshot({
    ...POOL_SNAPSHOT,
    authorityEpoch: "computer-armed-status-epoch-1",
    dirty: false,
    localProtection: "armed",
    freshness: {
      kind: "lastCloudSyncAt",
      reconciledAtEpochMs: 1_000,
      state: "current",
    },
  });
}

function advanceClock(milliseconds: number): void {
  act(() => {
    vi.advanceTimersByTime(milliseconds);
  });
}

function useGraceClock(): void {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

function pillText(): string {
  return pill().textContent;
}

interface PillPresentation {
  readonly status: string | null;
  readonly source: string | null;
  readonly text: string;
  readonly className: string;
  readonly ariaLabel: string | null;
}

function readPillPresentation(): PillPresentation {
  const button = pill();
  return {
    status: button.getAttribute("data-status"),
    source: button.getAttribute("data-source"),
    text: button.textContent,
    className: button.className,
    ariaLabel: button.getAttribute("aria-label"),
  };
}

async function captureIconOnlySaveStages(
  epicId: string,
  handle: OpenedStoreForTest,
): Promise<{
  readonly synced: PillPresentation;
  readonly saving: PillPresentation;
}> {
  const view = renderStatusForEpic(epicId, handle, undefined);
  await waitForPill();
  await waitForSyncedPill();
  const synced = readPillPresentation();
  await act(async () => {
    handle.doc.getMap("epic").set("title", `${epicId} is saving`);
    await drain(handle);
  });
  const saving = readPillPresentation();
  view.unmount();
  return { synced, saving };
}

function pillLiveRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>(
    '[role="status"][aria-live="polite"]',
  );
  if (region === null) throw new Error("the pill live region was not rendered");
  return region;
}

async function waitForPill(): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByTestId("epic-connection-pill")).not.toBeNull();
  });
}

async function waitForSyncedPill(): Promise<void> {
  await waitFor(() => {
    expect(pill().getAttribute("data-status")).toBe("synced");
  });
}

function buildRunnerHost(): MockRunnerHost {
  return new MockRunnerHost({
    signInUrl: "https://auth.traycer.invalid/sign-in",
    authnBaseUrl: "http://localhost:5005",
    localHost: null,
    hosts: [],
    workspaceFolderPickerPaths: undefined,
    hasLocalHost: undefined,
    traycerCli: undefined,
  });
}

const emptyRemoteFetcher = () =>
  Promise.resolve({ kind: "hosts" as const, entries: [] });

function hostMessengerFactory(args: {
  readonly registry: HostRpcRegistry;
}): IHostMessenger<HostRpcRegistry> {
  return new MockHostMessenger<HostRpcRegistry>({
    registry: args.registry,
    requestId: () => "durability-pill-test-request",
    handlers: {
      "host.status": () =>
        Promise.resolve({
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
          previousExit: null,
        }),
    },
  });
}

interface CapturedArtifactLane {
  readonly artifactId: string;
  readonly authorityEpoch: string;
  readonly callbacks: ArtifactStreamCallbacks;
}

interface StatusRig {
  readonly handle: OpenedStoreForTest;
  readonly callbacks: EpicStatusStreamCallbacks;
  readonly stateCallbacks: EpicStateStreamCallbacks;
  readonly artifactLanes: CapturedArtifactLane[];
}

function parseStatusSnapshot(
  frame: Record<string, unknown>,
): EpicStatusSnapshotFrame {
  const parsed = epicStatusSubscribeServerFrameSchemaV12.parse(frame);
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a status snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function stateSnapshot(
  authorityEpoch: string,
  artifactId: string | null,
): EpicStateSnapshotFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV11.parse({
    kind: "snapshot",
    hasBinaryPayload: false,
    authorityEpoch,
    basis: "cold",
    position: 1,
    reconciledWithCloud: true,
    artifactRecords:
      artifactId === null
        ? []
        : [
            {
              kind: "spec",
              id: artifactId,
              folderName: `${artifactId}-folder`,
              title: "Body coverage task",
              createdAt: 1000,
              updatedAt: 1000,
              createdManually: true,
              parentId: null,
              revision: 1,
            },
          ],
    deletedArtifacts: [],
    commentThreads: [],
    roleClaims: { revision: 1, claims: [] },
    epicMeta: {
      revision: 1,
      meta: { title: INITIAL_TITLE, updatedAt: 1000 },
    },
  });
  if (parsed.kind !== "snapshot") {
    throw new Error(`expected a state snapshot, got ${parsed.kind}`);
  }
  return parsed;
}

function statusSnapshotForComputer(): EpicStatusSnapshotFrame {
  return parseStatusSnapshot({
    ...POOL_SNAPSHOT,
    authorityEpoch: "computer-status-epoch-1",
  });
}

function statusSnapshotWithoutDurability(): EpicStatusSnapshotFrame {
  const { durability: _durability, ...unknownSnapshot } = POOL_SNAPSHOT;
  return parseStatusSnapshot({
    ...unknownSnapshot,
    authorityEpoch: "pool-unknown-epoch-1",
  });
}

async function drain(handle: OpenedStoreForTest): Promise<void> {
  await handle.flush();
  await handle.flush();
  await handle.flush();
}

function titleDelta(
  authorityEpoch: string,
  title: string,
): EpicStateDeltaFrame {
  const parsed = epicStateSubscribeServerFrameSchemaV11.parse({
    kind: "delta",
    hasBinaryPayload: false,
    authorityEpoch,
    seq: 2,
    artifactUpserts: [],
    artifactTombstones: [],
    commentThreadUpserts: [],
    commentThreadRemovals: [],
    epicMeta: { revision: 2, meta: { title, updatedAt: 2000 } },
    roleClaims: null,
  });
  if (parsed.kind !== "delta") {
    throw new Error("expected an epic title delta");
  }
  return parsed;
}

async function openStatusRig(
  hostId: string,
  snapshot: EpicStatusSnapshotFrame | null,
  writeCommand: OpenStoreForTestOptions["writeCommand"],
  artifactId: string | null,
): Promise<StatusRig> {
  return openStatusRigForEpic({
    epicId: EPIC_ID,
    hostId,
    snapshot,
    writeCommand,
    artifactId,
    stateAuthorityEpoch: snapshot?.authorityEpoch ?? POOL_EPOCH,
  });
}

interface OpenStatusRigForEpicOptions {
  readonly epicId: string;
  readonly hostId: string;
  readonly snapshot: EpicStatusSnapshotFrame | null;
  readonly writeCommand: OpenStoreForTestOptions["writeCommand"];
  readonly artifactId: string | null;
  readonly stateAuthorityEpoch: string;
}

async function openStatusRigForEpic(
  options: OpenStatusRigForEpicOptions,
): Promise<StatusRig> {
  const {
    epicId,
    hostId,
    snapshot,
    writeCommand,
    artifactId,
    stateAuthorityEpoch,
  } = options;
  const laneCallbacks: {
    status: EpicStatusStreamCallbacks | null;
    state: EpicStateStreamCallbacks | null;
  } = { status: null, state: null };
  const artifactLanes: CapturedArtifactLane[] = [];
  const statusFactory: EpicStatusStreamClientFactory = (_epicId, callbacks) => {
    laneCallbacks.status = callbacks;
    return { close: () => undefined };
  };
  const stateFactory: EpicStateStreamClientFactory = (_epicId, callbacks) => {
    laneCallbacks.state = callbacks;
    return { close: () => undefined };
  };
  const artifactFactory: ArtifactStreamClientFactory = ({
    artifactId: subscribedArtifactId,
    authorityEpoch,
    callbacks,
  }) => {
    artifactLanes.push({
      artifactId: subscribedArtifactId,
      authorityEpoch,
      callbacks,
    });
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };
  const laneSelection: EpicLaneSelectionSources = {
    support: () => "supported",
    subscribeSupport: () => () => undefined,
    unaries: absentLaneUnaries(),
    stateStreamClientFactory: stateFactory,
    statusStreamClientFactory: statusFactory,
    artifactStreamClientFactory: artifactFactory,
  };
  const handle = openStoreForTestAtHost(
    {
      epicId,
      userId: "user-a",
      factories: {
        streamClientFactory: () => {
          throw new Error("the real status lane must own the control snapshot");
        },
        laneSelection,
      },
      writeCommand,
    },
    hostId,
  );
  const { status: callbacks, state: stateCallbacks } = laneCallbacks;
  if (callbacks === null || stateCallbacks === null) {
    throw new Error("the lane factories did not capture their callbacks");
  }
  useAuthStore.setState({ status: "signed-in" });
  callbacks.onConnectionStatus("open", null, null, null);
  stateCallbacks.onConnectionStatus("open", null, null, null);
  if (snapshot !== null) callbacks.onSnapshot(snapshot, true);
  stateCallbacks.onSnapshot(stateSnapshot(stateAuthorityEpoch, artifactId));
  await drain(handle);
  return { handle, callbacks, stateCallbacks, artifactLanes };
}

function CommentAvailability() {
  const availability = useEpicCommentRoomAvailability();
  return (
    <output data-testid="comment-room-availability">{availability.kind}</output>
  );
}

function StatusPill(props: {
  readonly epicId: string;
  readonly children: ReactNode;
}) {
  const durability = useEpicDurabilityPlane();
  return (
    <>
      <EpicConnectionPill epicId={props.epicId} durability={durability} />
      <CommentAvailability />
      {props.children}
    </>
  );
}

function renderStatus(handle: OpenedStoreForTest, children: ReactNode) {
  return renderStatusForEpic(EPIC_ID, handle, children);
}

interface StatusTreeSession {
  readonly epicId: string;
  readonly handle: OpenedStoreForTest;
}

function statusTree(
  session: StatusTreeSession,
  children: ReactNode,
  queryClient: QueryClient,
  runnerHost: MockRunnerHost,
) {
  const { epicId, handle } = session;
  return (
    <RunnerHostProvider runnerHost={runnerHost}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={hostMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={emptyRemoteFetcher}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <EpicSessionContext.Provider value={handle}>
            <TooltipProvider>
              <StatusPill epicId={epicId}>{children}</StatusPill>
              <Toaster />
            </TooltipProvider>
          </EpicSessionContext.Provider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>
  );
}

function renderStatusForEpic(
  epicId: string,
  handle: OpenedStoreForTest,
  children: ReactNode,
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    statusTree({ epicId, handle }, children, queryClient, buildRunnerHost()),
  );
}

const COMMENT_REQUEST = {
  epicId: EPIC_ID,
  artifactType: "spec" as const,
  artifactId: "artifact-comment-status",
  content: { type: "doc", content: [] },
  quotedText: "",
};

function CommentWriteButton(props: {
  readonly client: HostClient<HostRpcRegistry>;
}) {
  const mutation = useCreateCommentThreadForClient(props.client);
  return (
    <button
      type="button"
      onClick={() =>
        void mutation.mutateAsync(COMMENT_REQUEST).catch(() => undefined)
      }
    >
      Create comment
    </button>
  );
}

function poolCommentClient(
  answer: () => Promise<CreateCommentThreadResponse>,
): HostClient<HostRpcRegistry> {
  const entry = poolHostDirectoryEntry("wss://pool.test");
  if (entry === null) throw new Error("expected a configured pool entry");
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(new QueryClient()),
    findHostById: (hostId) => (hostId === POOL_HOST_ID ? entry : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "pool-comment-write-request",
      handlers: { "epic.createCommentThread": answer },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "pool-comment-test-token",
    }),
  );
  return spine.createRequester(entry);
}

function registerCloseGate(handle: OpenedStoreForTest) {
  const registry = __getOpenEpicRegistryForTests();
  registry.acquireMounted(EPIC_ID, () => handle);
  return registry;
}

function signInForCommentWrite(): void {
  useAuthStore.getState().setSignedIn(
    {
      userId: "user-a",
      userName: "User A",
      email: "user-a@example.test",
    },
    { userId: "user-a", username: "user-a" },
    [],
  );
}

function pill(): HTMLButtonElement {
  return screen.getByTestId("epic-connection-pill");
}

function expectNoRedDot(): void {
  expect(pill().innerHTML).not.toContain("bg-red-500");
  expect(pill().innerHTML).not.toContain("bg-destructive");
}

beforeEach(() => {
  routePresenceFeed(null);
  __resetAgentActivityStoreForTests();
});

afterEach(() => {
  vi.useRealTimers();
  toast.dismiss();
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
  __resetAgentActivityStoreForTests();
  routePresenceFeed(null);
  useAuthStore.getState().setSignedOut();
});

describe("open-session durability status in the connection pill", () => {
  it("uses the pool's explicit unknown dirty snapshot and keeps renderer edits pending", async () => {
    const { handle } = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
      null,
      null,
    );
    try {
      renderStatus(handle, undefined);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
        expect(
          screen.getByTestId("comment-room-availability").textContent,
        ).toBe("available");
      });
      expect(handle.store.getState().rootDirty).toBeNull();
      expectNoRedDot();

      await act(async () => {
        handle.doc
          .getMap("epic")
          .set("title", "Renderer has an unacknowledged edit");
        await drain(handle);
      });
      expect(handle.store.getState().isDirty).toBe(true);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      });
      expectNoRedDot();
    } finally {
      handle.dispose();
    }
  });

  it("keeps a sending pool title pending through its matching state frame until the unary answers", async () => {
    const answer = Promise.withResolvers<{ readonly hostId: string }>();
    const { handle, stateCallbacks } = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
      () => answer.promise,
      null,
    );
    const registry = registerCloseGate(handle);
    const title = "Title frame before unary";

    try {
      renderStatus(handle, undefined);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
      });

      const commandId = await handle.store.getState().enqueueWriteCommand({
        kind: "update-epic-title",
        title,
        updatedAt: 2000,
      });
      expect(commandId).not.toBeNull();
      await act(async () => {
        await drain(handle);
      });

      const sending = handle.store
        .getState()
        .writeCommands.find((command) => command.commandId === commandId);
      if (sending === undefined)
        throw new Error("the title command was not queued");
      expect(sending.delivery).toBe("sending");
      expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);

      await act(async () => {
        stateCallbacks.onDelta(titleDelta(POOL_EPOCH, title));
        await drain(handle);
      });
      expect(handle.store.getState().epic.title).toBe(title);
      expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);

      await act(async () => {
        answer.resolve({ hostId: POOL_HOST_ID });
        await drain(handle);
      });
      await waitFor(() => {
        const settled = handle.store
          .getState()
          .writeCommands.find((command) => command.commandId === commandId);
        expect(settled?.state).toBe("committed");
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
        expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);
      });
    } finally {
      registry.disposeAll();
      handle.dispose();
    }
  });

  it("retires a pool title from pending after an independent definitive refusal", async () => {
    const answer = Promise.withResolvers<{ readonly hostId: string }>();
    const { handle } = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
      () => answer.promise,
      null,
    );
    const registry = registerCloseGate(handle);
    const title = "Authoritative title after refusal";

    try {
      renderStatus(handle, undefined);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
      });

      const commandId = await handle.store.getState().enqueueWriteCommand({
        kind: "update-epic-title",
        title,
        updatedAt: 2000,
      });
      expect(commandId).not.toBeNull();
      await act(async () => {
        await drain(handle);
      });
      expect(handle.store.getState().epic.title).toBe(title);
      expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);

      await act(async () => {
        answer.reject(
          new HostRpcError({
            code: "FORBIDDEN",
            message: "The title update was refused",
            requestId: "pool-title-refusal",
            method: "epic.updateTitle",
            fatalDetails: null,
          }),
        );
        await drain(handle);
      });
      await waitFor(() => {
        const settled = handle.store
          .getState()
          .writeCommands.find((command) => command.commandId === commandId);
        expect(settled?.state).toBe("rejected");
        expect(handle.store.getState().epic.title).toBe(INITIAL_TITLE);
        expect(pill().getAttribute("aria-label")).toContain("Change not saved");
        expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);
      });
    } finally {
      registry.disposeAll();
      handle.dispose();
    }
  });

  it.each([
    { order: "reflected update before coverage", coverageFirst: false },
    { order: "coverage before reflected update", coverageFirst: true },
  ])(
    "settles pool body coverage after reconnect and fresh status ($order)",
    async ({ coverageFirst }) => {
      const { handle, callbacks, stateCallbacks, artifactLanes } =
        await openStatusRig(
          POOL_HOST_ID,
          POOL_SNAPSHOT,
          null,
          BODY_ARTIFACT_ID,
        );
      const registry = registerCloseGate(handle);
      const releaseBody = handle.store
        .getState()
        .acquireArtifactBodyLease(BODY_ARTIFACT_ID);

      try {
        renderStatus(handle, undefined);
        await waitFor(() => {
          expect(artifactLanes).toHaveLength(1);
        });

        const lane = artifactLanes.at(0);
        if (lane === undefined)
          throw new Error("artifact stream was not opened");
        const seed = new Y.Doc();
        const document = artifactSubscribeServerFrameSchemaV13.parse({
          kind: "doc",
          hasBinaryPayload: true,
          authorityEpoch: lane.authorityEpoch,
          artifactId: BODY_ARTIFACT_ID,
          docGuid: "pool-body-doc-guid",
          stateVectorBase64: encodeDocStateVectorBase64(seed),
        });
        if (document.kind !== "doc")
          throw new Error("expected body seed frame");
        lane.callbacks.onDoc(document, Y.encodeStateAsUpdate(seed));
        await drain(handle);
        seed.destroy();

        const fragment = handle.store
          .getState()
          .getArtifactFragment(BODY_ARTIFACT_ID);
        if (fragment === null || fragment.doc === null) {
          throw new Error("body doc was not materialized from the pool stream");
        }
        const bodyDoc = fragment.doc;
        const text = new Y.XmlText();
        text.insert(0, "Unacknowledged body edit");
        fragment.insert(0, [text]);
        await act(async () => {
          await drain(handle);
        });

        await waitFor(() => {
          expect(pill().getAttribute("aria-label")).toBe("Saving changes");
          expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);
        });

        await act(async () => {
          callbacks.onConnectionStatus("reconnecting", null, null, null);
          stateCallbacks.onConnectionStatus("reconnecting", null, null, null);
          lane.callbacks.onConnectionStatus("reconnecting", null, null, null);
          await drain(handle);
        });
        expect(pill().getAttribute("data-status")).toBe("reconnecting");
        expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);

        await act(async () => {
          callbacks.onConnectionStatus("open", null, null, null);
          stateCallbacks.onConnectionStatus("open", null, null, null);
          lane.callbacks.onConnectionStatus("open", null, null, null);
          callbacks.onSnapshot(POOL_SNAPSHOT, true);
          stateCallbacks.onSnapshot(
            stateSnapshot(POOL_EPOCH, BODY_ARTIFACT_ID),
          );
          await drain(handle);
        });
        expect(pill().getAttribute("aria-label")).toBe("Saving changes");
        expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);

        const hostBody = new Y.Doc();
        Y.applyUpdate(hostBody, Y.encodeStateAsUpdate(bodyDoc));
        const update = artifactSubscribeServerFrameSchemaV13.parse({
          kind: "docUpdate",
          hasBinaryPayload: true,
          authorityEpoch: lane.authorityEpoch,
          artifactId: BODY_ARTIFACT_ID,
          docGuid: "pool-body-doc-guid",
        });
        if (update.kind !== "docUpdate") {
          throw new Error("expected reflected body update frame");
        }
        const ack = artifactSubscribeServerFrameSchemaV13.parse({
          kind: "docAck",
          hasBinaryPayload: false,
          authorityEpoch: lane.authorityEpoch,
          artifactId: BODY_ARTIFACT_ID,
          docGuid: "pool-body-doc-guid",
          coverageStateVectorBase64: encodeDocStateVectorBase64(hostBody),
        });
        if (ack.kind !== "docAck")
          throw new Error("expected doc coverage frame");

        const reflectBody = async (): Promise<void> => {
          await act(async () => {
            lane.callbacks.onDocUpdate(update, Y.encodeStateAsUpdate(hostBody));
            await drain(handle);
          });
        };
        const acknowledgeCoverage = async (): Promise<void> => {
          await act(async () => {
            lane.callbacks.onDocAck(ack);
            await drain(handle);
          });
        };

        if (coverageFirst) {
          await acknowledgeCoverage();
          await waitFor(() => {
            expect(pill().getAttribute("aria-label")).toBe(
              "All changes synced",
            );
            expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);
          });
          await reflectBody();
        } else {
          await reflectBody();
          expect(pill().getAttribute("aria-label")).toBe("Saving changes");
          expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);
          await acknowledgeCoverage();
        }

        await waitFor(() => {
          expect(pill().getAttribute("aria-label")).toBe("All changes synced");
          expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);
        });
        hostBody.destroy();
      } finally {
        releaseBody();
        registry.disposeAll();
        handle.dispose();
      }
    },
  );

  it.each([
    { order: "status first", statusFirst: true },
    { order: "comment first", statusFirst: false },
  ])(
    "shows a pending pool comment without guarding tab close ($order)",
    async ({ statusFirst }) => {
      const { handle, callbacks } = await openStatusRig(
        POOL_HOST_ID,
        statusFirst ? POOL_SNAPSHOT : null,
        null,
        null,
      );
      const registry = registerCloseGate(handle);
      const answer = Promise.withResolvers<CreateCommentThreadResponse>();
      const client = poolCommentClient(() => answer.promise);
      signInForCommentWrite();

      try {
        renderStatus(handle, <CommentWriteButton client={client} />);
        const button = await screen.findByRole("button", {
          name: "Create comment",
        });
        expect(pill().getAttribute("aria-label") === "All changes synced").toBe(
          statusFirst,
        );

        fireEvent.click(button);
        await waitFor(() => {
          expect(pill().getAttribute("aria-label")).toBe("Saving changes");
        });
        expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);

        if (!statusFirst) {
          await act(async () => {
            callbacks.onSnapshot(POOL_SNAPSHOT, true);
            await drain(handle);
          });
          expect(handle.store.getState().hasFreshCloudSyncStatus).toBe(true);
          expect(pill().getAttribute("aria-label")).toBe("Saving changes");
        }

        act(() => {
          answer.resolve({ threadId: "thread-comment-status" });
        });
        await waitFor(() => {
          expect(pill().getAttribute("aria-label")).toBe("All changes synced");
        });
      } finally {
        registry.disposeAll();
      }
    },
  );

  it.each([
    { session: "attached", detach: false },
    { session: "detached", detach: true },
  ])(
    "reports a transient unknown pool comment on a $session session",
    async ({ detach }) => {
      const { handle } = await openStatusRig(
        POOL_HOST_ID,
        POOL_SNAPSHOT,
        null,
        null,
      );
      const registry = registerCloseGate(handle);
      const dispatched = Promise.withResolvers<void>();
      const answer = Promise.withResolvers<CreateCommentThreadResponse>();
      const client = poolCommentClient(() => {
        dispatched.resolve();
        return answer.promise;
      });
      signInForCommentWrite();

      try {
        renderStatus(handle, <CommentWriteButton client={client} />);
        fireEvent.click(
          await screen.findByRole("button", { name: "Create comment" }),
        );
        await act(async () => {
          await dispatched.promise;
        });
        expect(pill().getAttribute("aria-label")).toBe("Saving changes");

        if (detach) {
          await act(async () => {
            handle.detachTransport();
            await drain(handle);
          });
        }

        act(() => {
          answer.reject(
            new HostTransportFailureError({
              code: "RPC_ERROR",
              message: "response was lost after dispatch",
              requestId: "pool-comment-request",
              method: "epic.createCommentThread",
              fatalDetails: null,
            }),
          );
        });

        await screen.findByText(UNKNOWN_COMMENT_NOTICE);
        const notice = toast
          .getToasts()
          .find(
            (entry) =>
              "title" in entry && entry.title === UNKNOWN_COMMENT_NOTICE,
          );
        if (notice === undefined || !("title" in notice)) {
          throw new Error("expected the indeterminate outcome toast");
        }
        expect(notice.id).toMatch(/^owner-host-batch-result:\d+$/);
        expect(notice.duration).toBeUndefined();
        expect(handle.store.getState().poolCommentWrites.size).toBe(0);
        if (!detach) {
          expect(pill().getAttribute("aria-label")).toBe("All changes synced");
        }
      } finally {
        registry.disposeAll();
      }
    },
  );

  it("keeps the computer's omitted backup leg unknown beside positive cloud durability", async () => {
    const { handle } = await openStatusRig(
      "computer-serving-epic",
      statusSnapshotForComputer(),
      null,
      null,
    );
    try {
      renderStatus(handle, undefined);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe(
          "New edits — backup status unknown",
        );
      });
      expectNoRedDot();
    } finally {
      handle.dispose();
    }
  });

  it("keeps an omitted negotiated pool durability leg unknown", async () => {
    const { handle } = await openStatusRig(
      POOL_HOST_ID,
      statusSnapshotWithoutDurability(),
      null,
      null,
    );
    try {
      renderStatus(handle, undefined);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toContain(
          "Storage status unknown",
        );
      });
      expect(pill().getAttribute("aria-label")).not.toContain(
        "All changes synced",
      );
      expect(pill().getAttribute("data-status")).toBe("connected");
      expectNoRedDot();
    } finally {
      handle.dispose();
    }
  });

  it("keeps pool artifact saving and synced icon-only while stream-down stays secondary", async () => {
    const answer = Promise.withResolvers<{ readonly hostId: string }>();
    const rig = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
      () => answer.promise,
      null,
    );
    setHealthyPresenceFeed();

    try {
      const rendered = renderStatus(rig.handle, undefined);
      await waitForPill();
      await waitForSyncedPill();
      useGraceClock();
      act(() => {
        setStreamDownPresenceFeed();
      });
      advanceClock(STREAM_DOWN_GRACE_MS);

      expect(pill().getAttribute("data-source")).toBe("artifact");
      expect(pill().getAttribute("data-status")).toBe("synced");
      expect(pillText()).toBe("");
      expect(pill().querySelector(".truncate")).toBeNull();
      expect(pill().getAttribute("aria-label")).toContain("All changes synced");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);
      expect(pillLiveRegion(rendered.container).textContent).toBe("");

      vi.useRealTimers();
      fireEvent.focus(pill());
      const tooltip = await screen.findByRole("tooltip");
      expect(tooltip.textContent).toContain("All changes synced");
      expect(tooltip.textContent).toContain(STALE_AGENT_MESSAGE);

      const commandId = await rig.handle.store.getState().enqueueWriteCommand({
        kind: "update-epic-title",
        title: "Pool title still saving",
        updatedAt: 2000,
      });
      if (commandId === null)
        throw new Error("the title command was not queued");
      await act(async () => {
        await drain(rig.handle);
      });
      expect(pill().getAttribute("data-source")).toBe("artifact");
      expect(pill().getAttribute("data-status")).toBe("syncing");
      expect(pillText()).toBe("");
      expect(pill().getAttribute("aria-label")).toContain("Saving changes");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);
      expect(pillLiveRegion(rendered.container).textContent).toBe("");

      await act(async () => {
        rig.stateCallbacks.onDelta(
          titleDelta(POOL_EPOCH, "Pool title still saving"),
        );
        await drain(rig.handle);
        answer.resolve({ hostId: POOL_HOST_ID });
        await drain(rig.handle);
      });
      await waitForSyncedPill();

      const settled = rig.handle.store
        .getState()
        .writeCommands.find((command) => command.commandId === commandId);
      expect(settled?.state).toBe("committed");
      expect(pill().getAttribute("data-source")).toBe("artifact");
      expect(pill().getAttribute("data-status")).toBe("synced");
      expect(pillText()).toBe("");
      expect(pill().getAttribute("aria-label")).toContain("All changes synced");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);
      expect(pillLiveRegion(rendered.container).textContent).toBe("");
    } finally {
      rig.handle.dispose();
    }
  });

  it("keeps ordinary pool and computer save visuals icon-only", async () => {
    const poolRig = await openStatusRigForEpic({
      epicId: "status-pill-icon-only-pool",
      hostId: POOL_HOST_ID,
      snapshot: POOL_SNAPSHOT,
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: POOL_EPOCH,
    });
    const computerRig = await openStatusRigForEpic({
      epicId: "status-pill-icon-only-computer",
      hostId: COMPUTER_HOST_ID,
      snapshot: statusSnapshotForComputerWithArmedProtection(),
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: "computer-armed-status-epoch-1",
    });

    try {
      routePresenceFeed(null);
      const poolStages = await captureIconOnlySaveStages(
        "status-pill-icon-only-pool",
        poolRig.handle,
      );
      const computerStages = await captureIconOnlySaveStages(
        "status-pill-icon-only-computer",
        computerRig.handle,
      );

      expect(poolStages.synced).toEqual(computerStages.synced);
      expect(poolStages.saving).toEqual(computerStages.saving);
      expect(poolStages.synced.text).toBe("");
      expect(poolStages.saving.text).toBe("");
      expect(poolStages.synced.source).toBe("artifact");
      expect(poolStages.saving.source).toBe("artifact");
    } finally {
      poolRig.handle.dispose();
      computerRig.handle.dispose();
    }
  });

  it("keeps an existing artifact-sync warning ahead of pool stream-down", async () => {
    const epicId = "status-pill-stopped-warning";
    const control = await openStatusRigForEpic({
      epicId,
      hostId: POOL_HOST_ID,
      snapshot: POOL_SNAPSHOT,
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: POOL_EPOCH,
    });
    const artifactSync = await openStatusRigForEpic({
      epicId,
      hostId: POOL_HOST_ID,
      snapshot: statusSnapshotWithArtifactSync(POOL_EPOCH, "stopped"),
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: POOL_EPOCH,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = buildRunnerHost();
    setHealthyPresenceFeed();

    try {
      const rendered = render(
        statusTree(
          { epicId, handle: control.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      await waitForPill();
      useGraceClock();
      act(() => {
        setStreamDownPresenceFeed();
      });
      rendered.rerender(
        statusTree(
          { epicId, handle: artifactSync.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      advanceClock(CLOUD_LINK_GRACE_MS);

      expect(pill().getAttribute("data-source")).toBe("artifact-sync");
      expect(pillText()).toBe("");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);
      expect(pillLiveRegion(rendered.container).textContent).toContain(
        STALE_AGENT_MESSAGE,
      );

      fireEvent.focus(pill());
      advanceClock(500);
      expect(screen.getByRole("tooltip").textContent).toContain(
        STALE_AGENT_MESSAGE,
      );
    } finally {
      control.handle.dispose();
      artifactSync.handle.dispose();
    }
  });

  it("leaves the artifact-sync retry activity tie ahead of pool stream-down", async () => {
    const epicId = "status-pill-retry-activity";
    const control = await openStatusRigForEpic({
      epicId,
      hostId: POOL_HOST_ID,
      snapshot: POOL_SNAPSHOT,
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: POOL_EPOCH,
    });
    const artifactSync = await openStatusRigForEpic({
      epicId,
      hostId: POOL_HOST_ID,
      snapshot: statusSnapshotWithArtifactSync(POOL_EPOCH, "retrying"),
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: POOL_EPOCH,
    });
    await act(async () => {
      artifactSync.handle.doc
        .getMap("epic")
        .set("title", "A local edit is saving");
      await drain(artifactSync.handle);
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = buildRunnerHost();
    setHealthyPresenceFeed();

    try {
      const rendered = render(
        statusTree(
          { epicId, handle: control.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      await waitForPill();
      useGraceClock();
      act(() => {
        setStreamDownPresenceFeed();
      });
      rendered.rerender(
        statusTree(
          { epicId, handle: artifactSync.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      advanceClock(CLOUD_LINK_GRACE_MS);

      expect(pill().getAttribute("data-source")).toBe("artifact-sync");
      expect(pill().getAttribute("data-status")).toBe("syncing");
      expect(pillText()).toBe("");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);
      expect(pillLiveRegion(rendered.container).textContent).toBe("");
    } finally {
      control.handle.dispose();
      artifactSync.handle.dispose();
    }
  });

  it("keeps cloud-down as the presence winner on a pool-served session", async () => {
    const rig = await openStatusRig(POOL_HOST_ID, POOL_SNAPSHOT, null, null);
    const authority = mountTestSelectionAuthority({
      hosts: [fleetHost(COMPUTER_HOST_ID, "remote")],
      savedPick: COMPUTER_HOST_ID,
      readyComputers: [COMPUTER_HOST_ID],
    });
    expect(authority.snapshot().servingPeer).toEqual({
      kind: "computer",
      hostId: COMPUTER_HOST_ID,
    });
    setHealthyPresenceFeed();

    try {
      const rendered = renderStatus(rig.handle, undefined);
      await waitForPill();
      await waitForSyncedPill();
      useGraceClock();
      act(() => {
        setCloudDownPresenceFeed();
      });
      advanceClock(CLOUD_LINK_GRACE_MS);

      expect(pill().getAttribute("data-source")).toBe("agent-activity");
      expect(pillText()).toBe("Remote agent status unavailable");
      expect(pill().getAttribute("aria-label")).toContain(
        "This device can’t reach the cloud right now",
      );
      expect(pillLiveRegion(rendered.container).textContent).toContain(
        "This device can’t reach the cloud right now",
      );
    } finally {
      rig.handle.dispose();
    }
  });

  it.each([{ route: "computer" }, { route: "pool" }])(
    "keeps computer stream-down visible when the account route says $route",
    async ({ route }) => {
      const rig = await openStatusRig(
        COMPUTER_HOST_ID,
        statusSnapshotForComputerWithArmedProtection(),
        null,
        null,
      );
      const authority = mountTestSelectionAuthority({
        hosts: [fleetHost(COMPUTER_HOST_ID, "remote")],
        savedPick: COMPUTER_HOST_ID,
        readyComputers: [COMPUTER_HOST_ID],
      });
      expect(authority.snapshot().servingPeer).toEqual({
        kind: "computer",
        hostId: COMPUTER_HOST_ID,
      });
      if (route === "pool") {
        act(() => {
          expect(authority.goCold(COMPUTER_HOST_ID).servingPeer).toEqual({
            kind: "pool",
          });
        });
      }
      setHealthyPresenceFeed();

      try {
        const rendered = renderStatus(rig.handle, undefined);
        await waitForPill();
        await waitForSyncedPill();
        useGraceClock();
        act(() => {
          setStreamDownPresenceFeed();
        });
        advanceClock(STREAM_DOWN_GRACE_MS);

        expect(pill().getAttribute("data-source")).toBe("agent-activity");
        expect(pillText()).toBe("Agent status may be stale");
        expect(pill().getAttribute("aria-label")).toContain(
          STALE_AGENT_MESSAGE,
        );
        expect(pillLiveRegion(rendered.container).textContent).toContain(
          STALE_AGENT_MESSAGE,
        );
      } finally {
        rig.handle.dispose();
      }
    },
  );

  it("follows the published handle across computer, pool and computer without restarting the feed grace", async () => {
    const epicId = "status-pill-serving-handle-transition";
    const computerA = await openStatusRigForEpic({
      epicId,
      hostId: COMPUTER_HOST_ID,
      snapshot: statusSnapshotForComputerWithArmedProtection(),
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: "computer-armed-status-epoch-1",
    });
    const poolCandidate = await openStatusRigForEpic({
      epicId,
      hostId: POOL_HOST_ID,
      snapshot: null,
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: POOL_EPOCH,
    });
    const computerB = await openStatusRigForEpic({
      epicId,
      hostId: COMPUTER_HOST_ID,
      snapshot: null,
      writeCommand: null,
      artifactId: null,
      stateAuthorityEpoch: "computer-armed-status-epoch-1",
    });
    const authority = mountTestSelectionAuthority({
      hosts: [fleetHost(COMPUTER_HOST_ID, "remote")],
      savedPick: COMPUTER_HOST_ID,
      readyComputers: [COMPUTER_HOST_ID],
    });
    expect(authority.snapshot().servingPeer).toEqual({
      kind: "computer",
      hostId: COMPUTER_HOST_ID,
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 0 } },
    });
    const runnerHost = buildRunnerHost();
    setHealthyPresenceFeed();

    try {
      const rendered = render(
        statusTree(
          { epicId, handle: computerA.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      await waitForPill();
      await waitForSyncedPill();
      useGraceClock();
      act(() => {
        setStreamDownPresenceFeed();
      });
      advanceClock(STREAM_DOWN_GRACE_MS);
      expect(pill().getAttribute("data-source")).toBe("agent-activity");
      expect(pillText()).toBe("Agent status may be stale");

      act(() => {
        expect(authority.goCold(COMPUTER_HOST_ID).servingPeer).toEqual({
          kind: "pool",
        });
      });
      expect(
        poolCandidate.handle.store.getState().hasFreshCloudSyncStatus,
      ).toBe(false);
      rendered.rerender(
        statusTree(
          { epicId, handle: computerA.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      expect(pill().getAttribute("data-source")).toBe("agent-activity");
      expect(pillText()).toBe("Agent status may be stale");

      vi.useRealTimers();
      await act(async () => {
        poolCandidate.callbacks.onSnapshot(POOL_SNAPSHOT, true);
        await drain(poolCandidate.handle);
      });
      expect(
        poolCandidate.handle.store.getState().hasFreshCloudSyncStatus,
      ).toBe(true);
      rendered.rerender(
        statusTree(
          { epicId, handle: poolCandidate.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      expect(pill().getAttribute("data-source")).toBe("artifact");
      expect(pill().getAttribute("data-status")).toBe("synced");
      expect(pillText()).toBe("");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);

      act(() => {
        expect(authority.connectComputer(COMPUTER_HOST_ID).servingPeer).toEqual(
          { kind: "pool" },
        );
        expect(authority.finishReturnDamping().servingPeer).toEqual({
          kind: "computer",
          hostId: COMPUTER_HOST_ID,
        });
      });
      rendered.rerender(
        statusTree(
          { epicId, handle: poolCandidate.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      expect(pill().getAttribute("data-source")).toBe("artifact");
      expect(pill().getAttribute("data-status")).toBe("synced");
      expect(pillText()).toBe("");

      expect(computerB.handle.store.getState().hasFreshCloudSyncStatus).toBe(
        false,
      );
      await act(async () => {
        computerB.callbacks.onSnapshot(
          statusSnapshotForComputerWithArmedProtection(),
          true,
        );
        await drain(computerB.handle);
      });
      rendered.rerender(
        statusTree(
          { epicId, handle: computerB.handle },
          undefined,
          queryClient,
          runnerHost,
        ),
      );
      expect(pill().getAttribute("data-source")).toBe("agent-activity");
      expect(pillText()).toBe("Agent status may be stale");
      expect(pill().getAttribute("aria-label")).toContain(STALE_AGENT_MESSAGE);
    } finally {
      computerA.handle.dispose();
      poolCandidate.handle.dispose();
      computerB.handle.dispose();
    }
  });
});
