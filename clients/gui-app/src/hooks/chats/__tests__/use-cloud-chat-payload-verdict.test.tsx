import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
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
import { useCloudChatPayload } from "@/hooks/chats/use-cloud-chat-queries";

/**
 * The payload read re-reads the cloud verdict at DISPATCH.
 *
 * `enabled` stops the automatic fetch, but `refetch()` is a caller override
 * of `enabled` in TanStack v5, and the published-chat surfaces expose exactly
 * that as the Retry action of a failed side. So the property worth pinning is
 * about the wire: after a demotion, a refetch produces the refusal and the
 * host sees NO request; with the verdict back, the same refetch reaches it.
 */

const IDENTITY: CloudChatIdentity = {
  taskId: "task-1",
  chatId: "chat-1",
  ownerUserId: "owner-1",
};

const REF = { kind: "plan-content", sha256: "c".repeat(64) } as const;

const PROFILE = { userId: "viewer-1", userName: "V", email: "v@example.com" };
const CONTEXT = { userId: "viewer-1", username: "V" };

type Fixture = {
  readonly client: HostClient<HostRpcRegistry>;
  readonly queryClient: QueryClient;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
  /** Every `epic.readCloudChatPayload` that reached the messenger. */
  readonly requests: { value: number };
};

function createFixture(): Fixture {
  const requests = { value: 0 };
  const queryClient = createAppQueryClient();
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => `req-payload-${String(requests.value)}`,
      handlers: {
        // Counted, then refused as UNSUPPORTED: the one code the query does
        // not retry, so a request that reached the wire settles at once
        // instead of re-dialing on the retry ladder behind the assertions.
        "epic.readCloudChatPayload": () => {
          requests.value += 1;
          throw new HostRpcError({
            code: "E_HOST_UNSUPPORTED",
            message: "reached the wire",
            requestId: "req",
            method: "epic.readCloudChatPayload",
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
  return { client, queryClient, Wrapper, requests };
}

describe("useCloudChatPayload verdict at dispatch", () => {
  beforeEach(() => {
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
  });
  afterEach(() => {
    cleanup();
    useAuthStore.setState(useAuthStore.getInitialState(), true);
  });

  it("refuses a refetch after a demotion before the wire, and admits it once the verdict returns", async () => {
    const fixture = createFixture();
    const rendered = renderHook(
      () =>
        useCloudChatPayload({
          client: fixture.client,
          identity: IDENTITY,
          ref: REF,
          // Mounted idle, as a payload nobody has looked at yet is; the
          // Retry path is a refetch, and that is what is driven below.
          enabled: false,
        }),
      { wrapper: fixture.Wrapper },
    );
    expect(fixture.requests.value).toBe(0);

    useAuthStore.getState().setUnverifiedSession(PROFILE, CONTEXT);
    const refused = await rendered.result.current.refetch();
    expect(refused.error?.message).toBe(
      "This session no longer holds a cloud verdict, so the cloud chat read was not sent.",
    );
    expect(refused.error?.method).toBe("epic.readCloudChatPayload");
    expect(fixture.requests.value).toBe(0);

    // Non-vacuity: with the verdict back, the same gesture reaches the host.
    useAuthStore.getState().setSignedIn(PROFILE, CONTEXT, []);
    const admitted = await rendered.result.current.refetch();
    await waitFor(() => expect(fixture.requests.value).toBe(1));
    expect(admitted.error?.code).toBe("E_HOST_UNSUPPORTED");
  });
});
