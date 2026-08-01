import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import { useNotificationFeedMode } from "@/lib/notifications/notification-feed-mode";
import { useAuthStore } from "@/stores/auth/auth-store";

const cloudFeedSupport = vi.hoisted<{ value: StreamMethodSupport | null }>(
  () => ({ value: null }),
);

vi.mock("@/lib/host/stream-runtime-context", () => ({
  useStreamMethodSupport: () => cloudFeedSupport.value,
}));

describe("useNotificationFeedMode", () => {
  afterEach(() => {
    useAuthStore.setState({ subscriptionStatus: null });
    cloudFeedSupport.value = null;
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
});
