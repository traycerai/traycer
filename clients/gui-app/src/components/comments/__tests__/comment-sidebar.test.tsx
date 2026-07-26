import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
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
import { useCommentThreadsStore } from "@/stores/comments/comment-threads-store";

const EPIC_ID = "epic-1";
const ARTIFACT_ID = "artifact-1";
const QUOTED_TEXT = "the sentence this thread hangs off";

// `useHostClient` is the only thing replaced. The real `useEpicCommentThreads`,
// the real `useHostQuery`, the real query client and the real error path all
// run - which is the point: the defect under test is what the component does
// with a query result the host actually produced.
const hostClientRef: { current: HostClient<HostRpcRegistry> | null } = {
  current: null,
};

// Mocked at `@/lib/host/runtime`, the module that owns the binding: the
// threads query reaches it re-exported through `@/lib/host` while the thread
// cards' mutation hooks import it directly, and only this target covers both.
vi.mock("@/lib/host/runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/host/runtime")>();
  return { ...actual, useHostClient: () => hostClientRef.current };
});

// Read behavior for the next `epic.listCommentThreads` call. Tests swap this
// mid-flight to model an outage arriving after a successful read.
let respondToListThreads: () => ListCommentThreadsResponse = () => ({
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
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    messenger,
  });
  client.bind(mockLocalHostEntry);
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  hostClientRef.current = client;
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  hostClientRef.current = null;
  useCommentThreadsStore.setState({
    activeByEpicId: {},
    hoverByEpicId: {},
    flashByEpicId: {},
    draftByEpicId: {},
    artifactByEpicId: {},
  });
});

function renderSidebar() {
  return render(
    <QueryClientProvider client={queryClient}>
      <CommentSidebar
        epicId={EPIC_ID}
        artifactType="spec"
        artifactId={ARTIFACT_ID}
        anchorPositions={{ positions: new Map() }}
        currentUserId="user-1"
        canModerate={false}
        onActivateThread={() => undefined}
      />
    </QueryClientProvider>,
  );
}

function unavailablePanel(): Element | null {
  return document.querySelector('[data-slot="comment-sidebar-unavailable"]');
}

function emptyPanel(): Element | null {
  return document.querySelector('[data-slot="comment-sidebar-empty"]');
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
  it("says comments could not be LOADED - never that there are none - when the cold read fails", async () => {
    respondToListThreads = unavailableHost;

    renderSidebar();

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
    expect(unavailablePanel()).not.toBeNull();
  });

  it("still renders the empty state when the read SUCCEEDS with no threads", async () => {
    respondToListThreads = () => ({ threads: [] });

    renderSidebar();

    expect(await screen.findByText(/No open comments/)).not.toBeNull();
    expect(unavailablePanel()).toBeNull();
    expect(emptyPanel()).not.toBeNull();
  });

  it("keeps the last successful threads on screen when a REFETCH fails", async () => {
    respondToListThreads = () => ({ threads: [threadFixture()] });

    renderSidebar();
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
