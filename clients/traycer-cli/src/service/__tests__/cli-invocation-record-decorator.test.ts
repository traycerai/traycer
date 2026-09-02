import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ServiceController, ServiceLabel } from "../index";

const mocks = vi.hoisted(() => ({
  registrations: [] as string[],
  uninstalls: [] as string[],
  hostHomes: [] as string[],
  callRegister: true,
  callUninstall: true,
  // Shared ordering trace: the transaction wrapper pushes "txn-open" before
  // calling the OS callback and "txn-commit" after it resolves, while the OS
  // callback itself (supplied per-test) pushes its own "os-*" marker. This
  // proves the OS mutation runs INSIDE the transaction, not merely that it
  // ran at all.
  order: [] as string[],
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
    if (mocks.callUninstall) await opts.uninstall();
    mocks.order.push("txn-commit");
  },
}));

vi.mock("../../host/stop-intent", () => ({
  writeStopIntent: async () => true,
  clearStopIntent: async () => undefined,
}));

vi.mock("../../host/incumbent-check", () => ({
  findLiveIncumbentHost: async () => null,
}));

const { withCliInvocationRecord, createServiceController } =
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
  mocks.hostHomes.length = 0;
  mocks.callRegister = true;
  mocks.callUninstall = true;
  mocks.order.length = 0;
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
