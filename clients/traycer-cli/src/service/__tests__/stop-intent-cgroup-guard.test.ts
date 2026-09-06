import { describe, expect, it, beforeEach, vi } from "vitest";
import type { ServiceController, ServiceLabel } from "../index";

// The second line of defence behind `withRunner`'s relocation
// (host/cgroup-relocation.ts): every stop-shaped route on `withStopIntent`
// re-reads `/proc/self/cgroup` and refuses BEFORE `announceStop`, so a
// refusal leaves no record of a stop that never happened.
//
// This file only exercises the guard's placement and its refusal/pass-through
// behaviour. `stop-intent-decorator.test.ts` already covers the write/clear
// ordering in full and must not be touched or duplicated here - node:os is
// pinned to darwin there, so its assertions are untouched by this guard.

const mocks = vi.hoisted(() => ({
  writes: [] as string[],
  clears: [] as string[],
  persisted: true,
  // A string is the cgroup file's contents; an object is the errno the read
  // fails with instead.
  cgroup: null as string | null | { readonly errno: string },
}));

vi.mock("../../logger", () => ({
  createCliLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  errorFromUnknown: (value: unknown) =>
    value instanceof Error ? value : new Error(String(value)),
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
  findLiveIncumbentHost: async () => null,
}));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, platform: () => "linux" as NodeJS.Platform };
});

const HOST_UNIT_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/ai.traycer.host.service\n";
const SCOPE_CGROUP =
  "0::/user.slice/user-1000.slice/user@1000.service/app.slice/run-r123.scope\n";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readFile: (async (
      path: Parameters<typeof actual.readFile>[0],
      options: Parameters<typeof actual.readFile>[1] | undefined,
    ) => {
      if (path === "/proc/self/cgroup") {
        if (mocks.cgroup === null) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        if (typeof mocks.cgroup === "object") {
          throw Object.assign(new Error(mocks.cgroup.errno), {
            code: mocks.cgroup.errno,
          });
        }
        return mocks.cgroup;
      }
      return options === undefined
        ? actual.readFile(path)
        : actual.readFile(path, options);
    }) as typeof actual.readFile,
  };
});

const { withStopIntent } = await import("../index");

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
  mocks.cgroup = HOST_UNIT_CGROUP;
});

describe("withStopIntent - Linux cgroup self-protection guard", () => {
  it("stop: refuses with E_SERVICE_CONTROL_FAILED before announcing, writing, or running the controller", async () => {
    let stopped = false;
    const controller = withStopIntent(
      baseController({
        stop: async () => {
          stopped = true;
        },
      }),
    );

    await expect(
      controller.stop(label, { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });

    expect(mocks.writes).toEqual([]);
    expect(stopped).toBe(false);
    expect(mocks.clears).toEqual([]);
  });

  it("stopForRestart: refuses before announcing, writing, or running the controller", async () => {
    let ran = false;
    const controller = withStopIntent(
      baseController({
        stopForRestart: async () => {
          ran = true;
          return { forcedRecycle: false };
        },
      }),
    );

    await expect(
      controller.stopForRestart(label, { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });

    expect(mocks.writes).toEqual([]);
    expect(ran).toBe(false);
    expect(mocks.clears).toEqual([]);
  });

  it("uninstall: refuses before announcing, writing, or running the controller", async () => {
    let ran = false;
    const controller = withStopIntent(
      baseController({
        uninstall: async () => {
          ran = true;
        },
      }),
    );

    await expect(controller.uninstall({ label })).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    expect(mocks.writes).toEqual([]);
    expect(ran).toBe(false);
    expect(mocks.clears).toEqual([]);
  });

  it("restart: refuses before announcing, writing, or running the controller", async () => {
    let ran = false;
    const controller = withStopIntent(
      baseController({
        restart: async () => {
          ran = true;
        },
      }),
    );

    await expect(controller.restart(label)).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    expect(mocks.writes).toEqual([]);
    expect(ran).toBe(false);
    expect(mocks.clears).toEqual([]);
  });

  // Positive control: a relocated scope cgroup (`run-*.scope`) is not a host
  // unit, so the guard resolves and every route proceeds exactly as it did
  // before this change - `stop-intent-decorator.test.ts` covers the ordering
  // and withdrawal semantics in full; this is just proof the guard is not
  // gating every call unconditionally regardless of cgroup content.
  it("proceeds through all four routes when outside a host unit (run-*.scope)", async () => {
    mocks.cgroup = SCOPE_CGROUP;
    let stopRan = false;
    let stopForRestartRan = false;
    let uninstallRan = false;
    let restartRan = false;

    const stopController = withStopIntent(
      baseController({
        stop: async () => {
          stopRan = true;
        },
      }),
    );
    await stopController.stop(label, { force: false });

    const stopForRestartController = withStopIntent(
      baseController({
        stopForRestart: async () => {
          stopForRestartRan = true;
          return { forcedRecycle: false };
        },
      }),
    );
    await stopForRestartController.stopForRestart(label, { force: false });

    const uninstallController = withStopIntent(
      baseController({
        uninstall: async () => {
          uninstallRan = true;
        },
      }),
    );
    await uninstallController.uninstall({ label });

    const restartController = withStopIntent(
      baseController({
        restart: async () => {
          restartRan = true;
        },
      }),
    );
    await restartController.restart(label);

    expect(stopRan).toBe(true);
    expect(stopForRestartRan).toBe(true);
    expect(uninstallRan).toBe(true);
    expect(restartRan).toBe(true);
    expect(mocks.writes).toEqual(["stop", "restart", "uninstall", "restart"]);
  });

  // An unreadable cgroup is a FAILED membership check, not a negative answer,
  // and it has to refuse on every route for the same reason the host-unit case
  // does: EACCES leaves us just as likely to be inside the unit, and proceeding
  // writes intent and then kills the process issuing the stop.
  it("refuses on all four routes when the cgroup cannot be read (EACCES)", async () => {
    mocks.cgroup = { errno: "EACCES" };
    let ran = false;
    const controller = withStopIntent(
      baseController({
        stop: async () => {
          ran = true;
        },
        stopForRestart: async () => {
          ran = true;
          return { forcedRecycle: false };
        },
        uninstall: async () => {
          ran = true;
        },
        restart: async () => {
          ran = true;
        },
      }),
    );

    await expect(
      controller.stop(label, { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });
    await expect(
      controller.stopForRestart(label, { force: false }),
    ).rejects.toMatchObject({ code: "E_SERVICE_CONTROL_FAILED" });
    await expect(controller.uninstall({ label })).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });
    await expect(controller.restart(label)).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    expect(mocks.writes).toEqual([]);
    expect(mocks.clears).toEqual([]);
    expect(ran).toBe(false);

    // Ablation: in `readHostUnitCgroup` (host/cgroup-relocation.ts), replace
    // the `isMissingCgroupFile` branch with a blanket `return null` → this
    // test fails on the first route: the guard resolves, intent is written,
    // and the stop proceeds from inside a cgroup nobody could rule out.
  });

  // An ABSENT cgroup file is a different machine and a real answer: no cgroup
  // exists that could kill us, so all four proceed.
  it("proceeds on all four routes when /proc/self/cgroup is absent (ENOENT)", async () => {
    mocks.cgroup = { errno: "ENOENT" };
    const controller = withStopIntent(
      baseController({
        stop: async () => undefined,
        stopForRestart: async () => ({ forcedRecycle: false }),
        uninstall: async () => undefined,
        restart: async () => undefined,
      }),
    );

    await controller.stop(label, { force: false });
    await controller.stopForRestart(label, { force: false });
    await controller.uninstall({ label });
    await controller.restart(label);

    expect(mocks.writes).toEqual(["stop", "restart", "uninstall", "restart"]);
  });

  // Ablation (run once per method, one at a time - four separate ablations):
  // in `service/index.ts`'s `withStopIntent`, delete the
  // `await assertNotInsideHostUnit();` line from `stop` → its refusal test
  // above fails (the write/controller-call assertions flip: writes becomes
  // ["stop"] and `stopped` becomes true instead of staying at their refused
  // values). Same recipe for `stopForRestart`, `uninstall`, and `restart` -
  // deleting any one of the four guard calls turns exactly that method's
  // refusal test red while leaving the other three green, which is what
  // proves the guard is wired into each route independently rather than
  // shared through some common choke point that would fail all four at once.
});
