import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import type { NotificationHooksStatusResponse } from "@traycer/protocol/host/notifications/host-notifications";
import { hostQueryKeys } from "@/lib/query-keys";
import {
  consumePendingHookRemovalNotices,
  filterConsumedHookRemovalNotices,
} from "../hook-removal-notices";

const HOST_ID = "host-gc";
const DEFAULT_GC_MS = 5 * 60 * 1000;

function notice(id: string, occurredAt: number) {
  return {
    id,
    hostId: HOST_ID,
    hostName: "Work laptop",
    count: 1,
    occurredAt,
  };
}

function statusWith(
  pendingRemovalNotices: NotificationHooksStatusResponse["pendingRemovalNotices"],
): NotificationHooksStatusResponse {
  return {
    configPath: "/home/me/.traycer/notification-hooks.json",
    configError: null,
    hooks: [],
    configurationRevision: "rev-1",
    pendingRemovalNotices,
  };
}

/**
 * Acknowledgment history is session state, but it is only Query data: with no
 * observer on it, the garbage collector may drop it after `gcTime`, and the
 * next stale status read would then reopen a receipt the person retired.
 */
describe("hook removal acknowledgment history outlives query garbage collection", () => {
  let queryClient: QueryClient;
  const statusKey = hostQueryKeys.methodScope(
    HOST_ID,
    "host.notificationHooks.status",
  );

  beforeEach(() => {
    vi.useFakeTimers();
    queryClient = new QueryClient({
      defaultOptions: { queries: { gcTime: DEFAULT_GC_MS, retry: false } },
    });
  });

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
  });

  async function pastDefaultGc(): Promise<void> {
    await vi.advanceTimersByTimeAsync(DEFAULT_GC_MS + 1);
  }

  const cases = [
    {
      name: "a new acknowledged id",
      seed: () => undefined,
      acknowledge: { ids: ["receipt-new"] },
      stale: [
        notice("receipt-new", 3_000),
        notice("receipt-other", 3_000),
      ],
      remaining: ["receipt-other"],
    },
    {
      name: "an acknowledged id beside one recorded before the helper ran",
      seed: () =>
        queryClient.setQueryData<readonly string[]>(
          hostQueryKeys.notificationHookRemovalReadIds(HOST_ID),
          ["receipt-earlier"],
        ),
      acknowledge: { ids: ["receipt-new"] },
      stale: [
        notice("receipt-earlier", 3_000),
        notice("receipt-new", 3_000),
        notice("receipt-other", 3_000),
      ],
      remaining: ["receipt-other"],
    },
    {
      name: "a new bulk cutoff",
      seed: () => undefined,
      acknowledge: { beforeUpdatedAt: 2_000 },
      stale: [notice("receipt-old", 1_500), notice("receipt-newer", 2_500)],
      remaining: ["receipt-newer"],
    },
    {
      name: "a bulk cutoff raised above one recorded before the helper ran",
      seed: () =>
        queryClient.setQueryData<number>(
          hostQueryKeys.notificationHookRemovalReadCutoff(HOST_ID),
          1_000,
        ),
      acknowledge: { beforeUpdatedAt: 2_000 },
      stale: [
        notice("receipt-earlier", 500),
        notice("receipt-old", 1_500),
        notice("receipt-newer", 2_500),
      ],
      remaining: ["receipt-newer"],
    },
  ] as const;

  it.each(cases)(
    "keeps $name filtering a stale status read after five idle minutes",
    async ({ seed, acknowledge, stale, remaining }) => {
      seed();
      queryClient.setQueryData(statusKey, statusWith([...stale]));

      await consumePendingHookRemovalNotices(queryClient, HOST_ID, acknowledge);
      await pastDefaultGc();

      // An ordinary observer-less query IS collected, so the history is only
      // still here because the helper kept it alive.
      expect(queryClient.getQueryData(statusKey)).toBeUndefined();
      expect(
        filterConsumedHookRemovalNotices(
          statusWith([...stale]),
          queryClient,
          HOST_ID,
        ).pendingRemovalNotices.map((entry) => entry.id),
      ).toEqual(remaining);
    },
  );
});
