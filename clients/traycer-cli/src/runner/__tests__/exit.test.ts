import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// int#4840. `finishAndExit` replaced seven `process.exit(...)` call sites: the
// win32 SEA aborted inside libuv teardown (`uv_async_send` on an already
// closing handle, src\win\async.c:76) AFTER the command had succeeded, so a
// finished `host available` reported failure to Desktop.
//
// Two properties carry that fix and neither is observable from a command test:
//   1. the code lands on `process.exitCode` and the loop is left to drain
//   2. the watchdog that backstops a wedged handle is UNREF'd, so it cannot
//      itself keep the process alive - if it could, every CLI run would sit
//      there for the full timeout and the "let it drain" fix would read as a
//      hang.

describe("finishAndExit", () => {
  let priorExitCode: number | string | undefined;

  beforeEach(() => {
    priorExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.useFakeTimers();
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

  it("arms an unref'd watchdog so the timer cannot hold the loop open", async () => {
    const unref = vi.fn();
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((): { unref: () => void } => ({ unref })) as never);
    const { finishAndExit } = await import("../exit");

    await finishAndExit(0);

    // `flushStdio` arms its own bounded timers (one per descriptor), so the
    // watchdog is not the only `setTimeout` here - it is the only one that
    // gets unref'd, which is exactly the property under test. Those bounded
    // timers are CLEARED on the normal path rather than unref'd.
    expect(unref).toHaveBeenCalledTimes(1);
    // The whole point: an unref'd timer is invisible to the loop's liveness
    // check, so the normal path exits immediately and the watchdog only ever
    // fires when something ELSE is still holding the loop.
    const delays = setTimeoutSpy.mock.calls.map((call) => call[1]);
    expect(delays).toContain(5_000);
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
});
