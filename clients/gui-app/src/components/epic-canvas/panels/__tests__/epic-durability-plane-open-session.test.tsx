import type { ReactNode } from "react";
import * as Y from "yjs";
import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
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
import {
  openStoreForTest,
  type OpenStoreForTestOptions,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

const EPIC_ID = "epic-durability-open-session";
const BODY_ARTIFACT_ID = "artifact-status-coverage";
const INITIAL_TITLE = "Durability evidence";
const POOL_EPOCH = "pool-mux-epoch-1";

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
  snapshot: EpicStatusSnapshotFrame,
  writeCommand: OpenStoreForTestOptions["writeCommand"],
  artifactId: string | null,
): Promise<StatusRig> {
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
  const handle = openStoreForTest({
    epicId: EPIC_ID,
    hostId,
    userId: "user-a",
    factories: {
      streamClientFactory: () => {
        throw new Error("the real status lane must own the control snapshot");
      },
      laneSelection,
    },
    writeCommand,
  });
  const { status: callbacks, state: stateCallbacks } = laneCallbacks;
  if (callbacks === null || stateCallbacks === null) {
    throw new Error("the lane factories did not capture their callbacks");
  }
  useAuthStore.setState({ status: "signed-in" });
  callbacks.onConnectionStatus("open", null, null, null);
  stateCallbacks.onConnectionStatus("open", null, null, null);
  callbacks.onSnapshot(snapshot, true);
  stateCallbacks.onSnapshot(stateSnapshot(snapshot.authorityEpoch, artifactId));
  await drain(handle);
  return { handle, callbacks, stateCallbacks, artifactLanes };
}

function CommentAvailability() {
  const availability = useEpicCommentRoomAvailability();
  return (
    <output data-testid="comment-room-availability">{availability.kind}</output>
  );
}

function StatusPill(props: { readonly children?: ReactNode }) {
  const durability = useEpicDurabilityPlane();
  return (
    <>
      <EpicConnectionPill epicId={EPIC_ID} durability={durability} />
      <CommentAvailability />
      {props.children}
    </>
  );
}

function renderStatus(handle: OpenedStoreForTest, children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <RunnerHostProvider runnerHost={buildRunnerHost()}>
      <QueryClientProvider client={queryClient}>
        <HostRuntimeProvider
          registry={hostRpcRegistry}
          messengerFactory={hostMessengerFactory}
          invalidator={null}
          requestId={null}
          remoteFetcher={() => Promise.resolve({ kind: "hosts", entries: [] })}
          fallback={<div data-testid="runtime-fallback">runtime loading</div>}
        >
          <EpicSessionContext.Provider value={handle}>
            <TooltipProvider>
              <StatusPill>{children}</StatusPill>
              <Toaster />
            </TooltipProvider>
          </EpicSessionContext.Provider>
        </HostRuntimeProvider>
      </QueryClientProvider>
    </RunnerHostProvider>,
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

afterEach(() => {
  toast.dismiss();
  cleanup();
  __getOpenEpicRegistryForTests().disposeAll();
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
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);

      await act(async () => {
        stateCallbacks.onDelta(titleDelta(POOL_EPOCH, title));
        await drain(handle);
      });
      expect(handle.store.getState().epic.title).toBe(title);
      expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);

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
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);

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

  it("keeps a pending pool comment in Saving and the real tab-close gate until success", async () => {
    const { handle } = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
      null,
      null,
    );
    const registry = registerCloseGate(handle);
    const answer = Promise.withResolvers<CreateCommentThreadResponse>();
    const client = poolCommentClient(() => answer.promise);
    signInForCommentWrite();

    try {
      renderStatus(handle, <CommentWriteButton client={client} />);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
      });

      fireEvent.click(screen.getByRole("button", { name: "Create comment" }));

      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("Saving changes");
      });
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(true);

      act(() => {
        answer.resolve({ threadId: "thread-comment-status" });
      });

      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
        expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);
      });
    } finally {
      registry.disposeAll();
    }
  });

  it("keeps an unknown pool comment neutral until its existing notice is dismissed", async () => {
    const { handle } = await openStatusRig(
      POOL_HOST_ID,
      POOL_SNAPSHOT,
      null,
      null,
    );
    const registry = registerCloseGate(handle);
    const answer = Promise.withResolvers<CreateCommentThreadResponse>();
    const client = poolCommentClient(() => answer.promise);
    signInForCommentWrite();

    try {
      renderStatus(handle, <CommentWriteButton client={client} />);
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
      });

      fireEvent.click(screen.getByRole("button", { name: "Create comment" }));

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

      expect(await screen.findByText(UNKNOWN_COMMENT_NOTICE)).not.toBeNull();
      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("Connected");
      });
      expect(pill().getAttribute("aria-label")).not.toBe("All changes synced");
      expect(epicHasUnsyncedEdits(EPIC_ID)).toBe(false);

      fireEvent.click(screen.getByRole("button", { name: "Close toast" }));

      await waitFor(() => {
        expect(pill().getAttribute("aria-label")).toBe("All changes synced");
      });
    } finally {
      registry.disposeAll();
    }
  });

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
});
