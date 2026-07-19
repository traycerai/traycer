import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
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

// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export this mock leaves un-overridden (falls through via
// `...actual` below) would otherwise resolve against the REAL production
// `~/.traycer`, not this sandbox. Redirect the `os` boundary itself so
// `vi.importActual`'s fresh module evaluation picks up the sandbox
// (falling back to the real tmpdir, never the real home, before the first
// `beforeEach` has set it). `vi.mock` factories are hoisted above this
// file's own top-level `let sandboxRoot` - a direct reference hits a TDZ
// `ReferenceError`, so the live value has to live in `vi.hoisted` instead.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

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
import { readProcessStartTimeMs } from "../../store/process-identity";

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
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    rmSync(sandboxRoot, { recursive: true, force: true });
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

// Finding 3 (ticket-2 review round 1): the static pid.json comparison
// above proves pid.json wasn't rewritten out from under the caller, but
// says nothing about whether that pid is actually alive - a crashed host
// that left pid.json behind would satisfy every check with a fabricated
// pid (the pre-fix `writePid({})` default of 4242 is never a real
// process). These tests spawn a REAL process so the new liveness probe
// has genuine positive evidence to find - `sleep` has no Windows
// equivalent fixture, matching `store/__tests__/process-identity.test.ts`'s
// own convention of skipping this exact scenario there.
describe.skipIf(process.platform === "win32")(
  "stampRuntime - live pid probe (Finding 3)",
  () => {
    let child: ChildProcessWithoutNullStreams | null = null;

    beforeEach(() => {
      sandboxRoot = mkdtempSync(
        join(tmpdir(), "traycer-stamp-runtime-live-test-"),
      );
      osHome.current = sandboxRoot;
    });

    afterEach(() => {
      child?.kill();
      child = null;
      rmSync(sandboxRoot, { recursive: true, force: true });
    });

    async function spawnLiveProcess(): Promise<{
      readonly pid: number;
      readonly startedAt: string;
    }> {
      const proc = spawn("sleep", ["5"]);
      child = proc;
      const pid = await new Promise<number>((resolve, reject) => {
        proc.once("spawn", () => {
          if (proc.pid === undefined) {
            reject(new Error("spawned sleep process has no pid"));
            return;
          }
          resolve(proc.pid);
        });
        proc.once("error", reject);
      });
      const startedAtMs = readProcessStartTimeMs(pid);
      if (startedAtMs === null) {
        throw new Error("could not read the spawned process's start time");
      }
      return { pid, startedAt: new Date(startedAtMs).toISOString() };
    }

    it("stamps runtimeVersion on a full match (null stamp + generation + live pid evidence)", async () => {
      const installed = await writeInstall({});
      const live = await spawnLiveProcess();
      const pid = writePid({ pid: live.pid, startedAt: live.startedAt });

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
      const live = await spawnLiveProcess();
      const pid = writePid({ pid: live.pid, startedAt: live.startedAt });
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

    it("superseded: pid-not-live when pid.json matches statically but the process has exited (crashed host, stale pid.json)", async () => {
      // The exact miss Finding 3 closes: every static check (generation,
      // pid, startedAt, version) passes because pid.json was never
      // cleaned up after the crash - only a genuine liveness probe can
      // tell this apart from a real live host.
      const installed = await writeInstall({});
      const live = await spawnLiveProcess();
      const pid = writePid({ pid: live.pid, startedAt: live.startedAt });
      const exited = new Promise<void>((resolve) => {
        child?.once("exit", () => resolve());
      });
      child?.kill();
      await exited;

      const result = await stampRuntime({
        environment: ENV,
        expectedInstallGeneration: generationFor(installed),
        observedPid: pid.pid,
        observedStartedAt: pid.startedAt,
        observedRuntimeVersion: pid.version,
      });

      expect(result).toEqual({ outcome: "superseded", reason: "pid-not-live" });
      const stored = await readHostInstallRecord(ENV);
      expect(stored?.runtimeVersion).toBeNull();
    });
  },
);

// Finding 5 (ticket-2 review round 1): the in-process "generation
// mismatch" test above proves the CAS logic itself is correct, but two
// sequential in-process writes can't reveal anything a single-threaded
// test couldn't already guarantee by ordering its own calls - it's not a
// genuine race. This spawns a REAL separate OS process
// (`fixtures/stamp-runtime-terminal-install-worker.ts`) that performs a
// terminal install through the exact production write path
// (`writeHostInstallRecordAt`, the same one `installer/install.ts`'s
// commit uses) between the moment a caller's command would have attested
// install A's generation and the moment it calls `stampRuntime` - proving
// the CAS uses the ATTESTED generation captured before the race window,
// never a post-race disk re-read, and that install B's own debt survives
// untouched. `bun run` matches `store/__tests__/fixtures/cli-lock-
// worker.ts`'s own two-process convention.
describe.skipIf(process.platform === "win32")(
  "stampRuntime - genuine two-process attested-generation CAS race (Finding 5)",
  () => {
    beforeEach(() => {
      sandboxRoot = mkdtempSync(
        join(tmpdir(), "traycer-stamp-runtime-cas-race-test-"),
      );
      osHome.current = sandboxRoot;
    });

    afterEach(() => {
      rmSync(sandboxRoot, { recursive: true, force: true });
    });

    const workerScript = join(
      __dirname,
      "fixtures",
      "stamp-runtime-terminal-install-worker.ts",
    );

    function spawnTerminalInstallWorker(overrides: {
      readonly installId: string;
      readonly version: string;
      readonly installedAt: string;
    }): ChildProcessWithoutNullStreams {
      return spawn("bun", ["run", workerScript], {
        env: {
          ...process.env,
          WORKER_INSTALL_DIR: installDirFor(ENV),
          WORKER_INSTALL_ID: overrides.installId,
          WORKER_VERSION: overrides.version,
          WORKER_INSTALLED_AT: overrides.installedAt,
        },
      });
    }

    function waitForExit(
      child: ChildProcessWithoutNullStreams,
    ): Promise<number | null> {
      return new Promise((resolve) => {
        child.once("exit", (code) => resolve(code));
      });
    }

    it("a real terminal install landing in a separate OS process between the attested generation and the stamp call is superseded, never stamped onto the interloper's record", async () => {
      // The controller's cycle: install A lands, its command attests A's
      // generation and returns it to the caller - captured here exactly
      // as the caller would hold onto it.
      const installA = await writeInstall({ installId: "install-a" });
      const pid = writePid({});
      const expectedGenerationFromA = generationFor(installA);

      // Before the caller gets to call stampRuntime, a REAL separate
      // process performs a terminal bytes-only install - install B -
      // landing via actual cross-process filesystem writes.
      const worker = spawnTerminalInstallWorker({
        installId: "install-b",
        version: "3.0.0",
        installedAt: "2026-01-02T00:00:00.000Z",
      });
      const exitCode = await waitForExit(worker);
      expect(exitCode).toBe(0);

      // The caller calls stampRuntime with the generation it ATTESTED
      // from A's own command result - never re-reading the disk after
      // the race window.
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
      // Install B's own debt survives untouched - A's stale readiness
      // observation was never stamped onto it.
      const stored = await readHostInstallRecord(ENV);
      expect(stored?.installId).toBe("install-b");
      expect(stored?.runtimeVersion).toBeNull();
    });
  },
);
