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
    expect(hold.result.current.mode).toBe("cloud");

    // A rebuilt client reports `unknown` and negotiates `local` for a beat;
    // the same host is coming right back, so the decided mode stands - but
    // as a SETTLING hold: the rows keep their lanes, the partition selector
    // waits, because the host coming back may be a rollback that strips it.
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-a",
    });
    expect(hold.result.current).toEqual({ mode: "cloud", settling: true });

    hold.rerender({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    expect(hold.result.current).toEqual({ mode: "cloud", settling: false });
  });

  it("settles to the rolled-back host's own `local` once its handshake lands, and never marks a held `local` as settling", () => {
    const hold = renderHold({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-a",
    });
    expect(hold.result.current).toEqual({ mode: "cloud", settling: true });

    // The same host came back below the floor: the new handshake answers
    // `local`, the hold releases, and nothing was sent with the selector.
    hold.rerender({
      negotiated: "local",
      support: "supported",
      hostId: "host-a",
    });
    expect(hold.result.current).toEqual({ mode: "local", settling: false });

    // A held `local` sends no selector, so its rebuild beat is not a wait.
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-a",
    });
    expect(hold.result.current).toEqual({ mode: "local", settling: false });
  });

  it("settles to the new host's own negotiation when the serving host changes", () => {
    const hold = renderHold({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    expect(hold.result.current.mode).toBe("cloud");

    // Host B's fresh client is `unknown` for the same beat, but it is a
    // DIFFERENT host: carrying A's `cloud` would send B the `home: "local"`
    // partition selector before B's negotiation said B accepts it.
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-b",
    });
    expect(hold.result.current.mode).toBe("local");

    // Non-vacuity: once B's handshake lands, B's own answer is published, and
    // B's later rebuild beat is then held like A's was.
    hold.rerender({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-b",
    });
    expect(hold.result.current.mode).toBe("cloud");
    hold.rerender({
      negotiated: "local",
      support: "unknown",
      hostId: "host-b",
    });
    expect(hold.result.current.mode).toBe("cloud");
  });

  it("does not hold across a null client", () => {
    const hold = renderHold({
      negotiated: "cloud",
      support: "supported",
      hostId: "host-a",
    });
    hold.rerender({ negotiated: "local", support: null, hostId: "host-a" });
    expect(hold.result.current.mode).toBe("local");
  });
});
