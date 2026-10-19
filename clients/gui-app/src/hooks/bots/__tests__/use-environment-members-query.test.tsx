/**
 * The member directory of one team environment as a resolver (Tracy Bots):
 * every page of `environment.members`, each asked for once the page before it
 * names its cursor; a member no answered page lists resolves to null so the
 * conversation shows their user id.
 *
 * Real hook over a mock messenger whose handler answers (or refuses) a page.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type { EnvironmentMembersResponse } from "@traycer/protocol/host/environment/contracts";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import type { BotMemberResolver } from "@/lib/bots/bot-member-names";
import { useEnvironmentMembers } from "@/hooks/bots/use-environment-members-query";

vi.mock("@/hooks/host/use-reactive-host-readiness", () => ({
  useReactiveHostReadiness: (client: HostRequester<HostRpcRegistry> | null) => {
    const hostId = client === null ? null : client.getActiveHostId();
    return {
      hostId,
      requestContextUserId: "user-1",
      isReady: hostId !== null,
      hasRpcEndpoint: hostId !== null,
      canExecute: hostId !== null,
    };
  },
}));

const ENVIRONMENT = "env-team";

function page(
  userId: string,
  nextCursor: string | null,
): EnvironmentMembersResponse {
  return {
    members: [{ userId, displayName: `Name of ${userId}`, avatarUrl: null }],
    nextCursor,
  };
}

function mountMembers(
  answerPage: (cursor: string | null) => EnvironmentMembersResponse,
  enabled: boolean,
): {
  readonly resolver: () => BotMemberResolver;
  readonly cursorsAsked: () => ReadonlyArray<string | null>;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const cursorsAsked: Array<string | null> = [];
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${String(++seq)}`,
    handlers: {
      "environment.members": ({ cursor }) => {
        cursorsAsked.push(cursor);
        return answerPage(cursor);
      },
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
  const client = spine.createRequester(mockLocalHostEntry);
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () => useEnvironmentMembers(client, ENVIRONMENT, enabled),
    { wrapper },
  );
  return {
    resolver: () => result.current,
    cursorsAsked: () => [...cursorsAsked],
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });
  });
}

describe("useEnvironmentMembers", () => {
  it("asks for the next page once the first names its cursor and resolves members from both", async () => {
    const mounted = mountMembers(
      (cursor) =>
        cursor === null ? page("user-a", "user-a") : page("user-b", null),
      true,
    );

    await waitFor(() => {
      expect(mounted.resolver()("user-a")?.displayName).toBe("Name of user-a");
      expect(mounted.resolver()("user-b")?.displayName).toBe("Name of user-b");
    });
    expect(mounted.cursorsAsked()).toEqual([null, "user-a"]);
  });

  it("sends no request while disabled and resolves nobody", async () => {
    const mounted = mountMembers(() => page("user-a", null), false);

    await settle();

    expect(mounted.cursorsAsked()).toEqual([]);
    expect(mounted.resolver()("user-a")).toBeNull();
  });

  it("resolves nobody when a page is refused, without throwing from the hook", async () => {
    const mounted = mountMembers(() => {
      throw new Error("refused");
    }, true);

    await waitFor(() => {
      expect(mounted.cursorsAsked()).toEqual([null]);
    });
    await settle();

    expect(mounted.resolver()("user-a")).toBeNull();
    expect(mounted.cursorsAsked()).toEqual([null]);
  });

  it("does not ask again for a cursor a later page repeats", async () => {
    const mounted = mountMembers(
      (cursor) =>
        cursor === null ? page("user-a", "user-a") : page("user-b", "user-a"),
      true,
    );

    await waitFor(() => {
      expect(mounted.resolver()("user-b")?.displayName).toBe("Name of user-b");
    });
    await settle();

    expect(mounted.cursorsAsked()).toEqual([null, "user-a"]);
  });
});
