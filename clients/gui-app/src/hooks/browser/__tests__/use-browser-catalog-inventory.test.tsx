import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { BrowserCatalogReadResponse } from "@traycer/protocol/host/browser/discovery-contracts";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import {
  mockLocalHostEntry,
  mockRemoteHostEntry,
} from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { createAuthenticatedUserFixture } from "@traycer-clients/shared/test-fixtures/authenticated-user";
import { useBrowserCatalogInventory } from "@/hooks/browser/use-browser-catalog-inventory";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { browserMutationKeys } from "@/lib/query-keys/browser-mutation-keys";

vi.mock("@/components/epic-tabs/pane-visibility-context", () => ({
  usePaneVisible: () => true,
}));
vi.mock("@/hooks/host/use-host-directory-list-query", () => ({
  useHostDirectoryList: () => ({ data: [] }),
}));

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise(value),
  };
}

interface ReaderHarness {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly queryClient: QueryClient;
}

function queryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false, gcTime: 0 },
    },
  });
}

function wrapperFor(
  client: QueryClient,
): (props: { readonly children: ReactNode }) => ReactNode {
  return ({ children }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function readerHarness(
  hostId: string,
  userId: string,
  queryCache: QueryClient,
  read: () => Promise<BrowserCatalogReadResponse>,
): ReaderHarness {
  const entry = {
    ...(hostId === mockLocalHostEntry.hostId
      ? mockLocalHostEntry
      : mockRemoteHostEntry),
    hostId,
    websocketUrl: `wss://${hostId}.traycer.test/rpc`,
  };
  let requestNumber = 0;
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => {
      requestNumber += 1;
      return `${hostId}-request-${String(requestNumber)}`;
    },
    handlers: {
      "browser.catalog.read": () => read(),
    },
  });
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryCache),
    findHostById: (requestedHostId) =>
      requestedHostId === hostId ? entry : null,
    messenger,
  });
  const account = createAuthenticatedUserFixture(undefined);
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: `token-${userId}`,
      user: { ...account, user: { ...account.user, id: userId } },
    }),
  );
  return {
    client: spine.createRequester(entry),
    messenger,
    queryClient: queryCache,
  };
}

function readSignal(harness: ReaderHarness): AbortSignal | undefined {
  return harness.messenger.calls[0]?.authority.abortSignal;
}

function useCatalog(epicId: string, readerClient: HostClient<HostRpcRegistry>) {
  return useBrowserCatalogInventory({ epicId, readerClient });
}

describe("useBrowserCatalogInventory host read", () => {
  afterEach(() => {
    cleanup();
  });

  it("registers the read in TanStack's mutation cache, shares one repair loop, and aborts it after the last view releases", async () => {
    const epicId = "catalog-hook-shared-loop";
    const cache = queryClient();
    const response = deferred<BrowserCatalogReadResponse>();
    const harness = readerHarness(
      "catalog-reader",
      "catalog-user",
      cache,
      () => response.promise,
    );
    const wrapper = wrapperFor(cache);

    const first = renderHook(() => useCatalog(epicId, harness.client), {
      wrapper,
    });
    const second = renderHook(() => useCatalog(epicId, harness.client), {
      wrapper,
    });
    await waitFor(() => expect(harness.messenger.calls).toHaveLength(1));

    const expectedKey = browserMutationKeys.catalogRead(
      "catalog-reader",
      "catalog-user",
      epicId,
    );
    const matching = cache
      .getMutationCache()
      .getAll()
      .filter(
        (mutation) =>
          JSON.stringify(mutation.options.mutationKey) ===
          JSON.stringify(expectedKey),
      );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.state.status).toBe("pending");

    const signal = readSignal(harness);
    expect(signal).toBeInstanceOf(AbortSignal);
    first.unmount();
    expect(signal?.aborted).toBe(false);
    second.unmount();
    await waitFor(() => expect(signal?.aborted).toBe(true));
    response.resolve({ kind: "unavailable", reason: "cloud" });
    cache.clear();
  });

  it("keeps an in-flight read captured to its original host and user when the view switches identity", async () => {
    const epicId = "catalog-hook-identity-switch";
    const cache = queryClient();
    const oldResponse = deferred<BrowserCatalogReadResponse>();
    const oldHarness = readerHarness(
      "catalog-reader-old",
      "catalog-user-old",
      cache,
      () => oldResponse.promise,
    );
    const newResponse = deferred<BrowserCatalogReadResponse>();
    const newHarness = readerHarness(
      "catalog-reader-new",
      "catalog-user-new",
      cache,
      () => newResponse.promise,
    );
    const wrapper = wrapperFor(cache);
    const rendered = renderHook(({ client }) => useCatalog(epicId, client), {
      initialProps: { client: oldHarness.client },
      wrapper,
    });
    await waitFor(() => expect(oldHarness.messenger.calls).toHaveLength(1));
    const oldSignal = readSignal(oldHarness);
    expect(oldSignal?.aborted).toBe(false);

    rendered.rerender({ client: newHarness.client });
    await waitFor(() => expect(oldSignal?.aborted).toBe(true));
    await waitFor(() => expect(newHarness.messenger.calls).toHaveLength(1));

    const newSignal = readSignal(newHarness);
    expect(newSignal?.aborted).toBe(false);
    const currentMutation = cache
      .getMutationCache()
      .getAll()
      .find(
        (mutation) =>
          JSON.stringify(mutation.options.mutationKey) ===
          JSON.stringify(
            browserMutationKeys.catalogRead(
              "catalog-reader-new",
              "catalog-user-new",
              epicId,
            ),
          ),
      );
    expect(currentMutation?.state.status).toBe("pending");

    rendered.unmount();
    await waitFor(() => expect(newSignal?.aborted).toBe(true));
    oldResponse.resolve({ kind: "unavailable", reason: "cloud" });
    newResponse.resolve({ kind: "unavailable", reason: "cloud" });
    cache.clear();
  });
});
