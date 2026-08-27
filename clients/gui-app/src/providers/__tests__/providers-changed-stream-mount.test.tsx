import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import type { ProviderId } from "@traycer/protocol/host/provider-schemas";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import type {
  StreamCloseReason,
  StreamConnectionStatus,
} from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  hostConnectionRefCountForTest,
  resetHostConnectionRegistryForTest,
} from "@traycer-clients/shared/host-client/host-connection-registry";
import { HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { PROVIDER_INVALIDATIONS } from "@/hooks/providers/invalidations";
import { hostQueryKeys } from "@/lib/query-keys";
import { createAppQueryClient } from "@/lib/query-client";
import { ProvidersChangedStreamMount } from "@/providers/providers-changed-stream-mount";

interface OpenedProvidersStream {
  readonly emitChanged: (providerId: ProviderId) => void;
  readonly emitStatus: (
    status: StreamConnectionStatus,
    reason: StreamCloseReason | null,
  ) => void;
}

interface ProvidersMountStreamState {
  readonly opened: Array<OpenedProvidersStream>;
  closes: number;
  support: StreamMethodSupport | null;
  hostId: string | null;
  hasClient: boolean;
}

const providersMountStreamState = vi.hoisted((): ProvidersMountStreamState => ({
  opened: [],
  closes: 0,
  support: "supported",
  hostId: "host-A",
  hasClient: true,
}));

const stubProvidersWsStreamClient = vi.hoisted((): { readonly stub: true } => ({
  stub: true,
}));

vi.mock(
  "@traycer-clients/shared/host-transport/providers-changed-stream-client",
  () => ({
    ProvidersChangedStreamClient: class {
      constructor(options: {
        readonly onChanged: (providerId: ProviderId) => void;
        readonly onConnectionStatus: (
          status: StreamConnectionStatus,
          reason: StreamCloseReason | null,
        ) => void;
      }) {
        providersMountStreamState.opened.push({
          emitChanged: options.onChanged,
          emitStatus: options.onConnectionStatus,
        });
      }

      close(): void {
        providersMountStreamState.closes += 1;
      }
    },
  }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useWsStreamClient: () =>
    providersMountStreamState.hasClient ? stubProvidersWsStreamClient : null,
  useStreamMethodSupport: () => providersMountStreamState.support,
  useStreamHostId: () => providersMountStreamState.hostId,
}));

function renderProvidersChangedStreamMount(queryClient: QueryClient): void {
  render(
    <QueryClientProvider client={queryClient}>
      <ProvidersChangedStreamMount />
    </QueryClientProvider>,
  );
}

function emitProvidersMountStatus(
  status: StreamConnectionStatus,
  reason: StreamCloseReason | null,
): void {
  const stream = providersMountStreamState.opened.at(-1);
  if (stream === undefined) throw new Error("no providers stream opened");
  act(() => {
    stream.emitStatus(status, reason);
  });
}

function providersMountFatalClose(code: string): StreamCloseReason {
  return {
    kind: "fatalError",
    details: {
      code,
      reason: `test close: ${code}`,
      incompatibleMethods: null,
      upgradeGuidance: null,
    },
  };
}

function seedProviderScopes(queryClient: QueryClient, hostId: string): void {
  for (const method of PROVIDER_INVALIDATIONS) {
    queryClient.setQueryData(hostQueryKeys.methodScope(hostId, method), {
      hostId,
      method,
    });
  }
}

function expectProviderScopesInvalidated(
  queryClient: QueryClient,
  hostId: string,
  invalidated: boolean,
): void {
  for (const method of PROVIDER_INVALIDATIONS) {
    expect(
      queryClient.getQueryState(hostQueryKeys.methodScope(hostId, method))
        ?.isInvalidated,
    ).toBe(invalidated);
  }
}

describe("<ProvidersChangedStreamMount />", () => {
  afterEach(() => {
    cleanup();
    resetHostConnectionRegistryForTest();
    providersMountStreamState.opened.length = 0;
    providersMountStreamState.closes = 0;
    providersMountStreamState.support = "supported";
    providersMountStreamState.hostId = "host-A";
    providersMountStreamState.hasClient = true;
  });

  it("invalidates only the captured host's provider scopes on changed", async () => {
    const queryClient = createAppQueryClient();
    seedProviderScopes(queryClient, "host-A");
    seedProviderScopes(queryClient, "host-B");

    renderProvidersChangedStreamMount(queryClient);
    expect(providersMountStreamState.opened).toHaveLength(1);
    expect(hostConnectionRefCountForTest("host-A")).toBe(1);

    act(() => {
      providersMountStreamState.opened[0]?.emitChanged("claude-code");
    });

    await waitFor(() => {
      expectProviderScopesInvalidated(queryClient, "host-A", true);
    });
    expectProviderScopesInvalidated(queryClient, "host-B", false);
  });

  it("invalidates only the captured host's provider scopes when it opens", async () => {
    const queryClient = createAppQueryClient();
    seedProviderScopes(queryClient, "host-A");
    seedProviderScopes(queryClient, "host-B");

    renderProvidersChangedStreamMount(queryClient);
    act(() => {
      providersMountStreamState.opened[0]?.emitStatus("open", null);
    });

    await waitFor(() => {
      expectProviderScopesInvalidated(queryClient, "host-A", true);
    });
    expectProviderScopesInvalidated(queryClient, "host-B", false);
  });

  it("retains reopen backoff across short churn, then resets after an event", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const queryClient = createAppQueryClient();
      renderProvidersChangedStreamMount(queryClient);
      expect(providersMountStreamState.opened).toHaveLength(1);

      // The first close schedules at the initial delay; the next close must
      // inherit the doubled delay unless this stream has proved it healthy.
      emitProvidersMountStatus(
        "closed",
        providersMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(providersMountStreamState.opened).toHaveLength(2);

      emitProvidersMountStatus("open", null);
      act(() => {
        vi.advanceTimersByTime(1_000);
      });
      emitProvidersMountStatus(
        "closed",
        providersMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(providersMountStreamState.opened).toHaveLength(2);
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(providersMountStreamState.opened).toHaveLength(3);

      emitProvidersMountStatus("open", null);
      act(() => {
        providersMountStreamState.opened.at(-1)?.emitChanged("claude-code");
      });
      emitProvidersMountStatus(
        "closed",
        providersMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(providersMountStreamState.opened).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets reopen backoff after a healthy 30-second dwell", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const queryClient = createAppQueryClient();
      renderProvidersChangedStreamMount(queryClient);

      emitProvidersMountStatus(
        "closed",
        providersMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(providersMountStreamState.opened).toHaveLength(2);

      emitProvidersMountStatus("open", null);
      act(() => {
        vi.advanceTimersByTime(30_000);
      });
      emitProvidersMountStatus(
        "closed",
        providersMountFatalClose("UNAUTHORIZED"),
      );
      act(() => {
        vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
      });
      expect(providersMountStreamState.opened).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
