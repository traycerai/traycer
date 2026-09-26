import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  updateAttemptLockPath,
  updateAttemptRecordPath,
  withUpdateContender,
  type UpdateMutationCapability,
} from "@traycer-clients/shared/host-update";

const homeRef = vi.hoisted(() => ({ current: "" }));
const commitMock = vi.hoisted(() => ({
  invoke: vi.fn(),
}));
const adoptionMock = vi.hoisted(() => ({
  publish: vi.fn(),
}));
vi.mock("../../store/paths", () => ({
  hostHomeDir: () => homeRef.current,
}));
vi.mock("../../installer/apply", () => ({
  applyHost: vi.fn(),
}));
vi.mock("../../installer/install", () => ({
  commitHostInstallSource: (options: unknown) => commitMock.invoke(options),
}));
const busyMock = vi.hoisted(() => ({
  assertIdle: vi.fn(),
}));
vi.mock("../busy-check", () => ({
  assertHostIdleForStop: busyMock.assertIdle,
}));
vi.mock("../host-start-adoption", () => ({
  publishHostStartAdoption: adoptionMock.publish,
}));

import {
  installHostServiceWithAttempt,
  commitHostInstallSourceWithAttempt,
  refreshHostServiceDefinitionWithAttempt,
  stopHostForRestartWithAttempt,
  stopHostServiceWithAttempt,
} from "../update-mutation";
import type { ServiceDefinitionRefresh } from "../../service/service-definition";
import { withCliUpdateExecutionSegment } from "../update-contender";
import type {
  InstallServiceOptions,
  RestartStop,
  ServiceController,
} from "../../service";
import type {
  CommitHostInstallSourceOptions,
  StagedHostInstallSource,
} from "../../installer/install";
import { CLI_ERROR_CODES, cliError } from "../../runner/errors";
import { ungatedStoreFormatFloorEvidence } from "../store-format-floor";
import { atServiceSpawnEdge } from "../../service/spawn-edge";

const roots: string[] = [];

async function freshHome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cli-update-mutation-test-"));
  roots.push(root);
  return join(root, "host-home");
}

const contenderOptions = {
  environment: "production" as const,
  reason: "mutation-capability-test",
  waitMs: 0,
  pollIntervalMs: 10,
  admission: "service-maintenance" as const,
};

const serviceOptions: InstallServiceOptions = {
  label: {
    id: "ai.traycer.host",
    displayName: "Traycer Host",
    environment: "production",
    devSlot: null,
  },
  cli: { command: "traycer", args: [] },
  enableLinger: true,
};

const stagedSource: StagedHostInstallSource = {
  stagingDir: "/tmp/staging",
  archivePath: "/tmp/staging/archive.tar.gz",
  archiveIsTemporary: true,
  executablePath: "/tmp/staging/traycer-host",
  version: "2.0.0",
  runtimeVersion: null,
  source: { kind: "registry", value: "2.0.0" },
  archiveSha256: "a".repeat(64),
  signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
  signatureKeyId: "test-key",
  sizeBytes: 1,
};

afterEach(async () => {
  homeRef.current = "";
  adoptionMock.publish.mockReset();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("CLI capability-consuming mutation facades", () => {
  it("publishes the Desktop-owned agent label at the controller's spawn edge, not before the call", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const events: string[] = [];
    const lease = {
      waitForSpawn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    adoptionMock.publish.mockImplementation(
      async (_capability, _options, serviceLabel: string) => {
        events.push(`publish:${serviceLabel}`);
        return lease;
      },
    );
    // Models the real controller: entry into the call happens BEFORE the
    // spawn edge, which is the whole distinction this test exists to pin.
    // Publish-before-the-call (the old arrangement) and publish-at-the-edge
    // (the new one) both yield `label -> publish -> install` if the fake
    // only records entry and exit - the "controller-entered" marker is what
    // separates them: it can only land ahead of "publish" when the edge, not
    // the call itself, is what triggers the publication.
    const install = vi.fn(async () => {
      events.push("controller-entered");
      await atServiceSpawnEdge();
      events.push("install");
    });
    const hostStartAdoptionLabel = vi.fn(async () => {
      events.push("label");
      return "ai.traycer.host.agent";
    });

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      async (capability) => {
        await installHostServiceWithAttempt(
          capability,
          contenderOptions,
          "desktop",
          { install, hostStartAdoptionLabel },
          serviceOptions,
        );
        return "installed";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "installed" });
    expect(adoptionMock.publish).toHaveBeenCalledWith(
      expect.anything(),
      contenderOptions,
      "ai.traycer.host.agent",
      "desktop",
    );
    expect(events).toEqual([
      "label",
      "controller-entered",
      "publish:ai.traycer.host.agent",
      "install",
    ]);
    expect(lease.waitForSpawn).toHaveBeenCalledTimes(1);
    expect(lease.cancel).toHaveBeenCalledTimes(1);
  });

  it("a controller call that throws before reaching any spawn edge never publishes, waits, or cancels", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const lease = {
      waitForSpawn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    adoptionMock.publish.mockResolvedValue(lease);
    const preEdgeError = new Error("ownership probe failed before any edge");
    const install = vi.fn(async () => {
      // No `atServiceSpawnEdge()` call at all - models a controller that
      // fails during its pre-edge work (an ownership probe, a Desktop
      // stand-down) and never reaches the point where a grant would matter.
      throw preEdgeError;
    });
    const hostStartAdoptionLabel = vi.fn(
      async (label: { id: string }) => label.id,
    );

    await expect(
      withUpdateContender(
        {
          hostHomeDir,
          reason: contenderOptions.reason,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: contenderOptions.admission,
        },
        async (capability) =>
          installHostServiceWithAttempt(
            capability,
            contenderOptions,
            "desktop",
            { install, hostStartAdoptionLabel },
            serviceOptions,
          ),
      ),
    ).rejects.toBe(preEdgeError);

    expect(adoptionMock.publish).not.toHaveBeenCalled();
    expect(lease.waitForSpawn).not.toHaveBeenCalled();
    expect(lease.cancel).not.toHaveBeenCalled();
  });

  // Change 7 (fixup ticket): the adoption cleanup used to `await
  // adoption.cancel()` bare in `runWithHostStartAdoption`'s `finally` - a
  // rejecting cancel() would then replace whatever the actuator itself
  // threw or returned. It is now `.catch(() => undefined)`, so a lease
  // that fails to cancel must never mask the primary outcome.
  it("does not let a rejecting adoption cancel() mask the primary outcome", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const lease = {
      waitForSpawn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => {
        throw new Error("cancel transport failed");
      }),
    };
    adoptionMock.publish.mockResolvedValue(lease);
    const install = vi.fn(async () => {
      await atServiceSpawnEdge();
    });
    const hostStartAdoptionLabel = vi.fn(
      async (label: { id: string }) => label.id,
    );

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      async (capability) => {
        await installHostServiceWithAttempt(
          capability,
          contenderOptions,
          "desktop",
          { install, hostStartAdoptionLabel },
          serviceOptions,
        );
        return "installed";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "installed" });
    expect(lease.cancel).toHaveBeenCalledTimes(1);
  });

  it("waits for the adoption lease before rethrowing a committed-registration error", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const lease = {
      waitForSpawn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    adoptionMock.publish.mockResolvedValue(lease);
    const committedError = cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: "registered, but the record could not be committed",
      details: {
        label: "ai.traycer.host",
        phase: "commit",
        registrationCommitted: true,
      },
      exitCode: 1,
    });
    const install = vi.fn(async () => {
      // The lease is only published once the actuator reaches its spawn
      // edge, so the edge has to be reached before the record-step failure
      // that follows it.
      await atServiceSpawnEdge();
      throw committedError;
    });
    const hostStartAdoptionLabel = vi.fn(
      async (label: { id: string }) => label.id,
    );

    await expect(
      withUpdateContender(
        {
          hostHomeDir,
          reason: contenderOptions.reason,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: contenderOptions.admission,
        },
        async (capability) =>
          installHostServiceWithAttempt(
            capability,
            contenderOptions,
            "desktop",
            { install, hostStartAdoptionLabel },
            serviceOptions,
          ),
      ),
    ).rejects.toBe(committedError);

    expect(lease.waitForSpawn).toHaveBeenCalledTimes(1);
    expect(lease.cancel).toHaveBeenCalledTimes(1);
    // waitForSpawn must be awaited before cancel() runs.
    expect(lease.waitForSpawn.mock.invocationCallOrder[0]).toBeLessThan(
      lease.cancel.mock.invocationCallOrder[0] ?? Infinity,
    );
  });

  it("does not wait for the adoption lease on an ordinary actuator error", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const lease = {
      waitForSpawn: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
    };
    adoptionMock.publish.mockResolvedValue(lease);
    const osError = new Error("os-failed");
    const install = vi.fn(async () => {
      // The edge is reached (the lease is published) before the OS actuator
      // itself fails, ordinarily, with no registration commit involved.
      await atServiceSpawnEdge();
      throw osError;
    });
    const hostStartAdoptionLabel = vi.fn(
      async (label: { id: string }) => label.id,
    );

    await expect(
      withUpdateContender(
        {
          hostHomeDir,
          reason: contenderOptions.reason,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: contenderOptions.admission,
        },
        async (capability) =>
          installHostServiceWithAttempt(
            capability,
            contenderOptions,
            "desktop",
            { install, hostStartAdoptionLabel },
            serviceOptions,
          ),
      ),
    ).rejects.toBe(osError);

    expect(lease.waitForSpawn).not.toHaveBeenCalled();
    expect(lease.cancel).toHaveBeenCalledTimes(1);
  });

  it("still propagates the original committed-registration error when the honoured wait itself rejects", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const lease = {
      waitForSpawn: vi.fn(async () => {
        throw new Error("spawn wait transport failed");
      }),
      cancel: vi.fn(async () => undefined),
    };
    adoptionMock.publish.mockResolvedValue(lease);
    const committedError = cliError({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      message: "registered, but the lifecycle generation could not be written",
      details: {
        label: "ai.traycer.host",
        phase: "lifecycle",
        registrationCommitted: true,
      },
      exitCode: 1,
    });
    const install = vi.fn(async () => {
      await atServiceSpawnEdge();
      throw committedError;
    });
    const hostStartAdoptionLabel = vi.fn(
      async (label: { id: string }) => label.id,
    );

    await expect(
      withUpdateContender(
        {
          hostHomeDir,
          reason: contenderOptions.reason,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: contenderOptions.admission,
        },
        async (capability) =>
          installHostServiceWithAttempt(
            capability,
            contenderOptions,
            "desktop",
            { install, hostStartAdoptionLabel },
            serviceOptions,
          ),
      ),
    ).rejects.toBe(committedError);

    expect(lease.waitForSpawn).toHaveBeenCalledTimes(1);
    expect(lease.cancel).toHaveBeenCalledTimes(1);
  });

  it("reject a forged capability before invoking the service actuator", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const install = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const forged = { hostHomeDir } as UpdateMutationCapability;

    await expect(
      installHostServiceWithAttempt(
        forged,
        contenderOptions,
        "desktop",
        { install, hostStartAdoptionLabel: async (label) => label.id },
        serviceOptions,
      ),
    ).rejects.toMatchObject({ code: "E_CLI_LOCK_BUSY" });
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects released and lost capabilities before invoking the service actuator", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const install = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    let released: UpdateMutationCapability | null = null;
    const acquired = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      async (capability) => {
        released = capability;
        return "ok";
      },
    );
    expect(acquired).toEqual({ kind: "ran", result: "ok" });
    if (released === null) throw new Error("missing released capability");
    await expect(
      installHostServiceWithAttempt(
        released,
        contenderOptions,
        "desktop",
        { install, hostStartAdoptionLabel: async (label) => label.id },
        serviceOptions,
      ),
    ).rejects.toMatchObject({ code: "E_CLI_LOCK_BUSY" });
    expect(install).not.toHaveBeenCalled();

    const lostOutcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      async (capability) => {
        await unlink(updateAttemptLockPath(hostHomeDir));
        await expect(
          installHostServiceWithAttempt(
            capability,
            contenderOptions,
            "desktop",
            { install, hostStartAdoptionLabel: async (label) => label.id },
            serviceOptions,
          ),
        ).rejects.toMatchObject({ code: "E_CLI_LOCK_BUSY" });
        return "must-not-report-ran";
      },
    );
    expect(lostOutcome).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
    expect(install).not.toHaveBeenCalled();
  });

  it("passes a live verifier into the install lifecycle and stops before its raw actuator after loss", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    let rawActuatorRan = false;
    commitMock.invoke.mockImplementation(
      async (options: CommitHostInstallSourceOptions) => {
        await unlink(updateAttemptLockPath(hostHomeDir));
        await options.verifyMutationCapability?.();
        rawActuatorRan = true;
        throw new Error("raw actuator should not be reached");
      },
    );

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      async (capability) => {
        await expect(
          commitHostInstallSourceWithAttempt(
            capability,
            contenderOptions,
            "desktop",
            {
              environment: "production",
              staged: stagedSource,
              onProgress: () => undefined,
              lifecycle: null,
              onWillSwap: null,
              storeFormatFloor: ungatedStoreFormatFloorEvidence(
                "host update",
                false,
              ),
              onSwapCommitted: null,
            },
          ),
        ).rejects.toMatchObject({ code: "E_CLI_LOCK_BUSY" });
        return "must-not-report-ran";
      },
    );

    expect(rawActuatorRan).toBe(false);
    expect(outcome).toMatchObject({
      kind: "lock-not-live",
      verdict: { kind: "lost" },
    });
  });

  it("keeps an active attempt distinct from ordinary host-workload busy", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await mkdir(hostHomeDir, { recursive: true });
    await writeFile(
      updateAttemptRecordPath(hostHomeDir),
      `${JSON.stringify({
        schemaVersion: 2,
        attemptId: "active-attempt-1",
        generation: 1,
        sequence: 1,
        trigger: "manual",
        targetVersion: "2.0.0",
        phase: "applying",
        execution: "active",
        continuation: null,
        progress: null,
        startedAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        completedAt: null,
        error: null,
      })}\n`,
    );

    await expect(
      withCliUpdateExecutionSegment(
        {
          environment: "production",
          reason: "active-attempt-mapping-test",
          waitMs: 0,
          pollIntervalMs: 10,
          admission: "service-maintenance",
        },
        async () => "must-not-run",
      ),
    ).rejects.toMatchObject({
      code: "E_HOST_UPDATE_ATTEMPT_ACTIVE",
      details: {
        attemptId: "active-attempt-1",
        phase: "applying",
      },
    });
  });

  // The stop facade's disruption boundary. `host update` keys "have I begun
  // to disturb the host?" on `onAuthorityVerified`, so where the facade fires
  // it is load-bearing: BEFORE the capability check and a refused stop would
  // be stamped as a failed update over a live writer's marker; AFTER the
  // actuator and a stop that threw mid-flight would be read as untouched.
  // Every `host update` pin mocks this facade at the module boundary, so
  // these two are the only pins that see its body.
  it("the stop facade does not report the disruption boundary when its capability check refuses", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const stopForRestart = vi
      .fn<() => Promise<RestartStop>>()
      .mockResolvedValue({ forcedRecycle: false });
    const onAuthorityVerified = vi.fn<() => void>();
    const forged = { hostHomeDir } as UpdateMutationCapability;

    await expect(
      stopHostForRestartWithAttempt(
        forged,
        contenderOptions,
        { stopForRestart },
        serviceOptions.label,
        { force: false },
        onAuthorityVerified,
      ),
    ).rejects.toMatchObject({ code: "E_CLI_LOCK_BUSY" });
    expect(onAuthorityVerified).not.toHaveBeenCalled();
    expect(stopForRestart).not.toHaveBeenCalled();
  });

  it("the stop facade reports the disruption boundary once, after the capability check and before the actuator, even when the actuator then throws", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const order: string[] = [];
    const stopForRestart = vi
      .fn<() => Promise<RestartStop>>()
      .mockImplementation(async () => {
        order.push("actuator");
        throw new Error("stop failed");
      });
    const onAuthorityVerified = vi.fn<() => void>(() => {
      order.push("boundary");
    });

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      async (capability) => {
        await expect(
          stopHostForRestartWithAttempt(
            capability,
            contenderOptions,
            { stopForRestart },
            serviceOptions.label,
            { force: false },
            onAuthorityVerified,
          ),
        ).rejects.toThrow("stop failed");
        return "ran";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "ran" });
    expect(order).toEqual(["boundary", "actuator"]);
    expect(onAuthorityVerified).toHaveBeenCalledTimes(1);
    expect(stopForRestart).toHaveBeenCalledTimes(1);
  });

  // `refreshHostServiceDefinitionWithAttempt` (M1): the definition-only
  // refresh facade. Unlike `installHostServiceWithAttempt` there is no host
  // start adoption to publish or wait for - the mechanism under test is
  // simply "the refresher's `refresh` runs exactly once, under the
  // authority scope, with the label it was given".
  it("refreshHostServiceDefinitionWithAttempt: refresher.refresh is called exactly once, inside the mutation authority, with the given label", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const refreshResult: ServiceDefinitionRefresh = { kind: "current" };
    const refresh = vi.fn(async () => refreshResult);

    const outcome = await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      (capability) =>
        refreshHostServiceDefinitionWithAttempt(
          capability,
          contenderOptions,
          { refresh },
          serviceOptions.label,
        ),
    );

    expect(outcome).toEqual({ kind: "ran", result: refreshResult });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(serviceOptions.label);
  });

  it("refreshHostServiceDefinitionWithAttempt: a forged capability is rejected before the refresher ever runs", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const refresh = vi.fn(async (): Promise<ServiceDefinitionRefresh> => ({
      kind: "current",
    }));
    const forged = { hostHomeDir } as UpdateMutationCapability;

    await expect(
      refreshHostServiceDefinitionWithAttempt(
        forged,
        contenderOptions,
        { refresh },
        serviceOptions.label,
      ),
    ).rejects.toMatchObject({ code: "E_CLI_LOCK_BUSY" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("refreshHostServiceDefinitionWithAttempt: propagates the refresher's own rejection unchanged", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    const refreshFailure = new Error("could not rewrite the unit file");
    const refresh = vi.fn(async (): Promise<ServiceDefinitionRefresh> => {
      throw refreshFailure;
    });

    await expect(
      withUpdateContender(
        {
          hostHomeDir,
          reason: contenderOptions.reason,
          waitMs: 0,
          pollIntervalMs: 10,
          admission: contenderOptions.admission,
        },
        (capability) =>
          refreshHostServiceDefinitionWithAttempt(
            capability,
            contenderOptions,
            { refresh },
            serviceOptions.label,
          ),
      ),
    ).rejects.toBe(refreshFailure);
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("stopHostServiceWithAttempt busy gate", () => {
  const platforms = ["macOS", "Linux", "Windows"] as const;

  async function runInsideContender(
    run: (capability: UpdateMutationCapability) => Promise<unknown>,
  ): Promise<void> {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    await withUpdateContender(
      {
        hostHomeDir,
        reason: contenderOptions.reason,
        waitMs: 0,
        pollIntervalMs: 10,
        admission: contenderOptions.admission,
      },
      run,
    );
  }

  function controllerNamedFor(
    platform: (typeof platforms)[number],
    order: string[],
  ): Pick<ServiceController, "stop"> {
    return {
      stop: async () => {
        order.push(`${platform}:stop`);
      },
    };
  }

  it.each(platforms)(
    "%s: if-idle probes then stops, in that order, with the label's environment",
    async (platform) => {
      const order: string[] = [];
      busyMock.assertIdle.mockReset();
      busyMock.assertIdle.mockImplementation(async () => {
        order.push("probe");
      });
      const controller = controllerNamedFor(platform, order);
      await runInsideContender((capability) =>
        stopHostServiceWithAttempt(
          capability,
          contenderOptions,
          controller,
          serviceOptions.label,
          { force: false },
          "if-idle",
        ),
      );
      expect(order).toEqual(["probe", `${platform}:stop`]);
      expect(busyMock.assertIdle).toHaveBeenCalledWith(
        serviceOptions.label.environment,
      );
    },
  );

  it.each(platforms)(
    "%s: a busy host rejects E_HOST_BUSY and the controller is never stopped",
    async (platform) => {
      const order: string[] = [];
      busyMock.assertIdle.mockReset();
      busyMock.assertIdle.mockRejectedValue(
        cliError({
          code: CLI_ERROR_CODES.HOST_BUSY,
          message: "busy",
          details: null,
          exitCode: 1,
        }),
      );
      const controller = controllerNamedFor(platform, order);
      await runInsideContender(async (capability) => {
        await expect(
          stopHostServiceWithAttempt(
            capability,
            contenderOptions,
            controller,
            serviceOptions.label,
            { force: false },
            "if-idle",
          ),
        ).rejects.toMatchObject({ code: CLI_ERROR_CODES.HOST_BUSY });
      });
      expect(order).toEqual([]);
    },
  );

  it.each(platforms)("%s: unconditional never probes", async (platform) => {
    const order: string[] = [];
    busyMock.assertIdle.mockReset();
    const controller = controllerNamedFor(platform, order);
    await runInsideContender((capability) =>
      stopHostServiceWithAttempt(
        capability,
        contenderOptions,
        controller,
        serviceOptions.label,
        { force: false },
        "unconditional",
      ),
    );
    expect(order).toEqual([`${platform}:stop`]);
    expect(busyMock.assertIdle).not.toHaveBeenCalled();
  });

  it("the capability check comes before the probe", async () => {
    const hostHomeDir = await freshHome();
    homeRef.current = hostHomeDir;
    busyMock.assertIdle.mockReset();
    const forged = { hostHomeDir } as UpdateMutationCapability;
    await expect(
      stopHostServiceWithAttempt(
        forged,
        contenderOptions,
        { stop: async () => undefined },
        serviceOptions.label,
        { force: false },
        "if-idle",
      ),
    ).rejects.toBeDefined();
    expect(busyMock.assertIdle).not.toHaveBeenCalled();
  });
});
