import {
  focusManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import {
  resetNegotiatedManifests,
  recordNegotiatedHostManifest,
} from "@traycer-clients/shared/host-transport/negotiated-manifest-registry";
import type { EnvironmentStatusResponseV13 } from "@traycer/protocol/host/environment-schemas";
import { localRowCohort } from "@/components/settings/environment/local-row-cohort";
import { useRegisteredHostEnvironmentStatuses } from "@/hooks/environment/use-registered-host-environment-statuses";
import {
  buildEnvironmentClient,
  environmentStatusFixture,
  hostEntryFixture,
} from "@/lib/environment/__tests__/environment-test-support";
import type { HostRpcRegistry } from "@/lib/host";
import { queryKeys } from "@/lib/query-keys";

const binding = vi.hoisted(
  (): { client: HostClient<HostRpcRegistry> | null } => ({ client: null }),
);
vi.mock("@/lib/host", async (original) => ({
  ...(await original<typeof import("@/lib/host")>()),
  useHostBinding: () =>
    binding.client === null ? null : { hostClient: binding.client },
}));
afterEach(() => {
  cleanup();
  binding.client = null;
  resetNegotiatedManifests();
});

it("re-enables a failed status observer when the route returns", async () => {
  const hostId = "reconnected-host";
  let reads = 0;
  const answer = environmentStatusFixture({});
  binding.client = buildEnvironmentClient({
    hostId,
    handlers: {
      "environment.status": () => {
        reads += 1;
        if (reads === 1) throw new Error("status unavailable");
        return answer;
      },
    },
  }).client;
  recordNegotiatedHostManifest(hostId, {
    "environment.status": { major: 1, minor: 2 },
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const queryKey = queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
    hostId,
    "environment.status",
    {},
  );
  const hook = renderHook(
    ({ connectable }: { readonly connectable: boolean }) =>
      useRegisteredHostEnvironmentStatuses([{ hostId, connectable }]),
    {
      initialProps: { connectable: true },
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    },
  );
  await waitFor(() =>
    expect(queryClient.getQueryState(queryKey)?.status).toBe("error"),
  );
  hook.rerender({ connectable: false });
  await act(async () => {
    await queryClient.refetchQueries({ queryKey });
  });
  expect(reads).toBe(1);
  hook.rerender({ connectable: true });
  await waitFor(() => expect(hook.result.current.get(hostId)).toEqual(answer));
  expect(reads).toBe(2);
});

describe("status polling while a computer's move runs", () => {
  const MOVED_HOST = "moved-host";
  const RESTING_HOST = "resting-host";

  beforeEach(() => {
    vi.useFakeTimers();
    focusManager.setFocused(true);
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  /** One answer of `environment.status`, as a `@1.3` host serves it. */
  function answer(
    planes: "local" | "moved",
    move: "running" | "done" | null,
  ): EnvironmentStatusResponseV13 {
    return environmentStatusFixture({
      planes: { records: planes, broker: planes, room: planes },
      move:
        move === null
          ? null
          : {
              attemptId: "attempt-1",
              acceptanceId: "acceptance-1",
              state: move,
            },
    });
  }

  /**
   * The real hook over `hostIds`, whose n-th status read (counted across all
   * of them, in the order the hook asks) is `answerForRead(n)`.
   */
  function mountStatuses(
    hostIds: readonly string[],
    answerForRead: (read: number) => EnvironmentStatusResponseV13,
  ) {
    let reads = 0;
    const fixture = buildEnvironmentClient({
      hostId: hostIds[0] ?? "",
      handlers: {
        "environment.status": () => {
          reads += 1;
          return answerForRead(reads);
        },
      },
    });
    for (const hostId of hostIds.slice(1)) {
      fixture.hosts.set(hostId, hostEntryFixture(hostId));
    }
    for (const hostId of hostIds) {
      recordNegotiatedHostManifest(hostId, {
        "environment.status": { major: 1, minor: 3 },
      });
    }
    binding.client = fixture.client;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const hosts = hostIds.map((hostId) => ({ hostId, connectable: true }));
    const hook = renderHook(() => useRegisteredHostEnvironmentStatuses(hosts), {
      wrapper: ({ children }: { readonly children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      ),
    });
    const keyOf = (hostId: string) =>
      queryKeys.hostMethod<HostRpcRegistry, "environment.status">(
        hostId,
        "environment.status",
        {},
      );
    return {
      hook,
      queryClient,
      keyOf,
      reads: () => reads,
      readsOf: (hostId: string) =>
        queryClient.getQueryState(keyOf(hostId))?.dataUpdateCount ?? 0,
    };
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  function rowOf(
    rig: ReturnType<typeof mountStatuses>,
    hostId: string,
  ): "local" | "none" | "unread" {
    const status = rig.hook.result.current.get(hostId) ?? null;
    return status === null ? "unread" : localRowCohort(status).kind;
  }

  it("normal path: the planes flip before done, so the row clears while the move runs and the poll ends at done", async () => {
    // The host moves the planes, then records `done`: the settle re-read
    // answers running with the planes still local, the next poll answers
    // running with them moved, and the one after answers done.
    const rig = mountStatuses([MOVED_HOST], (read) => {
      if (read === 1) return answer("local", null);
      if (read === 2) return answer("local", "running");
      if (read === 3) return answer("moved", "running");
      return answer("moved", "done");
    });
    await advance(0);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");
    expect(rig.reads()).toBe(1);

    await act(async () => {
      await rig.queryClient.invalidateQueries({
        queryKey: rig.keyOf(MOVED_HOST),
      });
    });
    expect(rig.reads()).toBe(2);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");

    // The running lane's first delay is 500 ms.
    await advance(500);
    expect(rig.reads()).toBe(3);
    expect(rowOf(rig, MOVED_HOST)).toBe("none");

    // Its longest delay is 2 s, so `done` lands inside this window.
    await advance(2_000);
    expect(rig.reads()).toBe(4);
    expect(rowOf(rig, MOVED_HOST)).toBe("none");

    // `done` with the planes moved asks for no poll: nothing reads after it.
    await advance(5_000);
    await advance(10 * 60_000);
    expect(rig.reads()).toBe(4);
  });

  it("abnormal path: a done answer that still has local planes keeps the poll until the row turns over, then it stops", async () => {
    // The host records `done` before it flips the planes only when the flip
    // is late: the settle re-read answers running, the first done answer
    // still reads local, and the next answer has them moved.
    const rig = mountStatuses([MOVED_HOST], (read) => {
      if (read === 1) return answer("local", null);
      if (read === 2) return answer("local", "running");
      if (read === 3) return answer("local", "done");
      return answer("moved", "done");
    });
    await advance(0);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");
    expect(rig.reads()).toBe(1);

    await act(async () => {
      await rig.queryClient.invalidateQueries({
        queryKey: rig.keyOf(MOVED_HOST),
      });
    });
    expect(rig.reads()).toBe(2);

    // The running lane starts at 500 ms and ends at 2 s.
    await advance(2_000);
    expect(rig.reads()).toBe(3);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");

    // `done` is on the steady 5 s lane, and its Local row still stands.
    await advance(5_000);
    expect(rig.reads()).toBe(4);
    expect(rowOf(rig, MOVED_HOST)).toBe("none");

    await advance(5_000);
    await advance(10 * 60_000);
    expect(rig.reads()).toBe(4);
  });

  it("abnormal path: keeps polling a done move whose planes still read local, and stops once they are moved", async () => {
    const rig = mountStatuses([MOVED_HOST], (read) =>
      read <= 2 ? answer("local", "done") : answer("moved", "done"),
    );
    await advance(0);
    expect(rig.reads()).toBe(1);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");

    await advance(5_000);
    expect(rig.reads()).toBe(2);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");

    await advance(5_000);
    expect(rig.reads()).toBe(3);
    expect(rowOf(rig, MOVED_HOST)).toBe("none");

    await advance(5_000);
    await advance(10 * 60_000);
    expect(rig.reads()).toBe(3);
  });

  it("no move: reads computers at rest once each and never polls them", async () => {
    // The first host asked answers Local, the second Personal; the row
    // assertions fail loudly if the order ever differs.
    const rig = mountStatuses([MOVED_HOST, RESTING_HOST], (read) =>
      read === 1 ? answer("local", null) : answer("moved", null),
    );
    await advance(0);
    expect(rowOf(rig, MOVED_HOST)).toBe("local");
    expect(rowOf(rig, RESTING_HOST)).toBe("none");
    expect(rig.readsOf(MOVED_HOST)).toBe(1);
    expect(rig.readsOf(RESTING_HOST)).toBe(1);

    await advance(5_001);
    expect(rig.readsOf(MOVED_HOST)).toBe(1);
    expect(rig.readsOf(RESTING_HOST)).toBe(1);

    await advance(5 * 60_000 + 1);
    expect(rig.readsOf(MOVED_HOST)).toBe(1);
    expect(rig.readsOf(RESTING_HOST)).toBe(1);
    expect(rig.reads()).toBe(2);
  });
});
