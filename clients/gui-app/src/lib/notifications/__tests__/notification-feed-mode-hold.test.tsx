import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import type { StreamMethodSupport } from "@traycer-clients/shared/host-transport/ws-stream-client";
import {
  useHeldNotificationFeedMode,
  type NotificationFeedMode,
} from "@/lib/notifications/notification-feed-mode";

interface HoldInput {
  readonly negotiated: NotificationFeedMode;
  readonly support: StreamMethodSupport | null;
  readonly hostId: string | null;
}

function renderHold(initial: HoldInput) {
  return renderHook(
    (input: HoldInput) =>
      useHeldNotificationFeedMode(
        input.negotiated,
        input.support,
        input.hostId,
      ),
    { initialProps: initial },
  );
}

describe("useHeldNotificationFeedMode", () => {
  it("holds the settled mode through the SAME host's re-negotiation beat", () => {
    const hold = renderHold({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    expect(hold.result.current).toBe("cloud");

    // A rebuilt client reports `unknown` and negotiates `local` for a beat;
    // the same host is coming right back, so the decided mode stands.
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-a",
    });
    expect(hold.result.current).toBe("cloud");

    hold.rerender({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    expect(hold.result.current).toBe("cloud");
  });

  it("settles to the new host's own negotiation when the serving host changes", () => {
    const hold = renderHold({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    expect(hold.result.current).toBe("cloud");

    // Host B's fresh client is `unknown` for the same beat, but it is a
    // DIFFERENT host: carrying A's `cloud` would send B the `home: "local"`
    // partition selector before B's negotiation said B accepts it.
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-b",
    });
    expect(hold.result.current).toBe("local");

    // Non-vacuity: once B's handshake lands, B's own answer is published, and
    // B's later rebuild beat is then held like A's was.
    hold.rerender({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-b",
    });
    expect(hold.result.current).toBe("cloud");
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-b",
    });
    expect(hold.result.current).toBe("cloud");
  });

  it("does not hold across a null client", () => {
    const hold = renderHold({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    hold.rerender({ negotiated: "local", support: null, hostId: "host-a" });
    expect(hold.result.current).toBe("local");
  });
});
