import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ServiceController, ServiceLabel } from "../index";

// The decorator's whole contract is an ORDERING and a withdrawal rule:
//
//   - intent is written BEFORE the operation, because the supervisor has to be
//     able to see it before anything is killed;
//   - it OUTLIVES the call, because reading it is how the supervisor knows the
//     child's death was asked for, and because `hasActionableStopIntent`
//     already answers each supervisor separately by its invocation time;
//   - it is withdrawn ONLY when the operation failed AND the host is still
//     serving, because that is the one case where the record describes a kill
//     that did not happen.
//
// The withdrawal rule is the one with teeth, in both directions. Withdraw too
// eagerly and a partly-completed uninstall lets the orphaned supervisor read a
// deliberate kill as a crash and bring the host back. Never withdraw and a
// `HOST_BUSY` refusal - which leaves the host RUNNING and untouched - suppresses
// that live host's own crash recovery for the whole freshness window.
//
// Note what does NOT decide it: the error type. `HOST_BUSY` is raised before
// anything is touched, but `stopService` throwing because the pid outlived its
// exit wait happens strictly after the kill, and both arrive as an exception.
// Only liveness separates them.

const mocks = vi.hoisted(() => ({
  writes: [] as string[],
  clears: [] as string[],
  persisted: true,
  platform: "darwin" as NodeJS.Platform,
  liveHost: null as { pid: number } | null,
  incumbentProbes: 0,
}));

vi.mock("../../host/stop-intent", () => ({
  writeStopIntent: async (_environment: string, reason: string) => {
    mocks.writes.push(reason);
    return mocks.persisted;
  },
  clearStopIntent: async (environment: string) => {
    mocks.clears.push(environment);
  },
}));

vi.mock("../../host/incumbent-check", () => ({
  findLiveIncumbentHost: async () => {
    mocks.incumbentProbes += 1;
    return mocks.liveHost;
  },
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => mocks.platform };
});

const { withStopIntent } = await import("../index");

// Declared types rather than stubs laundered through `unknown`: a shape that
// drifts from `ServiceController` then fails the build here, which is the only
// thing making these tests evidence about the real decorator.
const label: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

function baseController(
  overrides: Partial<ServiceController>,
): ServiceController {
  const unimplemented = (): never => {
    throw new Error("not used in this test");
  };
  return {
    install: unimplemented,
    uninstall: unimplemented,
    status: unimplemented,
    stop: unimplemented,
    start: unimplemented,
    restart: unimplemented,
    stopForRestart: unimplemented,
    relaunchAfterRestart: unimplemented,
    retireCompetingRegistration: unimplemented,
    takeoverDesktopRegistration: unimplemented,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.writes.length = 0;
  mocks.clears.length = 0;
  mocks.persisted = true;
  mocks.platform = "darwin";
  // Default: the operation's kill LANDED (nothing is serving any more), which
  // is the ordinary shape and the one where the record must stand.
  mocks.liveHost = null;
  mocks.incumbentProbes = 0;
});

describe("withStopIntent", () => {
  it("keeps the intent when the stop succeeds", async () => {
    const controller = withStopIntent(
      baseController({ stop: async () => undefined }),
    );

    await controller.stop(label);

    expect(mocks.writes).toEqual(["stop"]);
    // NOT cleared: the supervisor still has to read it to know the child's
    // death was requested.
    expect(mocks.clears).toEqual([]);
  });

  it("clears the intent when stopForRestart is refused and the host is STILL SERVING", async () => {
    // `HOST_BUSY` never touches the host, so it is still up - and leaving a
    // "restart" record behind would suppress its own crash recovery for the
    // whole freshness window. A refused restart must not end in a hostless
    // machine.
    mocks.liveHost = { pid: 4242 };
    const busy = new Error("E_HOST_BUSY");
    const controller = withStopIntent(
      baseController({
        stopForRestart: async () => {
          throw busy;
        },
      }),
    );

    await expect(controller.stopForRestart(label)).rejects.toThrow(busy);

    expect(mocks.writes).toEqual(["restart"]);
    expect(mocks.clears).toEqual(["production"]);
  });

  it("KEEPS the intent when a stop throws after the kill already landed", async () => {
    // The other half of the same failure, and the half the error type cannot
    // distinguish: `stopService` signals, then waits for the pid to go, then
    // throws if it did not - by which point the host may well be dead anyway.
    // Nothing is serving, so the record is the only evidence the death was
    // asked for. Clearing it lets the orphaned supervisor call it a crash.
    mocks.liveHost = null;
    const controller = withStopIntent(
      baseController({
        stop: async () => {
          throw new Error("host pid outlived its exit wait");
        },
      }),
    );

    await expect(controller.stop(label)).rejects.toThrow("outlived");

    expect(mocks.incumbentProbes).toBe(1);
    expect(mocks.clears).toEqual([]);
  });

  it("KEEPS the intent when an uninstall fails after killing the host", async () => {
    // A `host uninstall` that ran `/End`, killed the tree, and then failed to
    // remove the hidden launcher has already crossed its kill boundary. If this
    // cleared, the orphaned supervisor would resurrect a host whose Scheduled
    // Task may already be deleted - while uninstall reports failure.
    mocks.liveHost = null;
    const controller = withStopIntent(
      baseController({
        uninstall: async () => {
          throw new Error("EPERM: could not remove launcher");
        },
      }),
    );

    await expect(controller.uninstall({ label })).rejects.toThrow("EPERM");

    expect(mocks.writes).toEqual(["uninstall"]);
    expect(mocks.clears).toEqual([]);
  });

  it("clears the intent when an uninstall fails with the host untouched", async () => {
    mocks.liveHost = { pid: 4242 };
    const controller = withStopIntent(
      baseController({
        uninstall: async () => {
          throw new Error("refused before touching anything");
        },
      }),
    );

    await expect(controller.uninstall({ label })).rejects.toThrow("refused");

    expect(mocks.clears).toEqual(["production"]);
  });

  it("refuses the stop on win32 when the intent could not be recorded", async () => {
    // On win32 the sentinel is the ONLY channel - `schtasks /End` never
    // signals the orphaned supervisor. Killing the host with no record means
    // the supervisor reads a nonzero exit as a crash and brings it back, while
    // `host stop` reports success. Refusing is the honest outcome.
    mocks.platform = "win32";
    mocks.persisted = false;
    let stopped = false;
    const controller = withStopIntent(
      baseController({
        stop: async () => {
          stopped = true;
        },
      }),
    );

    await expect(controller.stop(label)).rejects.toThrow(
      /could not record the stop request/,
    );
    // The kill must NOT have happened: a host that comes back is worse than a
    // stop that says it failed.
    expect(stopped).toBe(false);
  });

  it("proceeds on POSIX when the intent could not be recorded", async () => {
    // There launchd/systemd signal the supervisor directly, so it latches
    // `shuttingDown` and never relaunches. The sentinel is belt-and-braces and
    // a failed write costs nothing - failing the stop would be a regression.
    mocks.platform = "darwin";
    mocks.persisted = false;
    let stopped = false;
    const controller = withStopIntent(
      baseController({
        stop: async () => {
          stopped = true;
        },
      }),
    );

    await controller.stop(label);

    expect(stopped).toBe(true);
  });

  it("refuses a RESTART on win32 when the intent could not be recorded", async () => {
    // `host free-port-and-restart` reaches the controller's `restart` directly,
    // and that path kills the host exactly as `stop` does - `schtasks /End` plus
    // a process-tree kill - before running the task again. With no record the
    // orphaned supervisor reads the kill as a crash and relaunches on its own
    // schedule, racing the `/Run` that is starting the replacement: one restart,
    // two hosts. "It comes back anyway" is not a reason to skip the record.
    mocks.platform = "win32";
    mocks.persisted = false;
    let restarted = false;
    const controller = withStopIntent(
      baseController({
        restart: async () => {
          restarted = true;
        },
      }),
    );

    await expect(controller.restart(label)).rejects.toThrow(
      /could not record the stop request/,
    );
    expect(restarted).toBe(false);
  });

  it("proceeds with a restart on POSIX when the intent could not be recorded", async () => {
    mocks.platform = "linux";
    mocks.persisted = false;
    let restarted = false;
    const controller = withStopIntent(
      baseController({
        restart: async () => {
          restarted = true;
        },
      }),
    );

    await controller.restart(label);

    expect(restarted).toBe(true);
  });

  it("leaves the record standing after a SUCCESSFUL restart", async () => {
    // This used to clear in `finally`, and that was the bug. On win32 the killed
    // host's supervisor survives as an orphan, and `restartService` returns once
    // the replacement's `starting` marker is written - before it has spawned a
    // child or published `pid.json`. Clearing there hands the old supervisor a
    // window in which it sees neither intent nor an incumbent, and it relaunches
    // into the one the `/Run` is bringing up. One restart, two hosts.
    //
    // Keeping it is safe precisely because the record is not a global mute:
    // `hasActionableStopIntent` compares it against the READER's invocation
    // time, so the replacement supervisor - started after the request - reads it
    // as already served and spawns normally.
    const controller = withStopIntent(
      baseController({ restart: async () => undefined }),
    );

    await controller.restart(label);

    expect(mocks.writes).toEqual(["restart"]);
    expect(mocks.clears).toEqual([]);
  });

  it("leaves the starts alone entirely - no write, no clear", async () => {
    // The starts used to clear in `finally`, justified by "a leftover intent
    // would suppress the NEXT crash's recovery". The invocation cutoff had
    // already made that false, and the clear carried the same resurrection race
    // as the restart above: `host start` after a `host stop` re-arms the
    // orphaned supervisor if the new host has not published yet.
    const started = withStopIntent(
      baseController({ start: async () => undefined }),
    );
    await started.start(label);

    const relaunched = withStopIntent(
      baseController({ relaunchAfterRestart: async () => undefined }),
    );
    await relaunched.relaunchAfterRestart(label, { forcedRecycle: false });

    const installed = withStopIntent(
      baseController({ install: async () => undefined }),
    );
    await installed.install({
      label,
      cli: { command: "traycer", args: [] },
      enableLinger: false,
    });

    expect(mocks.writes).toEqual([]);
    expect(mocks.clears).toEqual([]);
  });
});
