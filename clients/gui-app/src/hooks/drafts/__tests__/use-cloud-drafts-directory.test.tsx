import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { ListCloudChatsResponse } from "@traycer/protocol/host/epic/cloud-chat";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";

const scopeMock = vi.hoisted(() => ({ seq: 0 }));

// The directory only needs a fenceable scope: `draftsCloudScopeId` is fixed
// to a non-empty id so the query is enabled, `subscribeDraftsCloudScope`'s
// unsubscribe is never exercised here, and `cloudDraftIngestSeq` is the
// dial this test turns to prove the fence reads the DISPATCH-time value.
vi.mock("@/lib/drafts/draft-mirror-coordinator", () => ({
  cloudDraftIngestSeq: (): number => scopeMock.seq,
  draftsCloudScopeId: (): string | null => "scp_1",
  subscribeDraftsCloudScope: (): (() => void) => () => undefined,
}));

const { useCloudDraftsDirectory } =
  await import("@/hooks/drafts/use-cloud-drafts-directory");

const PROFILE = { userId: "viewer-1", userName: "V", email: "v@example.com" };
const CONTEXT = { userId: "viewer-1", username: "V" };

type Fixture = {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly requests: { value: number };
  readonly resolve: (response: ListCloudChatsResponse) => void;
};

function createFixture(): Fixture {
  const requests = { value: 0 };
  // A holder, not a narrowed `let`: TS narrows the local to `null` after the
  // assignment and the lint then calls the check below unnecessary.
  const resolver: {
    handler: ((response: ListCloudChatsResponse) => void) | null;
  } = { handler: null };
  const pending = new Promise<ListCloudChatsResponse>((resolve) => {
    resolver.handler = resolve;
  });
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-drafts-directory-1",
      handlers: {
        "epic.listCloudChats": () => {
          requests.value += 1;
          return pending;
        },
      },
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const client = spine.createRequester(mockLocalHostEntry);
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode =>
    createElement(QueryClientProvider, { client: queryClient }, props.children);
  const resolve = resolver.handler;
  if (resolve === null) {
    throw new Error("resolveHandler must be assigned synchronously");
  }
  return { client, queryClient, Wrapper, requests, resolve };
}

describe("useCloudDraftsDirectory snapshot fence", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
    scopeMock.seq = 0;
  });

  it("fences the snapshot on the ingest seq at DISPATCH, not on a later bump before the request settles", async () => {
    scopeMock.seq = 3;
    const fixture = createFixture();

    const view = renderHook(
      () => useCloudDraftsDirectory(fixture.client, mockLocalHostEntry.hostId),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(fixture.requests.value).toBe(1);
    });

    // The ingest sequence advances while the request is still in flight -
    // the fence must not pick this value up.
    scopeMock.seq = 9;

    fixture.resolve({ chats: [] });

    await waitFor(() => {
      expect(view.result.current.settled).toBe(true);
    });
    expect(view.result.current.snapshotIngestSeq()).toBe(3);
  });
});
