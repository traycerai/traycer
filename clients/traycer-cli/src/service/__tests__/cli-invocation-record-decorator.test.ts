import { describe, expect, it, vi, beforeEach } from "vitest";
import type {
  CompetingRegistrationRetirement,
  ServiceController,
  ServiceLabel,
} from "../index";

const mocks = vi.hoisted(() => ({
  registrations: [] as string[],
  uninstalls: [] as string[],
  removals: [] as string[],
  hostHomes: [] as string[],
  callRegister: true,
  callUninstall: true,
  // When true, the mocked transaction wrapper throws BEFORE calling
  // `opts.uninstall()` at all - simulating a failed txn acquire - so tests
  // can assert nothing downstream (the stop intent) ran.
  throwBeforeUninstall: false,
  // Shared ordering trace: the transaction wrapper pushes "txn-open" before
  // calling the OS callback and "txn-commit" after it resolves, while the OS
  // callback itself (supplied per-test) pushes its own "os-*" marker, and the
  // stop-intent decorator pushes "stop-intent" when it writes the intent.
  // This proves the OS mutation runs INSIDE the transaction, not merely that
  // it ran at all, and that the transaction is entered before the intent is
  // written.
  order: [] as string[],
  // The `removed` predicate `withCliInvocationRecord` passes to
  // `runServiceRemovalWithInvocationRecord` for `retireCompetingRegistration`,
  // captured so tests can drive it directly against every
  // `CompetingRegistrationRetirement` kind rather than only the one kind a
  // single call happens to produce.
  lastRemovedPredicate: null as
    | ((result: CompetingRegistrationRetirement) => boolean)
    | null,
}));

vi.mock("../cli-invocation-record", () => ({
  CLI_INVOCATION_TXN_WAIT_MS: 30_000,
  CLI_INVOCATION_TXN_POLL_MS: 100,
  runServiceRegistrationWithInvocationRecord: async (opts: {
    readonly serviceLabel: string;
    readonly hostHomeDir: string;
    readonly register: () => Promise<void>;
  }) => {
    mocks.registrations.push(opts.serviceLabel);
    mocks.hostHomes.push(opts.hostHomeDir);
    mocks.order.push("txn-open");
    if (mocks.callRegister) await opts.register();
    mocks.order.push("txn-commit");
  },
  runServiceUninstallWithInvocationRecord: async (opts: {
    readonly serviceLabel: string;
    readonly uninstall: () => Promise<void>;
  }) => {
    mocks.uninstalls.push(opts.serviceLabel);
    mocks.order.push("txn-open");
    if (mocks.throwBeforeUninstall) {
      throw new Error("txn-acquire-failed");
    }
    if (mocks.callUninstall) await opts.uninstall();
    mocks.order.push("txn-commit");
  },
  runServiceRemovalWithInvocationRecord: async (opts: {
    readonly serviceLabel: string;
    readonly hostHomeDir: string;
    readonly remove: () => Promise<CompetingRegistrationRetirement>;
    readonly removed: (result: CompetingRegistrationRetirement) => boolean;
  }) => {
    mocks.removals.push(opts.serviceLabel);
    mocks.hostHomes.push(opts.hostHomeDir);
    mocks.lastRemovedPredicate = opts.removed;
    mocks.order.push("txn-open");
    const result = await opts.remove();
    mocks.order.push("txn-commit");
    return result;
  },
}));

vi.mock("../../host/stop-intent", () => ({
  writeStopIntent: async () => {
    mocks.order.push("stop-intent");
    return true;
  },
  clearStopIntent: async () => undefined,
}));

vi.mock("../../host/incumbent-check", () => ({
  findLiveIncumbentHost: async () => null,
}));

const { withCliInvocationRecord, withStopIntent, createServiceController } =
  await import("../index");

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
  mocks.registrations.length = 0;
  mocks.uninstalls.length = 0;
  mocks.removals.length = 0;
  mocks.hostHomes.length = 0;
  mocks.callRegister = true;
  mocks.callUninstall = true;
  mocks.throwBeforeUninstall = false;
  mocks.order.length = 0;
  mocks.lastRemovedPredicate = null;
});

describe("withCliInvocationRecord", () => {
  it("runs OS install inside the registration transaction", async () => {
    const controller = withCliInvocationRecord(
      baseController({
        install: async () => {
          mocks.order.push("os-install");
        },
      }),
    );
    await controller.install({
      label,
      cli: { command: "/abs/traycer", args: [] },
      enableLinger: false,
    });
    expect(mocks.registrations).toEqual([label.id]);
    expect(mocks.order).toEqual(["txn-open", "os-install", "txn-commit"]);
  });

  it("runs OS uninstall inside the uninstall transaction", async () => {
    const controller = withCliInvocationRecord(
      baseController({
        uninstall: async () => {
          mocks.order.push("os-uninstall");
        },
      }),
    );
    await controller.uninstall({ label });
    expect(mocks.uninstalls).toEqual([label.id]);
    expect(mocks.order).toEqual(["txn-open", "os-uninstall", "txn-commit"]);
  });

  it("propagates an OS install failure without swallowing it", async () => {
    const controller = withCliInvocationRecord(
      baseController({
        install: async () => {
          throw new Error("os-install-refused");
        },
      }),
    );
    await expect(
      controller.install({
        label,
        cli: { command: "/abs/traycer", args: [] },
        enableLinger: false,
      }),
    ).rejects.toThrow("os-install-refused");
  });

  it("propagates an OS uninstall failure without swallowing it", async () => {
    const controller = withCliInvocationRecord(
      baseController({
        uninstall: async () => {
          throw new Error("os-uninstall-refused");
        },
      }),
    );
    await expect(controller.uninstall({ label })).rejects.toThrow(
      "os-uninstall-refused",
    );
  });

  it("leaves every other controller method untouched", () => {
    const status = vi.fn();
    const controller = withCliInvocationRecord(baseController({ status }));
    expect(controller.status).toBe(status);
  });

  it("forwards takeoverDesktopRegistration unchanged", () => {
    const takeoverDesktopRegistration = vi.fn();
    const controller = withCliInvocationRecord(
      baseController({ takeoverDesktopRegistration }),
    );
    expect(controller.takeoverDesktopRegistration).toBe(
      takeoverDesktopRegistration,
    );
  });
});

describe("withCliInvocationRecord retireCompetingRegistration wiring", () => {
  it("runs OS retireCompetingRegistration inside the removal transaction and returns its result unchanged", async () => {
    const retirement: CompetingRegistrationRetirement = {
      kind: "retired",
      bootedOut: true,
      manifestRemoved: true,
      agentStartRequested: false,
    };
    const controller = withCliInvocationRecord(
      baseController({
        retireCompetingRegistration: async () => {
          mocks.order.push("os-retire");
          return retirement;
        },
      }),
    );
    const result = await controller.retireCompetingRegistration(label);
    expect(result).toEqual(retirement);
    expect(mocks.removals).toEqual([label.id]);
    expect(mocks.order).toEqual(["txn-open", "os-retire", "txn-commit"]);
  });

  it("propagates an OS retireCompetingRegistration failure without swallowing it", async () => {
    const controller = withCliInvocationRecord(
      baseController({
        retireCompetingRegistration: async () => {
          throw new Error("retire-refused");
        },
      }),
    );
    await expect(controller.retireCompetingRegistration(label)).rejects.toThrow(
      "retire-refused",
    );
  });

  it("classifies retired and retire-failed as removed - every other outcome as untouched", async () => {
    // `retired` and `retire-failed` both mean the registration was taken
    // away wholly or in part, so the record must be invalidated exactly as
    // an uninstall does; every other outcome touched nothing on the OS side
    // and must leave the record alone. This drives the captured `removed`
    // predicate directly against all five `CompetingRegistrationRetirement`
    // kinds, rather than relying on whichever one kind a single call
    // happens to produce - the case ablation D targets specifically
    // (`removed: () => false` would flip only the first two).
    const controller = withCliInvocationRecord(
      baseController({
        retireCompetingRegistration: async () => ({
          kind: "not-applicable",
        }),
      }),
    );
    await controller.retireCompetingRegistration(label);
    const removed = mocks.lastRemovedPredicate;
    if (removed === null) {
      throw new Error("expected the removed predicate to be captured");
    }
    expect(
      removed({
        kind: "retired",
        bootedOut: true,
        manifestRemoved: true,
        agentStartRequested: false,
      }),
    ).toBe(true);
    expect(
      removed({
        kind: "retire-failed",
        bootoutFailed: true,
        manifestRemovalFailed: false,
      }),
    ).toBe(true);
    expect(removed({ kind: "not-applicable" })).toBe(false);
    expect(removed({ kind: "nothing-to-retire" })).toBe(false);
    expect(
      removed({ kind: "kept-agent-possibly-wedged", probe: "wedged" }),
    ).toBe(false);
  });
});

describe("invocation-record decorator nesting order", () => {
  it("enters the invocation-record transaction before the stop intent is written on uninstall", async () => {
    const controller = withCliInvocationRecord(
      withStopIntent(
        baseController({
          uninstall: async () => {
            mocks.order.push("os-uninstall");
          },
        }),
      ),
    );
    await controller.uninstall({ label });
    expect(mocks.order).toEqual([
      "txn-open",
      "stop-intent",
      "os-uninstall",
      "txn-commit",
    ]);
  });

  it("never writes the stop intent when the transaction fails before uninstall runs", async () => {
    mocks.throwBeforeUninstall = true;
    const controller = withCliInvocationRecord(
      withStopIntent(
        baseController({
          uninstall: async () => {
            mocks.order.push("os-uninstall");
          },
        }),
      ),
    );
    await expect(controller.uninstall({ label })).rejects.toThrow(
      "txn-acquire-failed",
    );
    expect(mocks.order).toEqual(["txn-open"]);
  });
});

describe("createServiceController wiring", () => {
  it("routes install through the invocation-record wrapper without requiring OS mutation", async () => {
    mocks.callRegister = false;
    const controller = createServiceController();
    await controller.install({
      label,
      cli: { command: "/abs/traycer", args: [] },
      enableLinger: false,
    });
    expect(mocks.registrations).toEqual([label.id]);
    expect(mocks.hostHomes.length).toBe(1);
  });

  it("routes uninstall through the invocation-record wrapper without requiring OS mutation", async () => {
    mocks.callUninstall = false;
    const controller = createServiceController();
    await controller.uninstall({ label });
    expect(mocks.uninstalls).toEqual([label.id]);
  });

  it("wraps the same platform controller for both install and uninstall on the current platform", async () => {
    // Wiring bug class: install and uninstall silently resolving to
    // different platform backends (e.g. one branch left unwrapped after a
    // refactor). Both calls must reach the SAME mocked transaction wrapper
    // with the SAME label/environment, on whichever platform this suite
    // actually runs on.
    mocks.callRegister = false;
    mocks.callUninstall = false;
    const controller = createServiceController();
    await controller.install({
      label,
      cli: { command: "/abs/traycer", args: [] },
      enableLinger: false,
    });
    await controller.uninstall({ label });
    expect(mocks.registrations).toEqual([label.id]);
    expect(mocks.uninstalls).toEqual([label.id]);
  });
});
