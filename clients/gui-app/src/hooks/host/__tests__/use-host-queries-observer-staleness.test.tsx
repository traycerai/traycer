import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { HostClient } from "@traycer-clients/shared/host-client/host-client";
import { mockLocalHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import { MockHostMessenger } from "@traycer-clients/shared/host-client/mock/mock-host-messenger";
import { createRequestContextFixture } from "@traycer-clients/shared/test-fixtures/request-context";
import { hostRpcRegistry, type HostRpcRegistry } from "@/lib/host";
import { createHostQueryInvalidator } from "@/lib/host/query-invalidator";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { createAppQueryClient } from "@/lib/query-client";

/**
 * Two observers of one host query key, each with its own freshness options,
 * over the app's own QueryClient defaults (a 60 s `staleTime`) and the real
 * host query observer: which one decides when the shared query is read.
 */

const STATUS = {
  ready: true,
  hostVersion: "1.2.3",
  protocolVersion: { major: 1, minor: 0 },
  busy: false,
  busySessionCount: 0,
  updateProgress: null,
  busyBreakdown: null,
  updateOperation: null,
  updateTransaction: null,
  storeFormats: null,
  install: null,
  processMemory: null,
  crossHostMessaging: null,
  sessions: null,
  updatesExternallyManaged: null,
  previousExit: null,
} as const;

const gate = {
  reads: 0,
  hold: false,
  fail: false,
  release: null as (() => void) | null,
};

let queryClient: QueryClient;
let client: HostClient<HostRpcRegistry>;

function Wrapper(props: { readonly children: ReactNode }): ReactNode {
  return (
    <QueryClientProvider client={queryClient}>
      {props.children}
    </QueryClientProvider>
  );
}

/** What the notification indicator hook derives from a result set. */
type Seen = {
  readonly hasAnswer: boolean;
  readonly isFetching: boolean;
  readonly isStale: boolean;
  readonly hasData: boolean;
};

const BASE = { enabled: true, retry: false } as const;
const ACTIVITY = {
  enabled: true,
  retry: false,
  staleTime: Infinity,
  refetchOnMount: "always",
} as const;

function useObserved(options: typeof BASE | typeof ACTIVITY): Seen {
  return useHostQueries({
    client,
    cacheKeyIdentity: undefined,
    requests: [{ method: "host.status", params: {} }],
    options,
    combine: (results): Seen => ({
      hasAnswer: results.every(
        (result) =>
          result.data !== undefined &&
          result.error === null &&
          !result.isFetching &&
          !result.isStale,
      ),
      isFetching: results.some((result) => result.isFetching),
      isStale: results.some((result) => result.isStale),
      hasData: results.every((result) => result.data !== undefined),
    }),
  });
}

const mountBase = () =>
  renderHook(() => useObserved(BASE), { wrapper: Wrapper });
const mountActivity = () =>
  renderHook(() => useObserved(ACTIVITY), { wrapper: Wrapper });

/** Lets the pending reads and the observers' notifications run out. */
async function settle(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function advanceClock(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  gate.reads = 0;
  gate.hold = false;
  gate.fail = false;
  gate.release = null;
  queryClient = createAppQueryClient();
  const hostClient = new HostClient<HostRpcRegistry>({
    registry: hostRpcRegistry,
    invalidator: createHostQueryInvalidator(queryClient),
    findHostById: (hostId) =>
      hostId === mockLocalHostEntry.hostId ? mockLocalHostEntry : null,
    messenger: new MockHostMessenger<HostRpcRegistry>({
      registry: hostRpcRegistry,
      requestId: () => "req-1",
      handlers: {
        "host.status": async () => {
          gate.reads += 1;
          if (gate.hold) {
            await new Promise<void>((resolve) => {
              gate.release = resolve;
            });
          }
          if (gate.fail) throw new Error("the host refused");
          return STATUS;
        },
      },
    }),
  });
  hostClient.setRequestContext(
    createRequestContextFixture({ origin: "renderer", bearerToken: "tok-1" }),
  );
  client = hostClient.createRequester(mockLocalHostEntry);
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.useRealTimers();
});

describe("two plain observers of one host query key", () => {
  it("read once; a second mount inside the 60 s window reads nothing", async () => {
    mountBase();
    await vi.waitFor(() => expect(gate.reads).toBe(1));
    await settle();

    const second = mountBase();
    await settle();

    expect(gate.reads).toBe(1);
    expect(second.result.current.hasAnswer).toBe(true);
  });
});

describe("an observer with staleTime Infinity and refetchOnMount always", () => {
  it("starts exactly one read on a cold cache, though two of them mount together", async () => {
    mountActivity();
    mountActivity();
    await settle();

    expect(gate.reads).toBe(1);
  });

  it("starts exactly one read on mount over a fresh cache, though two of them mount together", async () => {
    mountBase();
    await vi.waitFor(() => expect(gate.reads).toBe(1));
    await settle();

    mountActivity();
    mountActivity();
    await settle();

    expect(gate.reads).toBe(2);
  });

  it("holds no answer from the invalidation until the replacement read succeeds", async () => {
    const view = mountActivity();
    await vi.waitFor(() => expect(view.result.current.hasAnswer).toBe(true));

    gate.hold = true;
    // Not awaited: the invalidation settles only when the held read does.
    act(() => {
      void queryClient.invalidateQueries({ queryKey: ["host"] });
    });
    await settle();
    // The replacement read is open: the cached answer is not a current one.
    expect(gate.reads).toBe(2);
    expect(view.result.current.hasAnswer).toBe(false);

    gate.hold = false;
    await act(async () => {
      gate.release?.();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(view.result.current.hasAnswer).toBe(true);
  });

  it("holds no answer after the replacement read fails", async () => {
    const view = mountActivity();
    await vi.waitFor(() => expect(view.result.current.hasAnswer).toBe(true));

    gate.fail = true;
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["host"] });
    });
    await settle();

    expect(view.result.current.hasAnswer).toBe(false);
  });
});

describe("a plain observer beside one with staleTime Infinity", () => {
  it("mounting after the 60 s window still reads, though the other holds Infinity", async () => {
    const activity = mountActivity();
    await vi.waitFor(() =>
      expect(activity.result.current.hasAnswer).toBe(true),
    );
    expect(gate.reads).toBe(1);

    await advanceClock(61_000);
    const base = mountBase();
    await settle();

    expect(gate.reads).toBe(2);
    expect(base.result.current.hasAnswer).toBe(true);
  });

  it("mounting inside the 60 s window reads nothing, whatever the other holds", async () => {
    const activity = mountActivity();
    await vi.waitFor(() =>
      expect(activity.result.current.hasAnswer).toBe(true),
    );

    await advanceClock(30_000);
    mountBase();
    await settle();

    expect(gate.reads).toBe(1);
  });

  it("reads exactly what it would alone: stale after 60 s, with or without the other", async () => {
    // Alone.
    const alone = mountBase();
    await vi.waitFor(() => expect(alone.result.current.hasAnswer).toBe(true));
    await advanceClock(61_000);
    alone.rerender();
    const aloneStale = alone.result.current.isStale;
    const aloneReads = gate.reads;
    cleanup();
    queryClient.clear();
    gate.reads = 0;

    // Beside an Infinity observer of the same key.
    const activity = mountActivity();
    const beside = mountBase();
    await vi.waitFor(() => expect(beside.result.current.hasAnswer).toBe(true));
    expect(activity.result.current.hasAnswer).toBe(true);
    await advanceClock(61_000);
    beside.rerender();

    expect(aloneStale).toBe(true);
    expect(beside.result.current.isStale).toBe(aloneStale);
    expect(aloneReads).toBe(1);
    expect(gate.reads).toBe(1);
  });
});
