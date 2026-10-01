import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ServiceController, ServiceLabel } from "../index";
import type { ForegroundHostRun } from "../../host/foreground-host-run";

// Row under test: "host service uninstall" over a live FOREGROUND run (a
// terminal-started `traycer host start`, which no service manager started and
// so none can stop) must NOT refuse. It proceeds, but must leave the
// terminal-started host's process alone AND skip writing a stop-intent record
// for it - no stop is actually happening to THAT host, so announcing one
// would be a lie the orphaned supervisor could later act on, and clearing an
// unrelated pre-existing record would be destroying evidence for a stop that
// really did happen elsewhere.
//
// `UninstallServiceOptions.leaveForegroundRun` carries this: non-null means
// "there's a foreground run to leave alone", null means the ordinary case
// (unchanged behavior - the intent is written before the inner call runs, as
// today).
//
// This file is RED against the CURRENT `withStopIntent.uninstall`, which does
// not read `leaveForegroundRun` at all: it unconditionally writes the intent
// before calling inner, and unconditionally retires it based on inner's
// outcome via `retireIntentIfHostSurvived`.

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

// Same rationale as `stop-intent-decorator.test.ts`: this suite pins
// `withStopIntent`'s write/clear behavior around `leaveForegroundRun`, not the
// Linux cgroup self-protection guard that runs ahead of it on every route.
vi.mock("../../host/cgroup-relocation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../host/cgroup-relocation")>();
  return { ...actual, assertNotInsideHostUnit: async () => undefined };
});

const { withStopIntent } = await import("../index");

const label: ServiceLabel = {
  id: "ai.traycer.host",
  displayName: "Traycer Host",
  environment: "production",
  devSlot: null,
};

const foregroundRun: ForegroundHostRun = {
  supervisorPid: 111,
  hostPid: 222,
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
    hostStartAdoptionLabel: unimplemented,
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
  mocks.liveHost = null;
  mocks.incumbentProbes = 0;
});

describe("withStopIntent.uninstall with leaveForegroundRun", () => {
  it("writes NO stop-intent record when leaving a foreground run alone", async () => {
    let innerCallCount = 0;
    let innerOptions: unknown = null;
    const controller = withStopIntent(
      baseController({
        uninstall: async (options) => {
          innerCallCount += 1;
          innerOptions = options;
        },
      }),
    );

    await controller.uninstall({ label, leaveForegroundRun: foregroundRun });

    // No stop-intent record should ever be written for this uninstall: no
    // stop is actually happening to the foreground-run host.
    expect(mocks.writes).toEqual([]);
    expect(innerCallCount).toBe(1);
    expect(innerOptions).toEqual({
      label,
      leaveForegroundRun: foregroundRun,
    });
  });

  it("an existing stop-intent record survives when inner uninstall throws", async () => {
    // Simulate a pre-existing intent record from an unrelated prior stop by
    // seeding what the decorator would see as "already written" - since this
    // decorator only ever WRITES or CLEARS (never reads for this suite's
    // purposes), the record's survival is evidenced by `clears` staying
    // empty: `retireIntentIfHostSurvived` must never be invoked when
    // `leaveForegroundRun !== null`, whatever inner does.
    mocks.liveHost = { pid: 4242 };
    const controller = withStopIntent(
      baseController({
        uninstall: async () => {
          throw new Error("boom: inner uninstall failed");
        },
      }),
    );

    await expect(
      controller.uninstall({ label, leaveForegroundRun: foregroundRun }),
    ).rejects.toThrow("boom");

    // No write happened for this uninstall...
    expect(mocks.writes).toEqual([]);
    // ...and no retirement (clear) was attempted either - the pre-existing
    // record, if any, is left completely alone.
    expect(mocks.clears).toEqual([]);
    expect(mocks.incumbentProbes).toBe(0);
  });

  it("(control) writes the uninstall intent before inner runs when leaveForegroundRun is null", async () => {
    let writesWhenUninstallRan: string[] = [];
    const controller = withStopIntent(
      baseController({
        uninstall: async () => {
          writesWhenUninstallRan = [...mocks.writes];
        },
      }),
    );

    await controller.uninstall({ label, leaveForegroundRun: null });

    expect(writesWhenUninstallRan).toEqual(["uninstall"]);
    expect(mocks.writes).toEqual(["uninstall"]);
  });
});
