import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import type {
  CommentThreadWire,
  ListCommentThreadsResponse,
} from "@traycer/protocol/host/epic/unary-schemas";
import type { HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { CommentSidebar } from "@/components/comments/comment-sidebar";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "artifact-1";
const QUOTED_TEXT = "the sentence this thread hangs off";

// The client is a PROP now, not an ambient read. `CommentSidebar` is mounted
// from `epic-sidebar.tsx`, which is a sibling of the canvas and therefore
// outside every `<TabHostProvider>`; its owner resolves the EPIC SESSION's
// client and hands it down (D15). Nothing under `components/comments/` reads a
// host itself any more, so the `@/lib/host/runtime` mock this file used to
// carry is gone - and its absence is the positive control: a re-added app-wide
// read would throw outside a provider instead of quietly answering.
//
// Everything else stays real - the real `useEpicCommentThreadsForClient`, the
// real `useHostQuery`, the real query client and the real error path - which is
// the point: the defect under test is what the component does with a query
// result the host actually produced.
const hostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};

// A SECOND live client on a DIFFERENT host, standing in for the app-wide one
// during an A->B re-point. Nothing this file renders may reach it: the sidebar
// is handed the Epic session's client and every hook below it takes that
// client as an argument.
const otherHostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};
let otherHostListCalls = 0;

// Read behavior for the next `epic.listCommentThreads` call. Tests swap this
// mid-flight to model an outage arriving after a successful read.
let respondToListThreads: () =>
  ListCommentThreadsResponse | Promise<ListCommentThreadsResponse> = () => ({
  threads: [],
});

function unavailableHost(): never {
  // What the host really throws while the artifact room's collab provider is
  // null: `comment-thread-rpc-core.ts` raises `no_active_session`, the resolver
  // rethrows, and the client sees an RPC error with no body.
  throw new Error("no_active_session");
}

function threadFixture(): CommentThreadWire {
  return {
    threadId: "thread-1",
    resolved: false,
    createdAt: 1,
    comments: [
      {
        commentId: "comment-1",
        content: { type: "doc", content: [] },
        createdAt: 1,
        updatedAt: null,
        author: { userId: "user-1", fallbackHandle: "someone" },
      },
    ],
    data: { createdByUserId: "user-1", quotedText: QUOTED_TEXT },
  };
}

let queryClient: QueryClient;
let messenger: MockHostMessenger<HostRpcRegistry>;
/** Cloud-homed open-epic session for the read-failure suite: the sidebar now
 *  reads durability via `useEpicDurabilityStatus`, which requires a live
 *  epic session. Default is non-local so those cases still exercise the RPC
 *  path rather than the local-mode gate. */
let defaultEpicHandle: OpenEpicStoreHandle;

beforeEach(() => {
  respondToListThreads = () => ({ threads: [] });
  queryClient = createAppQueryClient();
  let requestCount = 0;
  messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${String((requestCount += 1))}`,
    handlers: {
      "epic.listCommentThreads": () => respondToListThreads(),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostClientRef.current = spine.createRequester(mockLocalHostEntry);
  defaultEpicHandle = createOpenEpicStore({
    epicId: EPIC_ID,
    streamClientFactory: noopEpicStreamClientFactory,
    userId: "user-1",
    onAuthError: null,
  });
  // Cloud-backed epics leave durability unset; only local lifecycle states
  // populate this field. That keeps the normal list-query assertions below.
  defaultEpicHandle.store.setState({ durabilityStatus: null });

  otherHostListCalls = 0;
  let otherRequestCount = 0;
  const otherSpine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockRemoteHostEntry.hostId ? mockRemoteHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-other-${String((otherRequestCount += 1))}`,
      handlers: {
        "epic.listCommentThreads": () => {
          otherHostListCalls += 1;
          return { threads: [] };
        },
      },
    }),
  });
  otherSpine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-2" }),
  );
  otherHostClientRef.current = otherSpine.createRequester(mockRemoteHostEntry);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  hostClientRef.current = null;
  defaultEpicHandle.dispose();
  otherHostClientRef.current = null;
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
});

const noopEpicStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function renderSidebar(epicHandle: OpenEpicStoreHandle) {
  return render(
    <QueryClientProvider client={queryClient}>
      <EpicSessionContext.Provider value={epicHandle}>
        <CommentSidebar
          epicId={EPIC_ID}
          hostClient={hostClientRef.current}
          artifactType="spec"
          artifactId={ARTIFACT_ID}
          anchorPositions={{ positions: new Map() }}
          currentUserId="user-1"
          canModerate={false}
          onActivateThread={() => undefined}
        />
      </EpicSessionContext.Provider>
    </QueryClientProvider>,
  );
}

// Queried by role, which is also the assertion that the correction is
// announced: it is the only `status` region the sidebar renders. The empty and
// loading panels below stay on `data-slot` deliberately — neither is a live
// region, and giving static content a `status` role to make it queryable would
// announce "No open comments" as if something had just changed.
function unavailablePanel(): Element | null {
  return screen.queryByRole("status");
}

function emptyPanel(): Element | null {
  return document.querySelector('[data-slot="comment-sidebar-empty"]');
}

function loadingPanel(): Element | null {
  return document.querySelector('[data-slot="comment-sidebar-loading"]');
}

// The query client keeps production defaults (one retry, ~1s backoff), so an
// error verdict needs more than the 1s `waitFor` default.
const ERROR_SETTLE_TIMEOUT_MS = 8_000;

function queryStatuses(): ReadonlyArray<string> {
  return queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.state.status);
}

describe("<CommentSidebar /> read failures", () => {
  it("keeps the spinner visible for an enabled cold query that is actively fetching", async () => {
    let resolveResponse = (_response: ListCommentThreadsResponse): void => {
      throw new Error("missing pending response");
    };
    respondToListThreads = () =>
      new Promise<ListCommentThreadsResponse>((resolve) => {
        resolveResponse = resolve;
      });

    renderSidebar(defaultEpicHandle);

    await waitFor(() => {
      expect(loadingPanel()).not.toBeNull();
    });
    expect(unavailablePanel()).toBeNull();
    expect(emptyPanel()).toBeNull();

    await act(async () => {
      resolveResponse({ threads: [] });
      // Flush the query promise's resolution INSIDE `act`, so the state update
      // it triggers is covered rather than firing after act has exited (which
      // React reports as an un-acted update). Also what makes this arrow
      // genuinely async - `require-await` correctly rejected it without this.
      await Promise.resolve();
    });
    expect(await screen.findByText(/No open comments/)).not.toBeNull();
  });

  it("says comments could not be loaded when the cold query is disabled without a host client", async () => {
    hostClientRef.current = null;

    renderSidebar(defaultEpicHandle);

    expect(
      await screen.findByText("Comments couldn't be loaded."),
    ).not.toBeNull();
    expect(screen.queryByText(/No open comments/)).toBeNull();
    expect(screen.queryByText(/No comments on this artifact yet/)).toBeNull();
    expect(emptyPanel()).toBeNull();
    expect(unavailablePanel()).not.toBeNull();
  });

  it("says comments could not be LOADED - never that there are none - when the cold read fails", async () => {
    respondToListThreads = unavailableHost;

    renderSidebar(defaultEpicHandle);

    expect(
      await screen.findByText(
        "Comments couldn't be loaded.",
        {},
        { timeout: ERROR_SETTLE_TIMEOUT_MS },
      ),
    ).not.toBeNull();
    // The regression this pins: a user with live threads being told, in the
    // same window the host treats as a normal reconnect, that they have none.
    expect(screen.queryByText(/No open comments/)).toBeNull();
    expect(screen.queryByText(/No comments on this artifact yet/)).toBeNull();
    expect(emptyPanel()).toBeNull();
    const panel = unavailablePanel();
    expect(panel).not.toBeNull();
    // Announced once the reader finishes, not by interrupting.
    expect(panel?.getAttribute("aria-live")).toBe("polite");
  });

  it("still renders the empty state when the read SUCCEEDS with no threads", async () => {
    respondToListThreads = () => ({ threads: [] });

    renderSidebar(defaultEpicHandle);

    expect(await screen.findByText(/No open comments/)).not.toBeNull();
    expect(unavailablePanel()).toBeNull();
    expect(emptyPanel()).not.toBeNull();
  });

  it("keeps the last successful threads on screen when a REFETCH fails", async () => {
    respondToListThreads = () => ({ threads: [threadFixture()] });

    renderSidebar(defaultEpicHandle);
    expect(await screen.findByText(QUOTED_TEXT)).not.toBeNull();

    respondToListThreads = unavailableHost;
    await act(async () => {
      await queryClient.invalidateQueries();
    });
    // Non-vacuous: the query really is in the error state - it just still
    // holds data, which is what separates this from the cold read above.
    await waitFor(
      () => {
        expect(queryStatuses()).toContain("error");
      },
      { timeout: ERROR_SETTLE_TIMEOUT_MS },
    );
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .every((query) => query.state.data !== undefined),
    ).toBe(true);

    expect(unavailablePanel()).toBeNull();
    expect(screen.getByText(QUOTED_TEXT)).not.toBeNull();
  });
});

describe("<CommentSidebar /> local durability honesty", () => {
  let epicHandle: OpenEpicStoreHandle | null = null;
  let listThreadsCalls = 0;

  beforeEach(() => {
    listThreadsCalls = 0;
    respondToListThreads = () => {
      listThreadsCalls += 1;
      return { threads: [threadFixture()] };
    };
    epicHandle = createOpenEpicStore({
      epicId: EPIC_ID,
      streamClientFactory: noopEpicStreamClientFactory,
      userId: "user-1",
      onAuthError: null,
    });
  });

  afterEach(() => {
    epicHandle?.dispose();
    epicHandle = null;
  });

  it("shows the explicit local comments-unavailable panel without a generic RPC failure", async () => {
    if (epicHandle === null) {
      throw new Error("expected open epic handle");
    }
    // Real open-epic store slot the sidebar reads via useEpicDurabilityStatus.
    epicHandle.store.setState({ durabilityStatus: "local" });

    renderSidebar(epicHandle);

    expect(
      await screen.findByText(
        "Comments need a cloud room, and this epic has none.",
      ),
    ).not.toBeNull();
    expect(
      screen.getByText("This epic is stored on this device."),
    ).not.toBeNull();
    // Must not fall into the generic RPC-failure copy.
    expect(screen.queryByText("Comments couldn't be loaded.")).toBeNull();
    expect(screen.queryByText(/This doesn't mean there are none/)).toBeNull();
    expect(screen.queryByText(/No open comments/)).toBeNull();
    expect(unavailablePanel()).not.toBeNull();
    // Local mode disables the list query — honesty without a failed RPC.
    expect(listThreadsCalls).toBe(0);
    expect(queryStatuses()).not.toContain("error");
  });

  it("still loads threads for a non-local epic through the real query path", async () => {
    if (epicHandle === null) {
      throw new Error("expected open epic handle");
    }
    epicHandle.store.setState({ durabilityStatus: null });

    renderSidebar(epicHandle);

    expect(await screen.findByText(QUOTED_TEXT)).not.toBeNull();
    expect(listThreadsCalls).toBeGreaterThan(0);
    expect(
      screen.queryByText("Comments need a cloud room, and this epic has none."),
    ).toBeNull();
  });

  it("keeps comments gated through the promoting window, against the same null provider", async () => {
    if (epicHandle === null) {
      throw new Error("expected open epic handle");
    }
    // The reserved-but-pre-cutover state. The promotion is recorded and the
    // upload is in flight, but the artifact room's collab provider is still
    // null - so the host answers `no_active_session` and the old gate, keyed
    // on exactly "local", let the request through to collect it.
    epicHandle.store.setState({
      durabilityStatus: "promoting",
      durabilityPromotionState: "active",
    });

    renderSidebar(epicHandle);

    expect(
      await screen.findByText(
        "Comments need a cloud room, and this epic has none.",
      ),
    ).not.toBeNull();
    // The copy states the condition rather than predicting cloud sync.
    expect(
      screen.getByText("This epic is still uploading to the cloud."),
    ).not.toBeNull();
    // The defect was a generic failure standing in for a known boundary.
    expect(screen.queryByText("Comments couldn't be loaded.")).toBeNull();
    // Arrangement fidelity: the RPC was never issued, so the panel is not
    // merely the error state wearing better copy.
    expect(listThreadsCalls).toBe(0);
    expect(queryStatuses()).not.toContain("error");
  });
});

// D15. The sidebar sits outside every `<TabHostProvider>`, so before this it
// read the app-wide client - and during an A->B re-point the A-backed Epic kept
// rendering while that client already answered B, sending
// `epic.listCommentThreads` to the wrong machine and caching the answer under
// B's key. Both clients below are live; only the one passed as a prop may be
// reached.
describe("<CommentSidebar /> host scope", () => {
  it("reads threads on the PASSED client and keys the cache under ITS host", async () => {
    respondToListThreads = () => ({ threads: [threadFixture()] });

    render(
      <QueryClientProvider client={queryClient}>
        <CommentSidebar
          epicId={EPIC_ID}
          hostClient={hostClientRef.current}
          artifactType="spec"
          artifactId={ARTIFACT_ID}
          anchorPositions={{ positions: new Map() }}
          currentUserId="user-1"
          canModerate={false}
          onActivateThread={() => undefined}
        />
      </QueryClientProvider>,
    );

    // The session host answered...
    expect(await screen.findByText(QUOTED_TEXT)).not.toBeNull();
    // ...and the other host - live, and one prop away from being asked - did
    // not. Asserting the miss as well as the hit is what makes this arm fail
    // when the read goes ambient again rather than merely when it breaks.
    expect(otherHostListCalls).toBe(0);
    expect(otherHostClientRef.current?.getActiveHostId()).toBe(
      mockRemoteHostEntry.hostId,
    );

    const keys = queryClient
      .getQueryCache()
      .getAll()
      .map((query) => query.queryKey);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain(mockLocalHostEntry.hostId);
    expect(keys[0]).not.toContain(mockRemoteHostEntry.hostId);
  });
});
