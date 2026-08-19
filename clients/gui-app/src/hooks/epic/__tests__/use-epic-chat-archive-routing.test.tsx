import { type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import {
  hostRpcRegistry,
  type HostRpcRegistry,
} from "@traycer/protocol/host/index";
import type { SetChatArchivedRequest } from "@traycer/protocol/host/epic/unary-schemas";
import { useEpicArchiveChat } from "@/hooks/epic/use-epic-chat-mutations";
import { EpicSessionHostClientContext } from "@/lib/registries/epic-session-registry";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

interface ArchiveRoutingFixture {
  readonly client: HostClient<HostRpcRegistry>;
  readonly requests: SetChatArchivedRequest[];
  readonly wrapper: (props: { readonly children: ReactNode }) => ReactNode;
}

function createArchiveRoutingFixture(): ArchiveRoutingFixture {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const requests: SetChatArchivedRequest[] = [];
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => "archive-routing-request",
    handlers: {
      "epic.setChatArchived": (request) => {
        requests.push(request);
        return { updated: true };
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
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "archive-routing-token",
    }),
  );
  const client = spine.createRequester(mockLocalHostEntry);

  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      <EpicSessionHostClientContext.Provider value={client}>
        {props.children}
      </EpicSessionHostClientContext.Provider>
    </QueryClientProvider>
  );
  return { client, requests, wrapper };
}

afterEach(() => {
  cleanup();
});

describe("useEpicArchiveChat session routing", () => {
  it("dispatches through the session client via the real host mutation", async () => {
    const fixture = createArchiveRoutingFixture();
    const { result } = renderHook(() => useEpicArchiveChat(), {
      wrapper: fixture.wrapper,
    });
    const request = {
      epicId: "epic-routing-test",
      chatId: "chat-routing-test",
      archived: true,
    } satisfies SetChatArchivedRequest;

    await act(async () => {
      await result.current.mutateAsync(request);
    });

    expect(fixture.requests).toEqual([request]);
    fixture.client.dispose();
  });
});
