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

// The record transaction is the thing the outer decorator must NOT open when
// the guard refuses; a spy stands in for it so the ordering is observable.
// The stand-in still runs the wrapped uninstall, as the real transaction does,
// so the pass-through control below proves the controller is reached THROUGH
// it and not around it.
const recordMocks = vi.hoisted(() => ({
  uninstallTransactions: 0,
  registrationTransactions: 0,
}));

vi.mock("../cli-invocation-record", () => ({
  CLI_INVOCATION_TXN_POLL_MS: 10,
  CLI_INVOCATION_TXN_WAIT_MS: 100,
  runServiceRegistrationWithInvocationRecord: async (options: {
    readonly register: () => Promise<void>;
  }) => {
    recordMocks.registrationTransactions += 1;
    await options.register();
  },
  runServiceRemovalWithInvocationRecord: async () => {
    throw new Error("not used in this test");
  },
  runServiceUninstallWithInvocationRecord: async (options: {
    readonly uninstall: () => Promise<void>;
  }) => {
    recordMocks.uninstallTransactions += 1;
    await options.uninstall();
  },
}));

const { withCliInvocationRecord, withStopIntent } = await import("../index");

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
  recordMocks.uninstallTransactions = 0;
  recordMocks.registrationTransactions = 0;
});

const installOptions = {
  label,
  cli: { command: "/opt/traycer/traycer", args: [] },
  enableLinger: false,
} as const;

describe("withCliInvocationRecord(withStopIntent(...)) - the guard runs before the record transaction", () => {
  // The production composition puts the record decorator OUTSIDE the
  // stop-intent one, so its transaction would be acquired before the inner
  // guard ever ran - and a refusal thrown inside the transaction is treated
  // as an OS uninstall that threw, which marks an intact record stale. The
  // outer decorator therefore runs the guard itself, ahead of the
  // transaction; this pins that a refusal opens no transaction at all.
  it("uninstall: a guard refusal opens no record transaction and announces nothing", async () => {
    let ran = false;
    const controller = withCliInvocationRecord(
      withStopIntent(
        baseController({
          uninstall: async () => {
            ran = true;
          },
        }),
      ),
    );

    await expect(controller.uninstall({ label })).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    expect(recordMocks.uninstallTransactions).toBe(0);
    expect(mocks.writes).toEqual([]);
    expect(ran).toBe(false);

    // Ablation: remove the `await assertNotInsideHostUnit();` from
    // `withCliInvocationRecord`'s uninstall → this test reddens on
    // `uninstallTransactions` (1, not 0): the inner guard still refuses, but
    // only after the transaction stand-in has been entered.
  });

  it("uninstall: outside a host unit the transaction is entered exactly once and the controller runs through it", async () => {
    mocks.cgroup = SCOPE_CGROUP;
    let ran = false;
    const controller = withCliInvocationRecord(
      withStopIntent(
        baseController({
          uninstall: async () => {
            ran = true;
          },
        }),
      ),
    );

    await controller.uninstall({ label });

    expect(recordMocks.uninstallTransactions).toBe(1);
    expect(mocks.writes).toEqual(["uninstall"]);
    expect(ran).toBe(true);
  });

  // The install actuator is the fifth guarded route, and the outer guard
  // matters for it for the mirror-image reason: a throw from `register` inside
  // `runServiceRegistrationWithInvocationRecord` marks the live record stale
  // (the OS may describe a half-done registration), which a refusal that
  // touched nothing must not do to an intact registration.
  it("install: a guard refusal opens no registration transaction, announces nothing, and never reaches the controller", async () => {
    let ran = false;
    const controller = withCliInvocationRecord(
      withStopIntent(
        baseController({
          install: async () => {
            ran = true;
          },
        }),
      ),
    );

    await expect(controller.install(installOptions)).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    expect(recordMocks.registrationTransactions).toBe(0);
    expect(mocks.writes).toEqual([]);
    expect(ran).toBe(false);

    // Ablation: remove the `await assertNotInsideHostUnit();` from
    // `withCliInvocationRecord`'s install → this test reddens on
    // `registrationTransactions` (1, not 0): the inner guard still refuses,
    // but only after the transaction stand-in has been entered.
  });

  it("install: outside a host unit the registration transaction is entered exactly once, the controller runs through it, and no intent is written", async () => {
    mocks.cgroup = SCOPE_CGROUP;
    let ran = false;
    const controller = withCliInvocationRecord(
      withStopIntent(
        baseController({
          install: async () => {
            ran = true;
          },
        }),
      ),
    );

    await controller.install(installOptions);

    expect(recordMocks.registrationTransactions).toBe(1);
    // An install is not a stop: the guard is there for the Linux rollback's
    // sake, and no stop intent is announced on the way in.
    expect(mocks.writes).toEqual([]);
    expect(ran).toBe(true);
  });
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

  // Not a stop route, but its Linux failure path is one: `installService`
  // rolls a failed `enable --now` back with `disable --now` on the unit, which
  // stops the live host and, from inside the unit, the CLI issuing it.
  it("install: refuses before running the controller, and writes no intent either way", async () => {
    let ran = false;
    const controller = withStopIntent(
      baseController({
        install: async () => {
          ran = true;
        },
      }),
    );

    await expect(controller.install(installOptions)).rejects.toMatchObject({
      code: "E_SERVICE_CONTROL_FAILED",
    });

    expect(mocks.writes).toEqual([]);
    expect(mocks.clears).toEqual([]);
    expect(ran).toBe(false);
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
  it("proceeds through all five routes when outside a host unit (run-*.scope)", async () => {
    mocks.cgroup = SCOPE_CGROUP;
    let stopRan = false;
    let stopForRestartRan = false;
    let uninstallRan = false;
    let restartRan = false;
    let installRan = false;

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

    const installController = withStopIntent(
      baseController({
        install: async () => {
          installRan = true;
        },
      }),
    );
    await installController.install(installOptions);

    expect(stopRan).toBe(true);
    expect(stopForRestartRan).toBe(true);
    expect(uninstallRan).toBe(true);
    expect(restartRan).toBe(true);
    expect(installRan).toBe(true);
    // Four intents for four stops; the install writes none.
    expect(mocks.writes).toEqual(["stop", "restart", "uninstall", "restart"]);
  });

  // An unreadable cgroup is a FAILED membership check, not a negative answer,
  // and it has to refuse on every route for the same reason the host-unit case
  // does: EACCES leaves us just as likely to be inside the unit, and proceeding
  // writes intent and then kills the process issuing the stop.
  it("refuses on all five routes when the cgroup cannot be read (EACCES)", async () => {
    mocks.cgroup = { errno: "EACCES" };
    let ran = false;
    const controller = withStopIntent(
      baseController({
        install: async () => {
          ran = true;
        },
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
    await expect(controller.install(installOptions)).rejects.toMatchObject({
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
  // exists that could kill us, so all five proceed.
  it("proceeds on all five routes when /proc/self/cgroup is absent (ENOENT)", async () => {
    mocks.cgroup = { errno: "ENOENT" };
    let installRan = false;
    const controller = withStopIntent(
      baseController({
        install: async () => {
          installRan = true;
        },
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
    await controller.install(installOptions);

    expect(mocks.writes).toEqual(["stop", "restart", "uninstall", "restart"]);
    expect(installRan).toBe(true);
  });

  // Ablation (run once per method, one at a time - five separate ablations):
  // in `service/index.ts`'s `withStopIntent`, delete the
  // `await assertNotInsideHostUnit();` line from `stop` → its refusal test
  // above fails (the write/controller-call assertions flip: writes becomes
  // ["stop"] and `stopped` becomes true instead of staying at their refused
  // values). Same recipe for `stopForRestart`, `uninstall`, `restart`, and
  // `install` (whose `ran` flips to true; it writes nothing either way) -
  // deleting any one of the five guard calls turns exactly that method's
  // refusal test red (plus the combined EACCES test, which exercises every
  // route) while leaving the other four refusal tests green, which is what
  // proves the guard is wired into each route independently rather than
  // shared through some common choke point that would fail all five at once.
  // Run and confirmed for `install`: 2 failed, 10 passed.
});
