import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeInstallGeneration } from "@traycer-clients/shared/host-version/install-generation";

type Environment = "dev" | "production";

let sandboxRoot = "";

function hostHomeFor(environment: Environment): string {
  return join(sandboxRoot, "host", environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
}
function pidMetadataPathFor(environment: Environment): string {
  return join(hostHomeFor(environment), "pid.json");
}

vi.mock("../../store/paths", async () => {
  const actual =
    await vi.importActual<typeof import("../../store/paths")>(
      "../../store/paths",
    );
  return {
    ...actual,
    hostHomeDir: (environment: Environment) => hostHomeFor(environment),
    hostInstallDir: (environment: Environment) => installDirFor(environment),
    hostInstallRecordPath: (environment: Environment) =>
      join(installDirFor(environment), "install.json"),
    hostPidMetadataPath: (environment: Environment) =>
      pidMetadataPathFor(environment),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
  };
});

import { stampRuntime } from "../stamp-runtime";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";

const ENV: Environment = "production";

async function writeInstall(
  overrides: Partial<HostInstallRecord>,
): Promise<HostInstallRecord> {
  const installDir = installDirFor(ENV);
  mkdirSync(installDir, { recursive: true });
  const record: HostInstallRecord = {
    installId: "install-a",
    version: "2.0.0",
    runtimeVersion: null,
    platform: "darwin",
    arch: "arm64",
    installedAt: "2026-01-01T00:00:00.000Z",
    source: { kind: "registry", value: "2.0.0" },
    archiveSha256: "a".repeat(64),
    signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
    signatureKeyId: "test-key",
    sizeBytes: 1,
    executablePath: join(installDir, "traycer-host"),
    ...overrides,
  };
  await writeHostInstallRecord(ENV, record);
  return record;
}

interface PidFixture {
  readonly pid: number;
  readonly hostId: string;
  readonly version: string;
  readonly websocketUrl: string;
  readonly startedAt: string;
}

function writePid(overrides: Partial<PidFixture>): PidFixture {
  const pid: PidFixture = {
    pid: 4242,
    hostId: "host-a",
    version: "2.0.0",
    websocketUrl: "ws://127.0.0.1:9876/rpc",
    startedAt: "2026-01-01T00:05:00.000Z",
    ...overrides,
  };
  mkdirSync(hostHomeFor(ENV), { recursive: true });
  writeFileSync(pidMetadataPathFor(ENV), JSON.stringify(pid));
  return pid;
}

function generationFor(record: HostInstallRecord): string {
  return encodeInstallGeneration({
    installId: record.installId,
    installedAt: record.installedAt,
    archiveSha256: record.archiveSha256,
    version: record.version,
  });
}

describe("stampRuntime", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-stamp-runtime-test-"));
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("stamps runtimeVersion on a full match (null stamp + generation + live pid evidence)", async () => {
    const installed = await writeInstall({});
    const pid = writePid({});

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "stamped",
      runtimeVersion: pid.version,
      installGeneration: generationFor(installed),
    });
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.runtimeVersion).toBe(pid.version);
  });

  it("covers the legacy-tuple fingerprint path (no installId)", async () => {
    const installed = await writeInstall({ installId: null });
    const pid = writePid({});
    const expectedGeneration = generationFor(installed);
    expect(expectedGeneration.startsWith("legacy:")).toBe(true);

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: expectedGeneration,
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result.outcome).toBe("stamped");
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.runtimeVersion).toBe(pid.version);
  });

  it("superseded: no install record (uninstalled)", async () => {
    const pid = writePid({});
    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: "id:whatever",
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });
    expect(result).toEqual({
      outcome: "superseded",
      reason: "no-install-record",
    });
  });

  it("superseded: runtime already stamped (debt already resolved)", async () => {
    const installed = await writeInstall({ runtimeVersion: "2.0.0" });
    const pid = writePid({});

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "runtime-already-stamped",
    });
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.runtimeVersion).toBe("2.0.0");
  });

  it("superseded: generation mismatch when a different install now occupies the record - uninstall/reinstall between readiness and stamp, debt preserved on the NEW record", async () => {
    // Simulates the controller observing readiness of install A's fresh
    // process, then - before it calls stampRuntime - an
    // uninstall/reinstall lands (install B, also null-runtime, its own
    // independent debt).
    const installA = await writeInstall({ installId: "install-a" });
    const pid = writePid({});
    const expectedGenerationFromA = generationFor(installA);

    await writeInstall({
      installId: "install-b",
      version: "3.0.0",
      installedAt: "2026-01-02T00:00:00.000Z",
    });

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: expectedGenerationFromA,
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "generation-mismatch",
    });
    // Install B's own debt survives untouched - it was never stamped
    // with A's stale readiness observation.
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.installId).toBe("install-b");
    expect(stored?.runtimeVersion).toBeNull();
  });

  it("superseded: no live host (pid.json absent)", async () => {
    const installed = await writeInstall({});

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: 4242,
      observedStartedAt: "2026-01-01T00:05:00.000Z",
      observedRuntimeVersion: "2.0.0",
    });

    expect(result).toEqual({ outcome: "superseded", reason: "no-live-host" });
  });

  it("superseded: pid evidence mismatch on pid (a different process now occupies pid.json)", async () => {
    const installed = await writeInstall({});
    const pid = writePid({});

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: pid.pid + 1,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "pid-evidence-mismatch",
    });
  });

  it("superseded: pid evidence mismatch on startedAt (recycled-pid-shaped drift)", async () => {
    const installed = await writeInstall({});
    const pid = writePid({});

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: pid.pid,
      observedStartedAt: "2026-01-01T09:00:00.000Z",
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "pid-evidence-mismatch",
    });
  });

  it("superseded: pid evidence mismatch on runtime version", async () => {
    const installed = await writeInstall({});
    const pid = writePid({});

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: "9.9.9",
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "pid-evidence-mismatch",
    });
  });

  it("does not write install.json on any superseded outcome", async () => {
    const installed = await writeInstall({});
    writePid({ pid: 1 });

    await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: "id:not-the-real-generation",
      observedPid: 1,
      observedStartedAt: installed.installedAt,
      observedRuntimeVersion: "2.0.0",
    });

    const stored = await readHostInstallRecord(ENV);
    expect(stored?.runtimeVersion).toBeNull();
    expect(stored).toEqual(installed);
  });
});
