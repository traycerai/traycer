import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { useAuthStore } from "@/stores/auth/auth-store";

const cloudFeedSupport = vi.hoisted<{ value: StreamMethodSupport | null }>(
  () => ({ value: null }),
);
const feedVersions = vi.hoisted(() => ({
  cloud: { major: 1, minor: 1 },
  local: { major: 1, minor: 2 },
}));

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => cloudFeedSupport.value,
  useStreamMethodSchemaVersion: (method: string) =>
    method === "host.notifications.cloudFeed.subscribe"
      ? feedVersions.cloud
      : feedVersions.local,
}));

describe("useNotificationFeedMode", () => {
  afterEach(() => {
    useAuthStore.setState({ subscriptionStatus: null });
    cloudFeedSupport.value = null;
    feedVersions.cloud = { major: 1, minor: 1 };
    feedVersions.local = { major: 1, minor: 2 };
  });

  it("selects cloud for a free-tier user when the host confirms support", () => {
    useAuthStore.setState({ subscriptionStatus: "FREE" });
    cloudFeedSupport.value = "supported";

    expect(renderHook(() => useNotificationFeedMode()).result.current).toBe(
      "cloud",
    );
  });

  it("keeps methodless and pending capability local and upgrades only after confirmed support", () => {
    cloudFeedSupport.value = null;
    const hook = renderHook(() => useNotificationFeedMode());

    expect(hook.result.current).toBe("local");
    cloudFeedSupport.value = "unknown";
    hook.rerender();
    expect(hook.result.current).toBe("local");
    cloudFeedSupport.value = "supported";
    hook.rerender();
    expect(hook.result.current).toBe("cloud");
    cloudFeedSupport.value = "unsupported";
    hook.rerender();
    expect(hook.result.current).toBe("local");
  });

  it("stays local until both partitioned feed schema versions negotiate", () => {
    cloudFeedSupport.value = "supported";

    // Cloud method present but still whole-relay (pre-1.1) — mixed mode would
    // double-count origin replicas, so local remains the single safe view.
    feedVersions.cloud = { major: 1, minor: 0 };
    feedVersions.local = { major: 1, minor: 2 };
    expect(renderHook(() => useNotificationFeedMode()).result.current).toBe(
      "local",
    );

    // Local feed present but pre-partition (pre-1.2).
    feedVersions.cloud = { major: 1, minor: 1 };
    feedVersions.local = { major: 1, minor: 1 };
    expect(renderHook(() => useNotificationFeedMode()).result.current).toBe(
      "local",
    );

    // Both projection minors present → mixed (named "cloud" feed mode).
    feedVersions.cloud = { major: 1, minor: 1 };
    feedVersions.local = { major: 1, minor: 2 };
    expect(renderHook(() => useNotificationFeedMode()).result.current).toBe(
      "cloud",
    );
  });
});
