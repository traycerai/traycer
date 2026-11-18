import { afterEach, describe, expect, it, vi } from "vitest";
import { isMobileApp, setMobileApp } from "@/lib/mobile-app";
import {
  LIST_CLOUD_TASKS_REQUEST,
  cloudEpicTasksFirstPageQueryOptions,
} from "@/lib/cloud-epic-tasks-query";
import { getCloudEpicTasksClient } from "@/lib/cloud-epic-tasks-query/client-registry";
import type { AuthStatus } from "@/stores/auth/auth-store";
import { Route as EpicTabRoute } from "@/routes/epics.$epicId.$tabId";

/**
 * The phone restores this route at launch; its drawer
 * (`mobile-drawer-history-gate.tsx`) warms History after the first paint or
 * on the first open. Drives `Route.options.loader` directly, as
 * `epics-route.test.tsx` does for `/epics`, with only the context the loader
 * reads.
 */
describe("/epics/$epicId/$tabId loader History prefetch", () => {
  afterEach(() => {
    setMobileApp(false);
  });

  interface FakeHostClient {
    getActiveHostId(): string | null;
    getRequestContextUserId(): string | null;
  }

  interface FakeLoaderContext {
    getHostClient: () => FakeHostClient | null;
    getAuthSnapshot: () => {
      readonly status: AuthStatus;
      readonly contextMetadata: { readonly userId: string } | null;
    };
    queryClient: { prefetchQuery: (options: unknown) => Promise<void> };
  }

  function invokeTabLoader(hostId: string) {
    const prefetchQuery = vi.fn((_options: unknown) => Promise.resolve());
    const loader = EpicTabRoute.options.loader as (loaderArgs: {
      context: FakeLoaderContext;
    }) => unknown;
    loader({
      context: {
        getHostClient: () => ({
          getActiveHostId: () => hostId,
          getRequestContextUserId: () => "user-1",
        }),
        getAuthSnapshot: () => ({
          status: "signed-in",
          contextMetadata: { userId: "user-1" },
        }),
        queryClient: { prefetchQuery },
      },
    });
    return { prefetchQuery };
  }

  it("skips the prefetch on the phone", () => {
    setMobileApp(true);
    expect(isMobileApp()).toBe(true);
    const hostId = "host-epic-tab-mobile";

    const { prefetchQuery } = invokeTabLoader(hostId);

    expect(prefetchQuery).not.toHaveBeenCalled();
  });

  it("prefetches the cloud epic tasks first page on desktop", () => {
    setMobileApp(false);
    const hostId = "host-epic-tab-desktop";

    const { prefetchQuery } = invokeTabLoader(hostId);

    expect(prefetchQuery).toHaveBeenCalledTimes(1);
    const [options] = prefetchQuery.mock.calls[0] as [{ queryKey: unknown }];
    expect(options.queryKey).toEqual(
      cloudEpicTasksFirstPageQueryOptions(
        hostId,
        "user-1",
        LIST_CLOUD_TASKS_REQUEST,
      ).queryKey,
    );
    expect(getCloudEpicTasksClient(hostId)).not.toBeNull();
  });
});
