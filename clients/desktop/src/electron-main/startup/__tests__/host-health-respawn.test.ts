import { describe, expect, it } from "vitest";
import type { IpcHostController } from "../../ipc/runner-ipc-bridge";
import type {
  ActivateInstalledOk,
  MutationOutcome,
} from "../../host/host-controller-types";
import {
  HostRecoveryDeferredError,
  respawnIfDown,
} from "../host-health-respawn";

function fakeControllerWithRecoverOutcome(
  outcome:
    MutationOutcome<ActivateInstalledOk> | { readonly kind: "suppressed" },
): IpcHostController {
  return {
    async recoverIfDown() {
      return outcome;
    },
    getStatus: () => {
      throw new Error("fakeController.getStatus: not used by these tests");
    },
    convergeReady: () => {
      throw new Error("fakeController.convergeReady: not used by these tests");
    },
    stageLatest: () => {
      throw new Error("fakeController.stageLatest: not used by these tests");
    },
    applyStaged: () => {
      throw new Error("fakeController.applyStaged: not used by these tests");
    },
    activateInstalled: () => {
      throw new Error(
        "fakeController.activateInstalled: not used by these tests",
      );
    },
    installVersion: () => {
      throw new Error("fakeController.installVersion: not used by these tests");
    },
    registerService: () => {
      throw new Error(
        "fakeController.registerService: not used by these tests",
      );
    },
    deregisterService: () => {
      throw new Error(
        "fakeController.deregisterService: not used by these tests",
      );
    },
    respawn: () => {
      throw new Error("fakeController.respawn: not used by these tests");
    },
    freePortAndRestart: () => {
      throw new Error(
        "fakeController.freePortAndRestart: not used by these tests",
      );
    },
    uninstallHost: () => {
      throw new Error("fakeController.uninstallHost: not used by these tests");
    },
    removeTraycer: () => {
      throw new Error("fakeController.removeTraycer: not used by these tests");
    },
    isPendingRevisionRefreshQuarantined: () => {
      throw new Error(
        "fakeController.isPendingRevisionRefreshQuarantined: not used by these tests",
      );
    },
    onMutationProgress: () => {
      throw new Error(
        "fakeController.onMutationProgress: not used by these tests",
      );
    },
  };
}

describe("respawnIfDown (fixup B3: automatic-intent lock-contention class)", () => {
  it("resolves without throwing on 'ok'", async () => {
    const controller = fakeControllerWithRecoverOutcome({
      kind: "ok",
      value: { activated: true },
    });
    await expect(respawnIfDown(controller)).resolves.toBeUndefined();
  });

  it("F5: treats 'suppressed' as deferred until the monitor confirms lifecycle publication", async () => {
    const controller = fakeControllerWithRecoverOutcome({
      kind: "suppressed",
    });
    await expect(respawnIfDown(controller)).rejects.toBeInstanceOf(
      HostRecoveryDeferredError,
    );
  });

  it("throws a retryable signal on lock-contention deferred so the monitor retains recovery ownership", async () => {
    const controller = fakeControllerWithRecoverOutcome({
      kind: "deferred",
      message: "Another Traycer process is managing the host.",
    });
    await expect(respawnIfDown(controller)).rejects.toBeInstanceOf(
      HostRecoveryDeferredError,
    );
  });

  it("resolves without throwing when the host was explicitly removed by the user", async () => {
    const controller = fakeControllerWithRecoverOutcome({
      kind: "deferred",
      message: "Host was removed by the user.",
    });
    await expect(respawnIfDown(controller)).resolves.toBeUndefined();
  });

  it("throws on 'failed' so the health monitor logs a genuine recovery failure", async () => {
    const controller = fakeControllerWithRecoverOutcome({
      kind: "failed",
      message: "boom",
    });
    await expect(respawnIfDown(controller)).rejects.toThrow("boom");
  });

  it("throws on 'busy' so the health monitor logs it", async () => {
    const controller = fakeControllerWithRecoverOutcome({
      kind: "busy",
      continuation: "retry-with-force",
      message: "host has work in progress",
    });
    await expect(respawnIfDown(controller)).rejects.toThrow(
      "host has work in progress",
    );
  });
});
