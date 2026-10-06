import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { createPendingActivationIdleMonitor } from "../pending-activation-idle-monitor";
import type { PendingActivationIdleMonitorHostController } from "../pending-activation-idle-monitor";
import type {
  ActivateInstalledOk,
  HostControllerStatus,
  MutationOutcome,
} from "../host-controller-types";
import type { HostBusyVerdict } from "../host-state";

vi.mock("../../app/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The monitor owns only the interval, the failure budget and the armed flag.
// The restart itself is the controller's idle-gated `activateInstalled(false,
// false)`; these tests pin when the monitor calls it and when it stops.

const INTERVAL_MS = 1_000;

type Outcome = MutationOutcome<ActivateInstalledOk>;

const OK_ACTIVATED: Outcome = { kind: "ok", value: { activated: true } };
const FAILED: Outcome = {
  kind: "failed",
  message: "activation failed",
  errorCode: null,
};

function statusWith(
  activation: HostControllerStatus["activation"],
): HostControllerStatus {
  return {
    download: null,
    mutation: null,
    installedVersion: null,
    latestVersion: null,
    stagedVersion: null,
    installedRuntimeVersion: null,
    runningRuntimeVersion: null,
    updateReady: false,
    activation,
    reachable: true,
    localAttempt: null,
    removedByUser: false,
    lastEnsureFailure: null,
    updateDeferral: null,
    checkedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("createPendingActivationIdleMonitor", () => {
  let activation: HostControllerStatus["activation"];
  let verdict: HostBusyVerdict;
  let activate: Mock<() => Promise<Outcome>>;
  let probe: Mock<() => Promise<HostBusyVerdict>>;
  let activateInstalled: Mock<
    (force: boolean, promote: boolean) => Promise<Outcome>
  >;

  function build() {
    const hostController: PendingActivationIdleMonitorHostController = {
      getStatus: async () => statusWith(activation),
      activateInstalled,
    };
    return createPendingActivationIdleMonitor({
      hostController,
      probeHostBusy: probe,
      intervalMs: INTERVAL_MS,
    });
  }

  async function ticks(count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
      await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    activation = "pendingActivation";
    verdict = "busy";
    activate = vi.fn(async () => OK_ACTIVATED);
    probe = vi.fn(async () => verdict);
    activateInstalled = vi.fn(async () => activate());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("arm() with nothing pending resolves ok/not-activated and neither activates nor starts ticking", async () => {
    activation = "activated";
    const monitor = build();
    await expect(monitor.arm()).resolves.toEqual({
      kind: "ok",
      value: { activated: false },
    });
    await ticks(3);
    expect(probe).not.toHaveBeenCalled();
    expect(activateInstalled).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("arm() on a busy host resolves busy/activate without activating, and later ticks retry", async () => {
    const monitor = build();
    const outcome = await monitor.arm();
    expect(outcome.kind).toBe("busy");
    expect(outcome.kind === "busy" && outcome.continuation).toBe("activate");
    expect(activateInstalled).not.toHaveBeenCalled();
    expect(probe).toHaveBeenCalledTimes(1);

    await ticks(2);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(activateInstalled).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("activates exactly once with (false, false) when the host goes idle, then stops", async () => {
    const monitor = build();
    await monitor.arm();
    verdict = "idle";
    await ticks(1);
    expect(activateInstalled).toHaveBeenCalledTimes(1);
    expect(activateInstalled).toHaveBeenCalledWith(false, false);

    probe.mockClear();
    await ticks(3);
    expect(probe).not.toHaveBeenCalled();
    expect(activateInstalled).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });

  it("stops when a tick finds nothing pending", async () => {
    const monitor = build();
    await monitor.arm();
    activation = "activated";
    await ticks(1);
    probe.mockClear();
    await ticks(3);
    expect(probe).not.toHaveBeenCalled();
    expect(activateInstalled).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("disarm() stops the retries", async () => {
    const monitor = build();
    await monitor.arm();
    monitor.disarm();
    probe.mockClear();
    await ticks(3);
    expect(probe).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("dispose() stops the retries", async () => {
    const monitor = build();
    await monitor.arm();
    monitor.dispose();
    probe.mockClear();
    await ticks(3);
    expect(probe).not.toHaveBeenCalled();
  });

  it("exhausts the budget after 3 failed or thrown attempts and stops", async () => {
    const monitor = build();
    await monitor.arm();
    verdict = "idle";
    activate.mockResolvedValueOnce(FAILED);
    activate.mockRejectedValueOnce(new Error("boom"));
    activate.mockResolvedValueOnce(FAILED);
    await ticks(3);
    expect(activateInstalled).toHaveBeenCalledTimes(3);

    await ticks(3);
    expect(activateInstalled).toHaveBeenCalledTimes(3);
    monitor.dispose();
  });

  it("never spends the budget on busy ticks", async () => {
    const monitor = build();
    await monitor.arm();
    await ticks(10);
    expect(probe).toHaveBeenCalledTimes(11);

    verdict = "idle";
    await ticks(1);
    expect(activateInstalled).toHaveBeenCalledTimes(1);
    monitor.dispose();
  });
});
