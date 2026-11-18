/**
 * Making a bot main (Tracy Bots) changes `bot.list`'s `mainBotIds`, and that
 * list is the same through every host. So the write's success refreshes the
 * list on every host scope, not only the host the write was sent to: a list
 * read through host A, held by Home, follows a write made through host B.
 *
 * Real hooks over two hosts' mock messengers sharing one query client.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  HostClient,
  type HostRequester,
} from "@traycer-clients/shared/host-client/host-client";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  MockHostMessenger,
  type MockHandlerMap,
} from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useBotListQuery } from "@/hooks/bots/use-bot-list-query";
import { useEnvironmentSetMainBotMutation } from "@/hooks/bots/use-environment-set-main-bot-mutation";

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

const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BOT_B = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

/**
 * One host: its own messenger over the handlers it is given, sharing the query
 * client with the other host.
 */
function hostOver(
  entry: HostDirectoryEntry,
  queryClient: QueryClient,
  handlers: MockHandlerMap<HostRpcRegistry>,
): HostClient<HostRpcRegistry> {
  let seq = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `${entry.hostId}-${String(++seq)}`,
    handlers,
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) => (hostId === entry.hostId ? entry : null),
    messenger,
  });
  spine.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  return spine.createRequester(entry);
}

describe("useEnvironmentSetMainBotMutation", () => {
  it("sends environment.setMainBot and refreshes bot.list read through another host", async () => {
    const queryClient = new QueryClient();
    let mainBotIds: Record<string, string> = { "env-1": BOT_A };
    let listReads = 0;
    const requests: object[] = [];
    const hostA = hostOver(mockLocalHostEntry, queryClient, {
      "bot.list": () => {
        listReads += 1;
        return { bots: [], mainBotIds };
      },
    });
    const hostB = hostOver(mockRemoteHostEntry, queryClient, {
      "environment.setMainBot": (request) => {
        requests.push(request);
        mainBotIds = { "env-1": request.botId };
        return {
          environmentId: request.environmentId,
          mainBotId: request.botId,
        };
      },
    });
    const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        {props.children}
      </QueryClientProvider>
    );

    const { result } = renderHook(
      () => ({
        list: useBotListQuery(hostA, true),
        setMain: useEnvironmentSetMainBotMutation(hostB),
      }),
      { wrapper },
    );
    await waitFor(() => {
      expect(result.current.list.data?.mainBotIds).toEqual({ "env-1": BOT_A });
    });
    expect(listReads).toBe(1);

    await act(async () => {
      await result.current.setMain.mutateAsync({
        environmentId: "env-1",
        botId: BOT_B,
      });
    });

    expect(requests).toEqual([{ environmentId: "env-1", botId: BOT_B }]);
    await waitFor(() => {
      expect(result.current.list.data?.mainBotIds).toEqual({ "env-1": BOT_B });
    });
    expect(listReads).toBe(2);
  });
});
