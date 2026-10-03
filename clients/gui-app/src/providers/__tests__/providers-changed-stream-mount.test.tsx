import { afterEach, describe, expect, it, vi } from "vitest";
import {
  useQuery,
  queryOptions,
  QueryClientProvider,
  type QueryClient,
} from "@tanstack/react-query";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
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
import { providersNativeQueryKeys } from "@/lib/query-keys/providers-native-query-keys";
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

function pluginIconKey(hostId: string, providerId: ProviderId) {
  return pluginIconKeyForVersion(hostId, providerId, "1.0.0");
}

function pluginIconKeyForVersion(
  hostId: string,
  providerId: ProviderId,
  version: string | null,
) {
  return providersNativeQueryKeys.pluginIcon(hostId, {
    providerId,
    scope: "global",
    workspaceRoot: null,
    pluginId: "github@m",
    theme: "light",
    version,
  });
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: (value: T) => void = () => {
    throw new Error("deferred resolver was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

function mcpListKey(hostId: string, providerId: ProviderId) {
  return providersNativeQueryKeys.mcpList(hostId, {
    providerId,
    scope: "global",
    workspaceRoot: null,
  });
}

/**
 * Flushes the mount's 50ms invalidation-coalescing timer under fake timers,
 * then lets `cancelQueries(...).then(invalidateQueries)` settle - that
 * continuation is a real microtask even while fake timers own `setTimeout`,
 * so advancing the timer alone is not enough to observe its effect.
 */
async function flushInvalidationCoalescing(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(60);
    await Promise.resolve();
    await Promise.resolve();
  });
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

  it("never invalidates immutable plugin icon queries on a changed event", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      seedProviderScopes(queryClient, "host-A");
      const iconKey = pluginIconKey("host-A", "claude-code");
      queryClient.setQueryData(iconKey, { data: "icon-bytes" });

      renderProvidersChangedStreamMount(queryClient);
      act(() => {
        providersMountStreamState.opened[0]?.emitChanged("claude-code");
      });
      await flushInvalidationCoalescing();

      expectProviderScopesInvalidated(queryClient, "host-A", true);
      expect(queryClient.getQueryState(iconKey)?.isInvalidated).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never invalidates immutable plugin icon queries on reopen catch-up", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      seedProviderScopes(queryClient, "host-A");
      const iconKey = pluginIconKey("host-A", "claude-code");
      queryClient.setQueryData(iconKey, { data: "icon-bytes" });

      renderProvidersChangedStreamMount(queryClient);
      act(() => {
        providersMountStreamState.opened[0]?.emitStatus("open", null);
      });
      await flushInvalidationCoalescing();

      expectProviderScopesInvalidated(queryClient, "host-A", true);
      expect(queryClient.getQueryState(iconKey)?.isInvalidated).not.toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("narrows native provider-list invalidation to the changed event's provider", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      const changedProviderKey = mcpListKey("host-A", "claude-code");
      const otherProviderKey = mcpListKey("host-A", "codex");
      queryClient.setQueryData(changedProviderKey, { servers: [] });
      queryClient.setQueryData(otherProviderKey, { servers: [] });

      renderProvidersChangedStreamMount(queryClient);
      act(() => {
        providersMountStreamState.opened[0]?.emitChanged("claude-code");
      });
      await flushInvalidationCoalescing();

      expect(queryClient.getQueryState(changedProviderKey)?.isInvalidated).toBe(
        true,
      );
      expect(queryClient.getQueryState(otherProviderKey)?.isInvalidated).toBe(
        false,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-fetches an active query whose initial read is deferred across a changed event, delivering post-event data", async () => {
    const queryClient = createAppQueryClient();
    const key = hostQueryKeys.methodScope("host-A", "providers.list");
    const deferreds: Array<Deferred<{ tag: string }>> = [];
    const queryFn = () => {
      const deferred = createDeferred<{ tag: string }>();
      deferreds.push(deferred);
      return deferred.promise;
    };
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <ProvidersChangedStreamMount />
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => useQuery(queryOptions({ queryKey: key, queryFn })),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(deferreds).toHaveLength(1));

    // The provider changes while the initial read is still outstanding.
    act(() => {
      providersMountStreamState.opened[0]?.emitChanged("claude-code");
    });
    await waitFor(() => expect(deferreds).toHaveLength(2));

    // The stale pre-event response settles after cancellation; it must not
    // be what the observer ends up with.
    deferreds[0]?.resolve({ tag: "pre-event" });
    deferreds[1]?.resolve({ tag: "post-event" });

    await waitFor(() => {
      expect(result.current.data).toEqual({ tag: "post-event" });
    });
  });

  it("re-fetches an active query whose BACKGROUND refetch is deferred across a changed event, delivering post-event data over the stale in-flight response", async () => {
    const queryClient = createAppQueryClient();
    const key = hostQueryKeys.methodScope("host-A", "providers.list");
    const deferreds: Array<Deferred<{ tag: string }>> = [];
    const queryFn = () => {
      const deferred = createDeferred<{ tag: string }>();
      deferreds.push(deferred);
      return deferred.promise;
    };
    const Wrapper = (props: { readonly children: ReactNode }): ReactNode => (
      <QueryClientProvider client={queryClient}>
        <ProvidersChangedStreamMount />
        {props.children}
      </QueryClientProvider>
    );
    const { result } = renderHook(
      () => useQuery(queryOptions({ queryKey: key, queryFn })),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(deferreds).toHaveLength(1));
    deferreds[0]?.resolve({ tag: "cached" });
    await waitFor(() => {
      expect(result.current.data).toEqual({ tag: "cached" });
    });

    // A background refetch is already outstanding (old cache present) when
    // the provider changes.
    void queryClient.refetchQueries({ queryKey: key });
    await waitFor(() => expect(deferreds).toHaveLength(2));

    act(() => {
      providersMountStreamState.opened[0]?.emitChanged("claude-code");
    });
    await waitFor(() => expect(deferreds).toHaveLength(3));

    deferreds[1]?.resolve({ tag: "stale-refetch" });
    deferreds[2]?.resolve({ tag: "post-event" });

    await waitFor(() => {
      expect(result.current.data).toEqual({ tag: "post-event" });
    });
  });

  it("invalidates an unversioned plugin icon query on a changed event, unlike a versioned one", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      seedProviderScopes(queryClient, "host-A");
      const versionedKey = pluginIconKey("host-A", "claude-code");
      const unversionedKey = pluginIconKeyForVersion(
        "host-A",
        "claude-code",
        null,
      );
      queryClient.setQueryData(versionedKey, { data: "versioned-icon-bytes" });
      queryClient.setQueryData(unversionedKey, {
        data: "unversioned-icon-bytes",
      });

      renderProvidersChangedStreamMount(queryClient);
      act(() => {
        providersMountStreamState.opened[0]?.emitChanged("claude-code");
      });
      await flushInvalidationCoalescing();

      expect(queryClient.getQueryState(versionedKey)?.isInvalidated).not.toBe(
        true,
      );
      expect(queryClient.getQueryState(unversionedKey)?.isInvalidated).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("invalidates an unversioned plugin icon query on reopen catch-up, unlike a versioned one", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      seedProviderScopes(queryClient, "host-A");
      const versionedKey = pluginIconKey("host-A", "claude-code");
      const unversionedKey = pluginIconKeyForVersion(
        "host-A",
        "claude-code",
        null,
      );
      queryClient.setQueryData(versionedKey, { data: "versioned-icon-bytes" });
      queryClient.setQueryData(unversionedKey, {
        data: "unversioned-icon-bytes",
      });

      renderProvidersChangedStreamMount(queryClient);
      act(() => {
        providersMountStreamState.opened[0]?.emitStatus("open", null);
      });
      await flushInvalidationCoalescing();

      expect(queryClient.getQueryState(versionedKey)?.isInvalidated).not.toBe(
        true,
      );
      expect(queryClient.getQueryState(unversionedKey)?.isInvalidated).toBe(
        true,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("catches up every provider's native list on reopen, since no single provider changed", async () => {
    vi.useFakeTimers();
    try {
      const queryClient = createAppQueryClient();
      const providerAKey = mcpListKey("host-A", "claude-code");
      const providerBKey = mcpListKey("host-A", "codex");
      queryClient.setQueryData(providerAKey, { servers: [] });
      queryClient.setQueryData(providerBKey, { servers: [] });

      renderProvidersChangedStreamMount(queryClient);
      act(() => {
        providersMountStreamState.opened[0]?.emitStatus("open", null);
      });
      await flushInvalidationCoalescing();

      expect(queryClient.getQueryState(providerAKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(providerBKey)?.isInvalidated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
