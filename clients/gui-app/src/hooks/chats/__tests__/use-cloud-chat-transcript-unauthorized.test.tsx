import { afterEach, describe, expect, it } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { CloudChatIdentity } from "@traycer/protocol/host/epic/cloud-chat";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { createAppQueryClient } from "@/lib/query-client";
import { useAuthStore } from "@/stores/auth/auth-store";
import { useCloudChatTranscript } from "@/hooks/chats/use-cloud-chat-transcript";

/**
 * A WITHHELD cloud read must not be reported as a load in progress.
 *
 * Both transcript queries are gated on `authorizesCloudCapability`, so an
 * unverified session never dispatches either one: `data` stays undefined,
 * `error` stays null, and the composition settles on `loading` - forever.
 * `PublishedChatTile` fed that into `useBoundedHostLoad`, which bounds the
 * wait and then names the SERVING HOST as having failed to answer. Nothing
 * was ever asked of that host, and it may be serving local work in the same
 * tile at the time.
 *
 * The state is what the tile branches on, so it is what this pins.
 */

const IDENTITY: CloudChatIdentity = {
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "owner-1",
};

const PROFILE = { userId: "viewer-1", userName: "V", email: "v@example.com" };
const CONTEXT = { userId: "viewer-1", username: "V" };

function createFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  readonly reads: { value: number };
} {
  const reads = { value: 0 };
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-transcript-${String(reads.value)}`,
      handlers: {
        // Never reached under an unverified session - which is what the
        // counter below asserts. Present so that "no read went out" is a
        // measured fact rather than an absence nothing was watching for.
        //
        // They THROW rather than answer: the counter is the whole purpose, and
        // a refusal needs no response shape to keep in step with the schema.
        "epic.resolveCloudChatHead": () => {
          reads.value += 1;
          throw new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "reached the wire",
            requestId: "req",
            method: "epic.resolveCloudChatHead",
            fatalDetails: null,
          });
        },
        "epic.listCloudChatPayloads": () => {
          reads.value += 1;
          throw new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "reached the wire",
            requestId: "req",
            method: "epic.listCloudChatPayloads",
            fatalDetails: null,
          });
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
  return { client, queryClient, Wrapper, reads };
}

describe("useCloudChatTranscript under a withheld cloud verdict", () => {
  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("reports `unauthorized`, not `loading`, when the reads are withheld", () => {
    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    const fixture = createFixture();

    const rendered = renderHook(
      () =>
        useCloudChatTranscript({
          client: fixture.client,
          identity: IDENTITY,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(rendered.result.current.kind).toBe("unauthorized");
    // Non-vacuity for the counter: the state is not `unauthorized` because
    // the queries failed, it is `unauthorized` because they never ran.
    expect(fixture.reads.value).toBe(0);
  });

  it("keeps reporting `loading` while a HELD verdict has reads in flight", () => {
    // The control for the branch this change adds, and it is scoped to that
    // branch on purpose. The override replaces `loading` with `unauthorized`
    // only when the verdict is absent, so the property worth pinning is that
    // an otherwise identical render under a HELD verdict still says `loading`
    // - the reads are genuinely in flight, and a tile is right to wait.
    //
    // Deliberately not driven to a settled state: `useCloudChatRead` runs a
    // two-method pipeline (head resolve + part reads) behind a cache and a
    // digest, and standing all of that up would test the pipeline rather than
    // the one conditional under test.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const fixture = createFixture();

    const rendered = renderHook(
      () =>
        useCloudChatTranscript({
          client: fixture.client,
          identity: IDENTITY,
          enabled: true,
        }),
      { wrapper: fixture.Wrapper },
    );

    expect(rendered.result.current.kind).toBe("loading");
  });
});
