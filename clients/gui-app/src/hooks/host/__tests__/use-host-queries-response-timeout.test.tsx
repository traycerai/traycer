import { afterEach, describe, expect, it } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRequester } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { hostRpcSchedulingPolicy } from "@/lib/host-rpc-policy/host-method-policy-table";
import { CATALOG_LIST_RESPONSE_TIMEOUT_MS } from "@/lib/host-rpc-policy/catalog-list-response-timeout";
import {
  useHostQueries,
  type HostRequestSpec,
} from "@/hooks/host/use-host-queries";

/**
 * `useHostQueries({ responseTimeoutMs })` dispatches every request in the batch
 * through `requestWithOptions` with that budget; omitted, it keeps
 * `requestWithSignal` exactly as before. Recorded at the requester the hook is
 * handed, then confirmed to have reached the messenger.
 */
interface Calls {
  readonly requestWithOptions: unknown[][];
  readonly requestWithSignal: unknown[][];
  readonly requestWithSignalRequiringHostMethodVersion: unknown[][];
}

function recordingRequester(real: HostRequester<HostRpcRegistry>): {
  readonly requester: HostRequester<HostRpcRegistry>;
  readonly calls: Calls;
} {
  const calls = {
    requestWithOptions: [] as unknown[][],
    requestWithSignal: [] as unknown[][],
    requestWithSignalRequiringHostMethodVersion: [] as unknown[][],
  };
  const requester: HostRequester<HostRpcRegistry> = {
    getRegistry: () => real.getRegistry(),
    getActiveHost: () => real.getActiveHost(),
    getActiveHostId: () => real.getActiveHostId(),
    getRequestContext: () => real.getRequestContext(),
    getRequestContextUserId: () => real.getRequestContextUserId(),
    onChange: (handler) => real.onChange(handler),
    request: (method, params) => real.request(method, params),
    requestWithIdempotencyKey: (method, params, idempotencyKey) =>
      real.requestWithIdempotencyKey(method, params, idempotencyKey),
    requestWithOptions: (method, params, options) => {
      calls.requestWithOptions.push([method, params, options]);
      return real.requestWithOptions(method, params, options);
    },
    requestWithSignal: (method, params, signal) => {
      calls.requestWithSignal.push([method, params, signal]);
      return real.requestWithSignal(method, params, signal);
    },
    requestWithSignalRequiringHostMethodVersion: (
      method,
      params,
      signal,
      requiredHostMethodVersion,
    ) => {
      calls.requestWithSignalRequiringHostMethodVersion.push([
        method,
        params,
        signal,
        requiredHostMethodVersion,
      ]);
      return real.requestWithSignalRequiringHostMethodVersion(
        method,
        params,
        signal,
        requiredHostMethodVersion,
      );
    },
    requestWithResponseTimeout: (method, params, responseTimeoutMs) =>
      real.requestWithResponseTimeout(method, params, responseTimeoutMs),
  };
  return { requester, calls };
}

function createFixture(): {
  readonly client: HostClient<HostRpcRegistry>;
  readonly messenger: MockHostMessenger<HostRpcRegistry>;
  readonly Wrapper: (props: { readonly children: ReactNode }) => ReactNode;
} {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0, gcTime: 0 } },
  });
  const messenger = new MockHostMessenger<HostRpcRegistry>({
    registry: hostRpcRegistry,
    requestId: () => `req-${Math.random().toString(36).slice(2)}`,
    handlers: {
      "agent.gui.listModels": (params) => ({
        harnessId: params.harnessId,
        models: [],
      }),
    },
  });
  const client = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    schedulingPolicy: hostRpcSchedulingPolicy,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger,
  });
  client.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
  return { client, messenger, Wrapper };
}

const REQUESTS: ReadonlyArray<
  HostRequestSpec<HostRpcRegistry, "agent.gui.listModels">
> = [
  {
    method: "agent.gui.listModels",
    params: { harnessId: "claude", workingDirectory: null },
  },
  {
    method: "agent.gui.listModels",
    params: { harnessId: "codex", workingDirectory: null },
  },
];

describe("useHostQueries responseTimeoutMs", () => {
  afterEach(() => {
    cleanup();
  });

  it("dispatches every request through requestWithOptions with the budget", async () => {
    const fixture = createFixture();
    const { requester, calls } = recordingRequester(
      fixture.client.createRequester(mockLocalHostEntry),
    );

    renderHook(
      () =>
        useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
          client: requester,
          cacheKeyIdentity: undefined,
          requests: REQUESTS,
          responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(calls.requestWithOptions).toHaveLength(2);
    });
    expect(calls.requestWithSignal).toHaveLength(0);
    expect(calls.requestWithSignalRequiringHostMethodVersion).toHaveLength(0);
    expect(calls.requestWithOptions.map((call) => call[1])).toEqual(
      REQUESTS.map((request) => request.params),
    );
    for (const call of calls.requestWithOptions) {
      expect(call[0]).toBe("agent.gui.listModels");
      expect(call[2]).toMatchObject({
        responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
        idempotencyKey: null,
        requiredHostMethodVersion: null,
      });
    }
    await waitFor(() => {
      expect(fixture.messenger.calls).toHaveLength(2);
    });
  });

  it("carries the requiredHostMethodVersion requirement through the same call", async () => {
    const fixture = createFixture();
    const { requester, calls } = recordingRequester(
      fixture.client.createRequester(mockLocalHostEntry),
    );
    const requirement = {
      method: "agent.gui.listModels" as const,
      version: { major: 1, minor: 0 },
    };

    renderHook(
      () =>
        useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
          client: requester,
          cacheKeyIdentity: undefined,
          requests: REQUESTS.slice(0, 1),
          responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
          requiredHostMethodVersion: () => requirement,
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(calls.requestWithOptions).toHaveLength(1);
    });
    expect(calls.requestWithOptions[0]?.[2]).toMatchObject({
      responseTimeoutMs: CATALOG_LIST_RESPONSE_TIMEOUT_MS,
      idempotencyKey: null,
      requiredHostMethodVersion: requirement,
    });
    expect(calls.requestWithSignalRequiringHostMethodVersion).toHaveLength(0);
  });

  it("keeps requestWithSignal when no budget is given", async () => {
    const fixture = createFixture();
    const { requester, calls } = recordingRequester(
      fixture.client.createRequester(mockLocalHostEntry),
    );

    renderHook(
      () =>
        useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
          client: requester,
          cacheKeyIdentity: undefined,
          requests: REQUESTS.slice(0, 1),
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(calls.requestWithSignal).toHaveLength(1);
    });
    expect(calls.requestWithSignal[0]?.[0]).toBe("agent.gui.listModels");
    expect(calls.requestWithOptions).toHaveLength(0);
  });

  it("keeps the version-requiring signal call when only a requirement is given", async () => {
    const fixture = createFixture();
    const { requester, calls } = recordingRequester(
      fixture.client.createRequester(mockLocalHostEntry),
    );
    const requirement = {
      method: "agent.gui.listModels" as const,
      version: { major: 1, minor: 0 },
    };

    renderHook(
      () =>
        useHostQueries<HostRpcRegistry, "agent.gui.listModels">({
          client: requester,
          cacheKeyIdentity: undefined,
          requests: REQUESTS.slice(0, 1),
          requiredHostMethodVersion: () => requirement,
          options: null,
        }),
      { wrapper: fixture.Wrapper },
    );

    await waitFor(() => {
      expect(calls.requestWithSignalRequiringHostMethodVersion).toHaveLength(1);
    });
    expect(calls.requestWithSignalRequiringHostMethodVersion[0]?.[3]).toEqual(
      requirement,
    );
    expect(calls.requestWithOptions).toHaveLength(0);
  });
});
