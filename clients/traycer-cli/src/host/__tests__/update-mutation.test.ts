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
vi.mock("../host-start-adoption", () => ({
  publishHostStartAdoption: adoptionMock.publish,
}));

import {
  installHostServiceWithAttempt,
  commitHostInstallSourceWithAttempt,
} from "../update-mutation";
import { withCliUpdateExecutionSegment } from "../update-contender";
import type { InstallServiceOptions } from "../../service";
import type {
  CommitHostInstallSourceOptions,
  StagedHostInstallSource,
} from "../../installer/install";

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
  it("publishes the Desktop-owned agent label before the service actuator", async () => {
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
    const install = vi.fn(async () => {
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
    );
    expect(events).toEqual([
      "label",
      "publish:ai.traycer.host.agent",
      "install",
    ]);
    expect(lease.waitForSpawn).toHaveBeenCalledTimes(1);
    expect(lease.cancel).toHaveBeenCalledTimes(1);
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
    const install = vi.fn(async () => undefined);
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
          { install, hostStartAdoptionLabel },
          serviceOptions,
        );
        return "installed";
      },
    );

    expect(outcome).toEqual({ kind: "ran", result: "installed" });
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
          commitHostInstallSourceWithAttempt(capability, contenderOptions, {
            environment: "production",
            staged: stagedSource,
            onProgress: () => undefined,
            lifecycle: null,
          }),
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
});
