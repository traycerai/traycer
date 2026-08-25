import { describe, expect, it, vi } from "vitest";
import { requestLandingTerminalClose } from "@/lib/terminals/landing-terminal-close-coordinator";

describe("requestLandingTerminalClose", () => {
  it("collapses concurrent closes for one lifetime onto a single request", async () => {
    // The panel's fast path and the recovery bridge both send the close for one
    // gesture on an already-drainable host, from separate mutation instances.
    // Two real requests means the loser fails on a terminal the winner already
    // removed, and raises "Couldn't close the terminal." for a close that
    // worked.
    let resolveClose = (): void => undefined;
    const close = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    );

    const fromPanel = requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "session-1",
      close,
    });
    const fromBridge = requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "session-1",
      close,
    });

    // Both callers get the same promise synchronously; the request itself is
    // dispatched on a microtask, so let it run before counting.
    expect(fromBridge).toBe(fromPanel);
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);

    resolveClose();
    await expect(fromPanel).resolves.toBeUndefined();
    await expect(fromBridge).resolves.toBeUndefined();
  });

  it("keeps separate lifetimes independent", async () => {
    const close = vi.fn(() => Promise.resolve());

    void requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "session-1",
      close,
    });
    void requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "session-2",
      close,
    });
    void requestLandingTerminalClose({
      hostId: "host-b",
      sessionId: "session-1",
      close,
    });

    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(3);
  });

  it("releases the lifetime on failure so the drain can retry it", async () => {
    // Annotated: an inferred `Promise<never>` from `Promise.reject` would make
    // the later resolving implementation unassignable.
    const close = vi.fn((): Promise<void> =>
      Promise.reject(new Error("transient")),
    );

    await expect(
      requestLandingTerminalClose({
        hostId: "host-a",
        sessionId: "session-retry",
        close,
      }),
    ).rejects.toThrow("transient");

    // A held key would strand the tombstone: the bridge's backoff would join a
    // settled, already-rejected promise forever instead of sending anything.
    close.mockImplementationOnce(() => Promise.resolve());
    await expect(
      requestLandingTerminalClose({
        hostId: "host-a",
        sessionId: "session-retry",
        close,
      }),
    ).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
