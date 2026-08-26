import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { hostQueryKeys } from "@/lib/query-keys";
import type {
  AvailableProviderRateLimits,
  ProviderRateLimitEnvelope,
} from "@/lib/rate-limits/rate-limit-envelope";
import { useProvidersRefreshProfileStatusForClient } from "@/hooks/providers/use-providers-refresh-profile-status-mutation";

type RefreshRequest = RequestOfMethod<
  HostRpcRegistry,
  "providers.refreshProfileStatus"
>;
type RefreshResponse = ResponseOfMethod<
  HostRpcRegistry,
  "providers.refreshProfileStatus"
>;
type CapturedOptions = {
  readonly method: string;
  readonly mapVariables: (variables: RefreshRequest) => RefreshRequest;
  readonly onMutate?: () => { readonly hostId: string | null };
  readonly onSuccess?: (
    data: RefreshResponse,
    variables: RefreshRequest,
    context: { readonly hostId: string | null },
  ) => Promise<void>;
};

const testState = vi.hoisted(() => ({
  captured: null as CapturedOptions | null,
}));

vi.mock("@/hooks/host/use-host-query", () => ({
  useHostMutation: (args: {
    readonly method: string;
    readonly mapVariables: CapturedOptions["mapVariables"];
    readonly options: Omit<CapturedOptions, "method" | "mapVariables">;
  }) => {
    testState.captured = {
      method: args.method,
      mapVariables: args.mapVariables,
      ...args.options,
    };
    return {
      isPending: false,
      mutate: vi.fn(),
      mutateAsync: vi.fn(),
    };
  },
}));

function wrapperFor(queryClient: QueryClient) {
  return (props: { readonly children: ReactNode }): ReactNode => (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

function rateLimitEnvelope(
  providerRateLimits: AvailableProviderRateLimits,
): ProviderRateLimitEnvelope {
  return {
    latest: providerRateLimits,
    lastGood: providerRateLimits,
    lastGoodAt: 100,
    lastFailureAt: null,
  };
}

function codexRateLimits(usedPercent: number): AvailableProviderRateLimits {
  return {
    provider: "codex",
    available: true,
    planType: "pro_5x",
    limitId: null,
    limitName: null,
    primary: {
      usedPercent,
      resetsAt: 2_000,
      durationMinutes: 300,
    },
    secondary: null,
    extraWindows: [],
    credits: null,
    individualLimit: null,
    resetCredits: null,
    rateLimitReachedType: null,
  };
}

function makeClient(host: typeof mockLocalHostEntry) {
  const spine = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: { invalidateHostScope: () => undefined },
    findHostById: (hostId) => (hostId === host.hostId ? host : null),
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "refresh-profile-status-test",
      handlers: {},
    }),
  });
  spine.setRequestContext(
    createRequestContextFixture({
      origin: "renderer",
      bearerToken: "refresh-profile-status-token",
    }),
  );
  return spine.createRequester(host);
}

describe("useProvidersRefreshProfileStatusForClient", () => {
  beforeEach(() => {
    testState.captured = null;
  });

  afterEach(() => cleanup());

  it("writes the response to the captured host/profile cache and invalidates only that host after a swap", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const hostA = { ...mockLocalHostEntry, hostId: "host-a" };
    const hostB = { ...mockLocalHostEntry, hostId: "host-b" };
    const clientA = makeClient(hostA);
    const clientB = makeClient(hostB);
    const rateLimitKeyA = hostQueryKeys.method<
      HostRpcRegistry,
      "host.getRateLimitUsage"
    >("host-a", "host.getRateLimitUsage", {
      accountContext: { type: "PERSONAL" },
      providerId: "codex",
      profileId: "work-profile",
    });
    const rateLimitKeyB = hostQueryKeys.method<
      HostRpcRegistry,
      "host.getRateLimitUsage"
    >("host-b", "host.getRateLimitUsage", {
      accountContext: { type: "PERSONAL" },
      providerId: "codex",
      profileId: "work-profile",
    });
    const listKeyA = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      "host-a",
      "providers.list",
      { native: null },
    );
    const listKeyB = hostQueryKeys.method<HostRpcRegistry, "providers.list">(
      "host-b",
      "providers.list",
      { native: null },
    );
    queryClient.setQueryData(
      rateLimitKeyA,
      rateLimitEnvelope(codexRateLimits(12)),
    );
    queryClient.setQueryData(
      rateLimitKeyB,
      rateLimitEnvelope(codexRateLimits(88)),
    );
    const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

    const rendered = renderHook(
      ({ client }) => useProvidersRefreshProfileStatusForClient(client),
      {
        initialProps: { client: clientA },
        wrapper: wrapperFor(queryClient),
      },
    );
    expect(testState.captured?.method).toBe("providers.refreshProfileStatus");
    expect(
      testState.captured?.mapVariables({
        providerId: "codex",
        profileId: "work-profile",
      }),
    ).toEqual({ providerId: "codex", profileId: "work-profile" });

    const captured = testState.captured;
    const context = captured?.onMutate?.();
    expect(context).toEqual({ hostId: "host-a" });
    if (context === undefined || captured?.onSuccess === undefined) {
      throw new Error("refresh profile status callbacks were not captured");
    }

    rendered.rerender({ client: clientB });
    await act(async () => {
      await captured.onSuccess?.(
        { providerRateLimits: codexRateLimits(34) },
        { providerId: "codex", profileId: "work-profile" },
        context,
      );
    });

    expect(queryClient.getQueryData(rateLimitKeyA)).toMatchObject({
      latest: { primary: { usedPercent: 34 } },
      lastGood: { primary: { usedPercent: 34 } },
    });
    expect(queryClient.getQueryData(rateLimitKeyB)).toMatchObject({
      latest: { primary: { usedPercent: 88 } },
    });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: listKeyA,
      exact: true,
    });
    expect(invalidateQueries).not.toHaveBeenCalledWith({
      queryKey: listKeyB,
      exact: true,
    });
  });
});
