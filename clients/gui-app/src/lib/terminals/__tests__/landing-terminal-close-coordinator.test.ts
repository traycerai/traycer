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

    // Both callers share one REQUEST - not one promise object. They settle
    // together, and each is told whether it owned the request, because the key
    // is the terminal's lifetime rather than the RPC: a `terminal.plain.close`
    // can join an in-flight `terminal.kill`, and those do not mean the same
    // thing on success. Only the owner may retire the tombstone.
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);

    resolveClose();
    await expect(fromPanel).resolves.toEqual({ owned: true });
    await expect(fromBridge).resolves.toEqual({ owned: false });
  });

  it("reports a joiner as unowned even when the owner rejects", async () => {
    // The joiner must not read a rejection as its own failure either - it
    // schedules retries off this, and the owner is the one that will retry.
    let rejectClose = (): void => undefined;
    const close = vi.fn(
      (): Promise<void> =>
        new Promise<void>((_resolve, reject) => {
          rejectClose = () => reject(new Error("transient"));
        }),
    );

    const owner = requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "session-shared-failure",
      close,
    });
    const joiner = requestLandingTerminalClose({
      hostId: "host-a",
      sessionId: "session-shared-failure",
      close,
    });
    await Promise.resolve();
    rejectClose();

    await expect(owner).rejects.toThrow("transient");
    await expect(joiner).rejects.toThrow("transient");
    expect(close).toHaveBeenCalledTimes(1);
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
    ).resolves.toEqual({ owned: true });
    expect(close).toHaveBeenCalledTimes(2);
  });
});
