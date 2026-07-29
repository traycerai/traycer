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

  it("keeps non-entitled users on the local feed without cloud negotiation", () => {
    useAuthStore.setState({ subscriptionStatus: "FREE" });
    cloudFeedSupport.value = "unsupported";

    expect(renderHook(() => useNotificationFeedMode()).result.current).toBe(
      "local",
    );
  });

  it("uses cloud while capability is pending or supported, then falls back locally when absent", () => {
    useAuthStore.setState({ subscriptionStatus: "PRO" });
    cloudFeedSupport.value = null;
    const hook = renderHook(() => useNotificationFeedMode());

    expect(hook.result.current).toBe("cloud");
    cloudFeedSupport.value = "unknown";
    hook.rerender();
    expect(hook.result.current).toBe("cloud");
    cloudFeedSupport.value = "supported";
    hook.rerender();
    expect(hook.result.current).toBe("cloud");
    cloudFeedSupport.value = "unsupported";
    hook.rerender();
    expect(hook.result.current).toBe("local");
  });
});
