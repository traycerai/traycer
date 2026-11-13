import { afterEach, describe, expect, it, vi } from "vitest";
import {
  QueryClientProvider,
  notifyManager,
  type QueryClient,
} from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS } from "@traycer-clients/shared/host-client/host-connection-reconnect-engine";
import { resetHostConnectionRegistryForTest } from "@traycer-clients/shared/host-client/host-connection-registry";
import type { FakeStreamClient } from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { mockRemoteHostEntry } from "@traycer-clients/shared/host-client/mock/mock-host-directory";
import {
  ScriptedRead,
  heldAnswer,
  heldFailure,
  hostFailure,
  hostReadKey,
  rejects,
  resolves,
} from "@/lib/host/test-support/cloud-failure-reads";
import { createAppQueryClient } from "@/lib/query-client";
import { CloudRecoveryDoorbellMount } from "@/providers/cloud-recovery-doorbell-mount";

const doorbellHosts = vi.hoisted(
  (): {
    readonly clients: Map<string, FakeStreamClient>;
    readonly unsupportedHosts: Set<string>;
  } => ({
    clients: new Map(),
    unsupportedHosts: new Set(),
  }),
);

vi.mock("@/hooks/host/use-host-directory-entry", () => ({
  useHostDirectoryEntry: (hostId: string | null) =>
    hostId === null ? null : { ...mockRemoteHostEntry, hostId },
}));

vi.mock("@/lib/host/stream-auth-revalidator", () => ({
  useStreamAuthRevalidator: () => null,
}));

vi.mock("@/hooks/host/use-host-stream-client-for", async () => {
  const { FakeStreamClient: Fake } =
    await import("@traycer-clients/shared/host-transport/__testing__/fake-stream-client");
  return {
    useHostStreamClientFor: (target: { readonly hostId: string } | null) => {
      if (target === null) return null;
      const existing = doorbellHosts.clients.get(target.hostId);
      if (existing !== undefined) return existing;
      const created = new Fake(true);
      if (doorbellHosts.unsupportedHosts.has(target.hostId)) {
        created.methodSupport = "unsupported";
      }
      doorbellHosts.clients.set(target.hostId, created);
      return created;
    },
  };
});

const A = "host-A";
const B = "host-B";
const METHOD = "cloud.recovered.subscribe";

let queryClient: QueryClient;

function mount(): void {
  queryClient = createAppQueryClient();
  render(
    <QueryClientProvider client={queryClient}>
      <CloudRecoveryDoorbellMount />
    </QueryClientProvider>,
  );
}

/** Every doorbell subscription opened so far, host by host. */
function doorbellsOf(hostId: string) {
  const client = doorbellHosts.clients.get(hostId);
  if (client === undefined) return [];
  return client.sessions.filter(
    (_session, index) => client.subscribes[index]?.method === METHOD,
  );
}

function liveDoorbellsOf(hostId: string) {
  return doorbellsOf(hostId).filter((session) => !session.closed);
}

async function failedRead(
  hostId: string,
  code: Parameters<typeof hostFailure>[0],
  name: string,
): Promise<ScriptedRead> {
  const made: ScriptedRead[] = [];
  act(() => {
    made.push(
      new ScriptedRead(
        queryClient,
        hostReadKey(hostId, "bot.list", name),
        rejects(hostFailure(code, "bot.list")),
      ),
    );
  });
  const created = made.at(0);
  if (created === undefined) throw new Error("read was not created");
  await waitFor(() => expect(created.state.status).toBe("error"));
  return created;
}

/** A read of `hostId` that holds data ("first") and whose refetch then failed with `code`. */
async function dataHoldingFailedRead(
  hostId: string,
  code: Parameters<typeof hostFailure>[0],
): Promise<ScriptedRead> {
  const made: ScriptedRead[] = [];
  act(() => {
    made.push(
      new ScriptedRead(
        queryClient,
        hostReadKey(hostId, "bot.thread.list", "held-data"),
        resolves("first"),
      ),
    );
  });
  const created = made.at(0);
  if (created === undefined) throw new Error("read was not created");
  await waitFor(() => expect(created.state.data).toBe("first"));
  created.answer = rejects(hostFailure(code, "bot.thread.list"));
  await act(async () => {
    await queryClient.refetchQueries({ queryKey: created.queryKey });
  });
  expect(created.state.status).toBe("error");
  expect(created.state.data).toBe("first");
  return created;
}

/**
 * Waits until what a cache change set going has reached React: TanStack hands
 * observers and cache subscribers their events through its own scheduler.
 */
async function flushCacheNotifications(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => notifyManager.schedule(resolve));
  });
}

function ring(hostId: string): void {
  const session = liveDoorbellsOf(hostId).at(-1);
  if (session === undefined) throw new Error(`no doorbell open to ${hostId}`);
  act(() => {
    session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
  });
}

function fatalClose(code: string): void {
  const session = liveDoorbellsOf(A).at(-1);
  if (session === undefined) throw new Error("no doorbell open to host-A");
  act(() => {
    session.emitFatalWithCode(code, `test close: ${code}`);
  });
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  queryClient.clear();
  resetHostConnectionRegistryForTest();
  doorbellHosts.clients.clear();
  doorbellHosts.unsupportedHosts.clear();
});

describe("<CloudRecoveryDoorbellMount />", () => {
  it("opens no subscription while no read has failed transiently", async () => {
    mount();
    expect(doorbellHosts.clients.size).toBe(0);
    await failedRead(A, "FORBIDDEN", "permanent");
    expect(doorbellsOf(A)).toHaveLength(0);
  });

  it("opens exactly one subscription, to the host whose read failed", async () => {
    mount();
    await failedRead(A, "E_CLOUD_REQUEST_REFUSED", "a");
    await failedRead(A, "E_CLOUD_UNREACHABLE", "b");

    await waitFor(() => expect(doorbellsOf(A)).toHaveLength(1));
    expect(doorbellsOf(B)).toHaveLength(0);
    expect(
      doorbellHosts.clients
        .get(A)
        ?.subscribes.filter((subscribe) => subscribe.method === METHOD),
    ).toEqual([{ method: METHOD, params: {} }]);
  });

  it("opens no subscription for a failed read nothing observes", async () => {
    mount();
    await act(async () => {
      await queryClient
        .fetchQuery({
          queryKey: hostReadKey(A, "bot.list", "unobserved"),
          queryFn: rejects(hostFailure("E_CLOUD_UNREACHABLE", "bot.list")),
          retry: false,
        })
        .catch(() => undefined);
    });

    expect(doorbellHosts.clients.size).toBe(0);
  });

  it("closes the subscription when the failed read is no longer observed", async () => {
    mount();
    const read = await failedRead(A, "E_CLOUD_UNREACHABLE", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));

    act(() => {
      read.release();
    });

    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(0));
  });

  it("never subscribes to a host whose manifest lacks the method", async () => {
    doorbellHosts.unsupportedHosts.add(A);
    mount();
    await failedRead(A, "E_CLOUD_UNREACHABLE", "a");

    await waitFor(() => expect(doorbellHosts.clients.has(A)).toBe(true));
    expect(doorbellsOf(A)).toHaveLength(0);
  });

  it("re-asks the ringing host's failed reads and never another host's", async () => {
    mount();
    const onA = await failedRead(A, "E_CLOUD_REQUEST_REFUSED", "a");
    const onB = await failedRead(B, "E_CLOUD_REQUEST_REFUSED", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    await waitFor(() => expect(liveDoorbellsOf(B)).toHaveLength(1));
    onA.answer = resolves("ok");
    onB.answer = resolves("ok");

    ring(A);

    await waitFor(() => expect(onA.state.status).toBe("success"));
    expect(onA.calls).toBe(2);
    expect(onB.calls).toBe(1);
    expect(onB.state.status).toBe("error");
  });

  it("closes the subscription once the host has no failed transient read left", async () => {
    mount();
    const read = await failedRead(A, "E_CLOUD_UNREACHABLE", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    read.answer = resolves("ok");

    ring(A);

    await waitFor(() => expect(read.state.status).toBe("success"));
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(0));
  });

  it("keeps one subscription through a re-ask of a read with no data, whether it fails again or not", async () => {
    mount();
    const read = await failedRead(A, "E_CLOUD_REQUEST_REFUSED", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    const reAsk = heldFailure(
      hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.list"),
    );
    read.answer = reAsk.answer;

    ring(A);
    await waitFor(() => expect(read.calls).toBe(2));
    await flushCacheNotifications();

    // The re-ask is in flight: the host still has a stranded read.
    expect(doorbellsOf(A)).toHaveLength(1);
    expect(liveDoorbellsOf(A)).toHaveLength(1);

    reAsk.release();
    await waitFor(() => expect(read.state.fetchStatus).toBe("idle"));
    await flushCacheNotifications();

    expect(read.state.status).toBe("error");
    expect(read.calls).toBe(2);
    expect(doorbellsOf(A)).toHaveLength(1);
    expect(liveDoorbellsOf(A)).toHaveLength(1);

    read.answer = resolves("ok");
    ring(A);
    await waitFor(() => expect(read.state.status).toBe("success"));
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(0));
    expect(doorbellsOf(A)).toHaveLength(1);
  });

  it("re-asks a stranded read that holds data once for two recovered frames back to back", async () => {
    mount();
    const read = await dataHoldingFailedRead(A, "E_CLOUD_REQUEST_REFUSED");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    const reAsk = heldAnswer("recovered");
    read.answer = reAsk.answer;
    const session = liveDoorbellsOf(A).at(-1);
    if (session === undefined) throw new Error("no doorbell open to host-A");

    act(() => {
      session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
      session.emit({ kind: "recovered", hasBinaryPayload: false }, null);
    });
    await waitFor(() => expect(read.calls).toBeGreaterThan(2));
    reAsk.release();
    await waitFor(() => expect(read.state.data).toBe("recovered"));
    await flushCacheNotifications();

    expect(read.calls).toBe(3);
  });

  it("keeps the subscription while a read is still failing after the ring", async () => {
    mount();
    const read = await failedRead(A, "E_CLOUD_UNREACHABLE", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    read.answer = rejects(hostFailure("E_CLOUD_REQUEST_REFUSED", "bot.list"));

    ring(A);

    await waitFor(() => expect(read.calls).toBe(2));
    await waitFor(() => expect(read.state.status).toBe("error"));
    expect(liveDoorbellsOf(A)).toHaveLength(1);
  });

  it("reopens after a reopenable close", async () => {
    mount();
    await failedRead(A, "E_CLOUD_UNREACHABLE", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    vi.useFakeTimers();

    fatalClose("UNAUTHORIZED");
    act(() => {
      vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS);
    });

    expect(doorbellsOf(A)).toHaveLength(2);
    expect(liveDoorbellsOf(A)).toHaveLength(1);
  });

  it("does not reopen after a close a reopen cannot fix", async () => {
    mount();
    await failedRead(A, "E_CLOUD_UNREACHABLE", "a");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    vi.useFakeTimers();

    fatalClose("INCOMPATIBLE");
    act(() => {
      vi.advanceTimersByTime(HOST_STREAM_REOPEN_INITIAL_BACKOFF_MS * 4);
    });

    expect(doorbellsOf(A)).toHaveLength(1);
  });
});

describe("<CloudRecoveryDoorbellMount /> following the cache's current entry", () => {
  const REFUSED = "E_CLOUD_REQUEST_REFUSED";

  it("keeps the replacement's doorbell when the removed read is dropped by gc afterwards", async () => {
    mount();
    const key = hostReadKey(A, "bot.list", "same-key");
    queryClient.setQueryDefaults(key, { gcTime: 0 });
    const old = await failedRead(A, REFUSED, "same-key");
    const oldQuery = queryClient.getQueryCache().find({
      queryKey: key,
      exact: true,
    });
    if (oldQuery === undefined) throw new Error("the old read is not cached");
    // Removed while its reader still holds it, then replaced under the same key.
    act(() => queryClient.removeQueries({ queryKey: key, exact: true }));
    const current = await failedRead(A, REFUSED, "same-key");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));

    // The old reader lets go: gc announces the old read's removal, though the
    // replacement holds the slot. Waited for on the old object itself.
    const gone = Promise.withResolvers<void>();
    const stopWatching = queryClient.getQueryCache().subscribe((event) => {
      if (event.type === "removed" && event.query === oldQuery) gone.resolve();
    });
    await act(async () => {
      old.release();
      await gone.promise;
    });
    stopWatching();
    await flushCacheNotifications();

    expect(current.state.status).toBe("error");
    expect(
      queryClient.getQueryCache().find({ queryKey: key, exact: true })
        ?.observers.length,
    ).toBe(1);
    expect(liveDoorbellsOf(A)).toHaveLength(1);
    current.answer = resolves("recovered");
    ring(A);
    await waitFor(() => expect(current.state.data).toBe("recovered"));
    expect(current.calls).toBe(2);
  });

  it("closes when the stranded read is removed, and reopens for a replacement that fails", async () => {
    mount();
    const old = await failedRead(A, REFUSED, "replaced");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));

    act(() => {
      queryClient.removeQueries({ queryKey: old.queryKey, exact: true });
    });
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(0));

    const replacement = await failedRead(A, REFUSED, "replaced");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    expect(doorbellsOf(A)).toHaveLength(2);
    replacement.answer = resolves("recovered");
    ring(A);
    await waitFor(() => expect(replacement.state.data).toBe("recovered"));
  });

  it("follows a stranded read through a reset and reopens when the reset's refetch fails", async () => {
    mount();
    const read = await failedRead(A, REFUSED, "reset-me");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    const resetAsk = heldFailure(hostFailure(REFUSED, "bot.list"));
    read.answer = resetAsk.answer;

    act(() => {
      void queryClient.resetQueries({ queryKey: read.queryKey, exact: true });
    });
    await waitFor(() => expect(read.calls).toBe(2));
    await flushCacheNotifications();
    // The reset read is not failed while its refetch is held.
    expect(liveDoorbellsOf(A)).toHaveLength(0);

    resetAsk.release();
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    read.answer = resolves("recovered");
    ring(A);
    await waitFor(() => expect(read.state.data).toBe("recovered"));
  });

  it("leaves no doorbell open for either host after the cache is cleared", async () => {
    mount();
    await failedRead(A, REFUSED, "on-a");
    await failedRead(B, REFUSED, "on-b");
    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(1));
    await waitFor(() => expect(liveDoorbellsOf(B)).toHaveLength(1));

    act(() => {
      queryClient.clear();
    });

    await waitFor(() => expect(liveDoorbellsOf(A)).toHaveLength(0));
    await waitFor(() => expect(liveDoorbellsOf(B)).toHaveLength(0));
  });
});
