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
  const hostRoot = join(sandboxRoot, ".traycer", "host");
  return environment === "production" ? hostRoot : join(hostRoot, environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
}
function pidMetadataPathFor(environment: Environment): string {
  return join(hostHomeFor(environment), "pid.json");
}
function cliLockPathFor(environment: Environment): string {
  const cliRoot = join(sandboxRoot, ".traycer", "cli");
  const cliHome =
    environment === "production" ? cliRoot : join(cliRoot, environment);
  return join(cliHome, ".lock");
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
    cliLockPath: (environment: Environment) => cliLockPathFor(environment),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
  };
});

import {
  PROCESS_START_PUBLICATION_ALLOWANCE_MS,
  stampRuntime,
} from "../stamp-runtime";
import { buildHostInstallCommand } from "../../commands/host-install";
import { noopLogger } from "../../logger";
import {
  readHostInstallRecord,
  writeHostInstallRecord,
  type HostInstallRecord,
} from "../../manifest/host-install";
import {
  __setProcessStartTimeReaderForTest,
  readProcessStartTimeMs,
} from "../../store/process-identity";
import type { CommandContext, CommandResult } from "../../runner/runner";

// The worker invokes the source CLI, whose baked source environment is dev.
// Keep the parent on that same environment so both genuine command paths
// address the exact sandboxed install record.
const ENV: Environment = "dev";

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

function commandContext(): CommandContext {
  return {
    runtime: {
      json: true,
      quiet: true,
      noProgress: true,
      noBootstrap: true,
      nonInteractive: true,
      environment: ENV,
      logger: noopLogger,
    },
    output: {
      progress: () => {},
      human: () => {},
      humanRequired: () => {},
      emitResult: () => {},
      emitError: () => {},
    },
    progress: () => {},
  };
}

function installGenerationFromCommandResult(result: CommandResult): string {
  if (
    result.data === null ||
    typeof result.data !== "object" ||
    !("installGeneration" in result.data) ||
    typeof result.data.installGeneration !== "string"
  ) {
    throw new Error("host install command returned no install generation");
  }
  return result.data.installGeneration;
}

function writeLocalHostSource(path: string): void {
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "traycer-host"), "test host binary");
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

  it("superseded: a same-generation record stamped with a different runtime is not benign", async () => {
    const installed = await writeInstall({ runtimeVersion: "2.0.0" });
    const pid = writePid({ version: "2.1.0" });

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installed),
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "runtime-version-mismatch",
    });
    expect((await readHostInstallRecord(ENV))?.runtimeVersion).toBe("2.0.0");
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

  it("superseded: generation mismatch wins over an already-stamped replacement record", async () => {
    const installA = await writeInstall({ installId: "install-a" });
    const pid = writePid({});

    await writeInstall({
      installId: "install-b",
      version: "3.0.0",
      installedAt: "2026-01-02T00:00:00.000Z",
      runtimeVersion: "3.0.0",
    });

    const result = await stampRuntime({
      environment: ENV,
      expectedInstallGeneration: generationFor(installA),
      observedPid: pid.pid,
      observedStartedAt: pid.startedAt,
      observedRuntimeVersion: pid.version,
    });

    expect(result).toEqual({
      outcome: "superseded",
      reason: "generation-mismatch",
    });
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
      const proc = spawn("sleep", ["30"]);
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

    function wait(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
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

    it("stamps when pid.json is published more than five seconds after the process started", async () => {
      const installed = await writeInstall({});
      const live = await spawnLiveProcess();
      // A host may take a while to bind and publish readiness. This is the
      // timestamp domain pid.json owns, and deliberately differs from the
      // OS process-start value by more than the old 5s identity tolerance.
      await wait(6_000);
      const pid = writePid({
        pid: live.pid,
        startedAt: new Date().toISOString(),
      });

      const result = await stampRuntime({
        environment: ENV,
        expectedInstallGeneration: generationFor(installed),
        observedPid: pid.pid,
        observedStartedAt: pid.startedAt,
        observedRuntimeVersion: pid.version,
      });

      expect(result.outcome).toBe("stamped");
      expect((await readHostInstallRecord(ENV))?.runtimeVersion).toBe(
        pid.version,
      );
    }, 10_000);

    it("accepts a start exactly at the bounded publication allowance", async () => {
      expect(PROCESS_START_PUBLICATION_ALLOWANCE_MS).toBe(1_250);
      const installed = await writeInstall({});
      const live = await spawnLiveProcess();
      const pid = writePid({
        pid: live.pid,
        startedAt: new Date().toISOString(),
      });
      const publishedAtMs = Date.parse(pid.startedAt);
      const previousReader = __setProcessStartTimeReaderForTest(
        () => publishedAtMs + 1_250,
      );

      try {
        await expect(
          stampRuntime({
            environment: ENV,
            expectedInstallGeneration: generationFor(installed),
            observedPid: pid.pid,
            observedStartedAt: pid.startedAt,
            observedRuntimeVersion: pid.version,
          }),
        ).resolves.toMatchObject({ outcome: "stamped" });
      } finally {
        __setProcessStartTimeReaderForTest(previousReader);
      }

      expect((await readHostInstallRecord(ENV))?.runtimeVersion).toBe(
        pid.version,
      );
    });

    it("rejects a start one millisecond beyond the publication allowance", async () => {
      expect(PROCESS_START_PUBLICATION_ALLOWANCE_MS).toBe(1_250);
      const installed = await writeInstall({});
      const live = await spawnLiveProcess();
      const pid = writePid({
        pid: live.pid,
        startedAt: new Date().toISOString(),
      });
      const publishedAtMs = Date.parse(pid.startedAt);
      const previousReader = __setProcessStartTimeReaderForTest(
        () => publishedAtMs + 1_251,
      );

      try {
        await expect(
          stampRuntime({
            environment: ENV,
            expectedInstallGeneration: generationFor(installed),
            observedPid: pid.pid,
            observedStartedAt: pid.startedAt,
            observedRuntimeVersion: pid.version,
          }),
        ).resolves.toEqual({ outcome: "superseded", reason: "pid-not-live" });
      } finally {
        __setProcessStartTimeReaderForTest(previousReader);
      }

      expect((await readHostInstallRecord(ENV))?.runtimeVersion).toBeNull();
    });

    it("rejects a live PID against a stale publication timestamp across 400 real OS-start reads", async () => {
      const installed = await writeInstall({});
      const live = await spawnLiveProcess();
      await Array.from({ length: 400 }).reduce(
        async (previous): Promise<void> => {
          await previous;
          const processStartedAtMs = readProcessStartTimeMs(live.pid);
          if (processStartedAtMs === null) {
            throw new Error(
              "could not reread the spawned process's start time",
            );
          }
          const pid = writePid({
            pid: live.pid,
            // Five seconds beyond the allowance keeps this real-reader
            // regression far from ps's one-second rollover quantum; the
            // synthetic cases above exclusively own the exact boundary.
            startedAt: new Date(
              processStartedAtMs -
                PROCESS_START_PUBLICATION_ALLOWANCE_MS -
                5_000,
            ).toISOString(),
          });

          await expect(
            stampRuntime({
              environment: ENV,
              expectedInstallGeneration: generationFor(installed),
              observedPid: pid.pid,
              observedStartedAt: pid.startedAt,
              observedRuntimeVersion: pid.version,
            }),
          ).resolves.toEqual({
            outcome: "superseded",
            reason: "pid-not-live",
          });
        },
        Promise.resolve(),
      );

      expect((await readHostInstallRecord(ENV))?.runtimeVersion).toBeNull();
    }, 60_000);

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
// (`fixtures/stamp-runtime-terminal-install-worker.ts`) that invokes the
// real terminal `host install --no-service-register` command between the
// moment command A returns its attested generation and the stamp call. This
// proves the CAS consumes the command result, never a post-race disk reread.
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

    function spawnTerminalInstallWorker(
      sourcePath: string,
    ): ChildProcessWithoutNullStreams {
      return spawn("bun", ["run", workerScript], {
        env: {
          ...process.env,
          WORKER_CLI_ROOT: join(__dirname, "..", "..", ".."),
          WORKER_HOME: sandboxRoot,
          WORKER_SOURCE_PATH: sourcePath,
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
      // The controller's cycle: a real command A lands an install and
      // returns its generation. Capture that return value exactly as the
      // caller does; computing it from a fixture would not exercise the
      // attestation boundary this race protects.
      mkdirSync(join(sandboxRoot, ".traycer", "cli", ENV), {
        recursive: true,
      });
      const sourceA = join(sandboxRoot, "source-a");
      writeLocalHostSource(sourceA);
      const commandAResult = await buildHostInstallCommand({
        versionRequest: "latest",
        fromPath: sourceA,
        enableLinger: true,
        allowSelfInvocation: false,
        noServiceRegister: true,
        ifIdle: false,
      })(commandContext());
      const pid = writePid({});
      const recordA = await readHostInstallRecord(ENV);
      if (recordA === null) {
        throw new Error("command A did not write an install record");
      }
      const canonicalGenerationA = generationFor(recordA);
      // This independently checks the command's returned attestation before
      // B lands, but deliberately does not retain the result as stamp input.
      // The consumer below must read from commandAResult only after the race.
      expect(commandAResult.data).toMatchObject({
        installGeneration: canonicalGenerationA,
      });

      // Before the caller gets to call stampRuntime, a REAL separate
      // process performs a terminal bytes-only install - install B -
      // landing via actual cross-process filesystem writes.
      const sourceB = join(sandboxRoot, "source-b");
      writeLocalHostSource(sourceB);
      const worker = spawnTerminalInstallWorker(sourceB);
      const exitCode = await waitForExit(worker);
      expect(exitCode).toBe(0);
      const recordB = await readHostInstallRecord(ENV);
      if (recordB === null) {
        throw new Error("command B did not write an install record");
      }
      expect(generationFor(recordB)).not.toBe(canonicalGenerationA);

      // The caller calls stampRuntime with the generation it ATTESTED
      // from A's own command result only AFTER B landed - never a post-race
      // disk read substituted for the command's attested value.
      const expectedGenerationFromA =
        installGenerationFromCommandResult(commandAResult);
      expect(expectedGenerationFromA).toBe(canonicalGenerationA);
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
      expect(stored?.source).toEqual({ kind: "local-file", value: sourceB });
      expect(stored?.runtimeVersion).toBeNull();
    });
  },
);
