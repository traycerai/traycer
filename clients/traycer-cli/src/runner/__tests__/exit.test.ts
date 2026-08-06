import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// int#4840. `finishAndExit` replaced the `process.exit(...)` call sites: the
// win32 SEA aborted inside libuv teardown (`uv_async_send` on an already
// closing handle, src\win\async.c:76) AFTER the command had succeeded, so a
// finished `host available` reported failure to Desktop.
//
// Four properties carry that fix and none is observable from a command test:
//   1. the code lands on `process.exitCode` and the loop is left to drain
//   2. the code and the watchdog are in place BEFORE the first blocking await.
//      The first version of this module armed the watchdog last, so the two
//      steps most likely to hang were the two the backstop did not cover.
//   3. every teardown step is bounded and escalates to a forced release, so a
//      stalled socket cannot turn "let the loop drain" into "never exit"
//   4. the watchdog is UNREF'd, so it cannot itself keep the process alive -
//      if it could, every CLI run would sit there for the full timeout and the
//      fix would read as a hang.

const sentryClose = vi.fn<(timeout: number) => Promise<boolean>>();
const destroySentryTransportRequests = vi.fn<() => number>();
const dispatcherClose = vi.fn<() => Promise<void>>();
const dispatcherDestroy = vi.fn<() => Promise<void>>();

vi.mock("@sentry/node", () => ({
  close: (timeout: number) => sentryClose(timeout),
}));

vi.mock("undici", () => ({
  getGlobalDispatcher: () => ({
    close: () => dispatcherClose(),
    destroy: () => dispatcherDestroy(),
  }),
}));

vi.mock("../../sentry-transport", () => ({
  destroySentryTransportRequests: () => destroySentryTransportRequests(),
}));

function never(): Promise<never> {
  return new Promise<never>(() => {});
}

describe("finishAndExit", () => {
  let priorExitCode: number | string | null | undefined;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.useFakeTimers();
    // Module-level arbitration state (recorded code, watchdog, teardown latch)
    // must not leak between cases.
    vi.resetModules();
    sentryClose.mockReset().mockResolvedValue(true);
    destroySentryTransportRequests.mockReset().mockReturnValue(0);
    dispatcherClose.mockReset().mockResolvedValue(undefined);
    dispatcherDestroy.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.exitCode = priorExitCode;
  });

  it("records the exit code and does NOT tear the process down itself", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((): never => {
      throw new Error("process.exit must not be called on the normal path");
    }) as never);
    const { finishAndExit } = await import("../exit");

    await finishAndExit(3);

    expect(process.exitCode).toBe(3);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("records the code and arms the watchdog BEFORE the teardown awaits", async () => {
    // Both teardown clients hang forever. Under the original ordering nothing
    // was recorded or armed until they resolved, so this is the regression
    // test for the cold-review P1: the guard has to exist before the steps it
    // is supposed to guard.
    sentryClose.mockReturnValue(never());
    dispatcherClose.mockReturnValue(never());
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { finishAndExit } = await import("../exit");

    const pending = finishAndExit(9);
    // Let the synchronous prologue and the stdio flush settle, but advance no
    // timers - nothing the teardown waits on has had a chance to finish.
    await vi.advanceTimersByTimeAsync(0);

    expect(process.exitCode).toBe(9);
    expect(exitSpy).not.toHaveBeenCalled();

    // The watchdog is real and armed: it fires even though teardown is still
    // stuck, and carries the code the command earned.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(exitSpy).toHaveBeenCalledWith(9);

    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
  });

  it("arms an unref'd watchdog so the timer cannot hold the loop open", async () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((): { unref: () => void } => ({ unref })) as never);
    const { finishAndExit } = await import("../exit");

    await finishAndExit(0);

    // `flushStdio` and the teardown bounds arm their own timers, so the
    // watchdog is not the only `setTimeout` here - it is the only one that
    // gets unref'd, which is exactly the property under test. The others are
    // CLEARED on the normal path rather than unref'd.
    expect(unref).toHaveBeenCalledTimes(1);
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(15_000);
  });

  it("arms the watchdog once no matter how many paths finish the process", async () => {
    const unref = vi.fn();
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((): {
      unref: () => void;
    } => ({ unref })) as never);
    const { finishAndExit } = await import("../exit");

    await finishAndExit(1);
    await finishAndExit(0);

    // Two watchdogs would mean two racing `process.exit` calls, and the second
    // could report a code the first had already superseded.
    expect(unref).toHaveBeenCalledTimes(1);
  });

  it("forces the exit, with the same code, once the watchdog fires", async () => {
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { finishAndExit } = await import("../exit");

    await finishAndExit(7);
    expect(exitSpy).not.toHaveBeenCalled();

    // Stand in for a handle that never let go.
    await vi.advanceTimersByTimeAsync(60_000);

    expect(exitSpy).toHaveBeenCalledWith(7);
  });

  describe("exit-code arbitration", () => {
    it("does not let a later success downgrade a fatal code", async () => {
      const { finishAndExit } = await import("../exit");

      // The process-fatal handler fire-and-forgets `finishAndExit(1)`, and
      // draining lets the interrupted command keep running. Without
      // arbitration its `ok` result would report success for a failed process.
      await finishAndExit(1);
      await finishAndExit(0);

      expect(process.exitCode).toBe(1);
    });

    it("upgrades a success to a later failure", async () => {
      const { finishAndExit } = await import("../exit");

      await finishAndExit(0);
      await finishAndExit(2);

      expect(process.exitCode).toBe(2);
    });

    it("keeps the FIRST failure when two failures race", async () => {
      const { finishAndExit } = await import("../exit");

      await finishAndExit(4);
      await finishAndExit(5);

      expect(process.exitCode).toBe(4);
    });

    it("reports the arbitrated code when the watchdog fires later", async () => {
      const exitSpy = vi
        .spyOn(process, "exit")
        .mockImplementation((() => undefined) as never);
      const { finishAndExit } = await import("../exit");

      await finishAndExit(0);
      await finishAndExit(6);
      await vi.advanceTimersByTimeAsync(60_000);

      // Read at FIRE time, not at arm time: the watchdog was armed by the
      // first call, which had earned a 0.
      expect(exitSpy).toHaveBeenCalledWith(6);
    });
  });

  describe("bounded teardown", () => {
    it("gives up on a stalled Sentry flush and destroys its sockets anyway", async () => {
      // `Sentry.close()` is `flush()` plus `enabled = false`; it does NOT
      // retire in-flight requests. A DSN endpoint that accepts TCP and never
      // answers leaves sockets holding the loop open, which is what turned the
      // first version of this fix into a 5s stall plus a forced exit.
      sentryClose.mockReturnValue(never());
      const { finishAndExit } = await import("../exit");

      const pending = finishAndExit(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(destroySentryTransportRequests).toHaveBeenCalledTimes(1);
      expect(dispatcherClose).toHaveBeenCalledTimes(1);
    });

    it("destroys the dispatcher when a graceful close outlives its bound", async () => {
      // undici's `Agent.close()` waits for RUNNING requests with no timeout of
      // its own, so an un-cancelled stalled response body parks teardown
      // forever unless something escalates.
      dispatcherClose.mockReturnValue(never());
      const { finishAndExit } = await import("../exit");

      const pending = finishAndExit(0);
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;

      expect(dispatcherDestroy).toHaveBeenCalledTimes(1);
    });

    it("does not destroy the dispatcher when the graceful close succeeds", async () => {
      const { finishAndExit } = await import("../exit");

      await finishAndExit(0);

      expect(dispatcherClose).toHaveBeenCalledTimes(1);
      expect(dispatcherDestroy).not.toHaveBeenCalled();
    });

    it("shuts the network clients down once across repeated calls", async () => {
      const { finishAndExit } = await import("../exit");

      await finishAndExit(1);
      await finishAndExit(1);

      expect(sentryClose).toHaveBeenCalledTimes(1);
      expect(dispatcherClose).toHaveBeenCalledTimes(1);
    });

    it("survives a teardown step that rejects", async () => {
      sentryClose.mockRejectedValue(new Error("transport exploded"));
      dispatcherClose.mockRejectedValue(new Error("dispatcher exploded"));
      const { finishAndExit } = await import("../exit");

      await expect(finishAndExit(3)).resolves.toBeUndefined();
      expect(process.exitCode).toBe(3);
    });
  });
});
