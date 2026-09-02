import { spawn, spawnSync } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmod,
  lstat as lstatFile,
  mkdir,
  readFile,
  rename as renameFile,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readdir } from "node:fs/promises";
import {
  CLI_INVOCATION_RECORD_MAX_ARGS,
  CLI_INVOCATION_RECORD_MAX_ARG_LENGTH,
  CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX,
  CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX,
  CLI_INVOCATION_TXN_ABANDON_AFTER_MS,
  cliInvocationLifecyclePath,
  cliInvocationRecordPath,
  cliInvocationStateDir,
  cliInvocationRecordOwnedTransactionPath,
  cliInvocationRecordStaleMarkerPath,
  cliInvocationRecordStagingPath,
  cliInvocationRecordTransactionMarkerPath,
  type CliInvocationLifecycle,
  isCliInvocationTransactionMarkerBasename,
  parseCliInvocationLifecycle,
  parseCliInvocationRecord,
  parseCliInvocationStaleMarker,
  parseCliInvocationTransactionMarker,
  serializeCliInvocationStaleMarker,
  serializeCliInvocationTransactionMarker,
} from "@traycer/protocol/config/cli-invocation-record";
import { CLI_ERROR_CODES } from "../../runner/errors";
import { currentProcessIdentityToken } from "../../store/process-identity";

beforeAll(() => {
  const result = spawnSync("bun", ["--version"]);
  if (result.error || result.status !== 0) {
    throw new Error(
      "these tests spawn worker fixtures with Bun; install Bun 1.3.12 (repo toolchain)",
    );
  }
});

const mocks = vi.hoisted(() => ({
  crashOnNextRename: false,
  crashOnLifecycleRename: false,
  failNextWrite: false,
  failLifecycleTempWrite: false,
  // 1-indexed call number of writeFile to fail (txn=1, staging=2,
  // stale-marker=3 on the commit-failure path). 0 means "use failNextWrite".
  // txn=1: the unique transaction contender write in `createUniqueContender`,
  // which happens before the staging write (staging=2) in
  // `runServiceRegistrationWithInvocationRecord`.
  failWriteCallNumber: 0,
  writeFileCallCount: 0,
  // Fails the NEXT `rm` call whose target path equals `failRmPath` (or, when
  // `failRmPath` is null, any `rm` call at all) with an EACCES-shaped error.
  // Used to simulate the live-record removal in
  // `runServiceUninstallWithInvocationRecord` failing after a confirmed OS
  // uninstall.
  failNextRm: false,
  failRmPath: null as string | null,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      mocks.writeFileCallCount += 1;
      const target = String(args[0]);
      const shouldFail =
        mocks.failNextWrite ||
        mocks.writeFileCallCount === mocks.failWriteCallNumber ||
        (mocks.failLifecycleTempWrite &&
          target.includes(".lifecycle.") &&
          target.endsWith(".tmp"));
      if (shouldFail) {
        mocks.failNextWrite = false;
        mocks.failLifecycleTempWrite = false;
        throw Object.assign(new Error("SIMULATED_WRITE_FAILURE"), {
          code: "EACCES",
        });
      }
      return actual.writeFile(...args);
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const target = String(args[0]);
      const originalWrite = handle.writeFile.bind(handle);
      handle.writeFile = (async (data, options) => {
        mocks.writeFileCallCount += 1;
        const shouldFail =
          mocks.failNextWrite ||
          mocks.writeFileCallCount === mocks.failWriteCallNumber ||
          (mocks.failLifecycleTempWrite &&
            target.includes(".lifecycle.") &&
            target.endsWith(".tmp"));
        if (shouldFail) {
          mocks.failNextWrite = false;
          mocks.failLifecycleTempWrite = false;
          throw Object.assign(new Error("SIMULATED_WRITE_FAILURE"), {
            code: "EACCES",
          });
        }
        return originalWrite(data, options);
      }) as typeof handle.writeFile;
      return handle;
    },
    rename: async (
      from: Parameters<typeof actual.rename>[0],
      to: Parameters<typeof actual.rename>[1],
    ) => {
      if (mocks.crashOnNextRename) {
        mocks.crashOnNextRename = false;
        throw Object.assign(new Error("SIMULATED_COMMIT_FAILURE"), {
          code: "EPERM",
        });
      }
      if (
        mocks.crashOnLifecycleRename &&
        String(to).endsWith("cli-invocation.lifecycle")
      ) {
        mocks.crashOnLifecycleRename = false;
        throw Object.assign(new Error("SIMULATED_LIFECYCLE_RENAME_FAILURE"), {
          code: "EPERM",
        });
      }
      return actual.rename(from, to);
    },
    rm: async (...args: Parameters<typeof actual.rm>) => {
      const target = String(args[0]);
      const shouldFail =
        mocks.failNextRm ||
        (mocks.failRmPath !== null && target === mocks.failRmPath);
      if (shouldFail) {
        mocks.failNextRm = false;
        mocks.failRmPath = null;
        throw Object.assign(new Error("SIMULATED_RM_FAILURE"), {
          code: "EACCES",
        });
      }
      return actual.rm(...args);
    },
  };
});

vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

const {
  runServiceRegistrationWithInvocationRecord,
  runServiceUninstallWithInvocationRecord,
  __setCliInvocationStateDirPauseAfterGateForTest,
  __setCliInvocationStateDirPauseBeforeWriteForTest,
  __setCliInvocationPauseAfterExclusiveCreateForTest,
} = await import("../cli-invocation-record");

const LABEL = "ai.traycer.host";
const WORKER_SCRIPT = join(__dirname, "fixtures", "cli-invocation-worker.ts");

let hostHome = "";
let scriptPath = "";
// A regular, executable, non-node-family file: usable as `command` in tests
// that need to exercise argument validation without also tripping the
// npm-shape "leading arg must be absolute" rule (that rule only applies to
// a `node`/`bun` command basename).
let standaloneCliPath = "";

beforeEach(async () => {
  hostHome = await mkdtemp(join(tmpdir(), "traycer-cli-invocation-"));
  scriptPath = join(hostHome, "traycer.js");
  await writeFile(scriptPath, "console.log('ok')\n", { mode: 0o644 });
  standaloneCliPath = join(hostHome, "traycer-standalone");
  await writeFile(standaloneCliPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
  if (process.platform !== "win32") {
    await chmod(standaloneCliPath, 0o755);
  }
  await mkdir(cliInvocationStateDir(hostHome), {
    recursive: true,
    mode: 0o700,
  });
  if (process.platform !== "win32") {
    await chmod(cliInvocationStateDir(hostHome), 0o700);
  }
  mocks.crashOnNextRename = false;
  mocks.crashOnLifecycleRename = false;
  mocks.failNextWrite = false;
  mocks.failLifecycleTempWrite = false;
  mocks.failWriteCallNumber = 0;
  mocks.writeFileCallCount = 0;
  mocks.failNextRm = false;
  mocks.failRmPath = null;
});

afterEach(async () => {
  __setCliInvocationStateDirPauseAfterGateForTest(null);
  __setCliInvocationStateDirPauseBeforeWriteForTest(null);
  __setCliInvocationPauseAfterExclusiveCreateForTest(null);
  await rm(hostHome, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function transactionMarkerNames(): Promise<string[]> {
  try {
    return (await readdir(cliInvocationStateDir(hostHome)))
      .filter(isCliInvocationTransactionMarkerBasename)
      .sort();
  } catch {
    return [];
  }
}

async function readSoleTransactionMarker(): Promise<{
  readonly name: string;
  readonly raw: string;
}> {
  const names = await transactionMarkerNames();
  expect(names).toHaveLength(1);
  const name = names[0];
  if (name === undefined) {
    throw new Error("expected one transaction marker");
  }
  return {
    name,
    raw: await readFile(join(cliInvocationStateDir(hostHome), name), "utf8"),
  };
}

function npmCli(): {
  readonly command: string;
  readonly args: readonly string[];
} {
  return { command: process.execPath, args: [scriptPath] };
}

interface WorkerOptions {
  readonly operation: "install" | "uninstall";
  readonly enteredPath: string;
  readonly resultPath: string;
  readonly releasePath?: string;
  readonly waitMs: number;
  readonly command?: string;
  readonly argument?: string;
  readonly pauseReadyPath?: string;
  readonly pauseReleasePath?: string;
}

function spawnWorker(options: WorkerOptions): ChildProcessWithoutNullStreams {
  return spawn("bun", ["run", WORKER_SCRIPT], {
    env: {
      ...process.env,
      WORKER_HOST_HOME: hostHome,
      WORKER_OPERATION: options.operation,
      WORKER_SERVICE_LABEL: LABEL,
      WORKER_COMMAND: options.command ?? "",
      WORKER_ARGUMENT: options.argument ?? "",
      WORKER_ENTERED_PATH: options.enteredPath,
      WORKER_RELEASE_PATH: options.releasePath ?? "",
      WORKER_RESULT_PATH: options.resultPath,
      WORKER_WAIT_MS: String(options.waitMs),
      WORKER_POLL_MS: "20",
      TRAYCER_CLI_INVOCATION_TXN_TEST_READY: options.pauseReadyPath ?? "",
      TRAYCER_CLI_INVOCATION_TXN_TEST_RELEASE: options.pauseReleasePath ?? "",
    },
  });
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await exists(path)) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<number | null> {
  return new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
}

async function readWorkerResult(path: string): Promise<string> {
  await waitForFile(path);
  return readFile(path, "utf8");
}

describe("runServiceRegistrationWithInvocationRecord", () => {
  it("writes the exact npm interpreter-plus-script vector only after OS success", async () => {
    let osMutated = false;
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => {
        osMutated = true;
        const sole = await readSoleTransactionMarker();
        const marker = parseCliInvocationTransactionMarker(
          JSON.parse(sole.raw),
        );
        expect(marker?.operation).toBe("install");
        expect(
          await exists(
            join(cliInvocationStateDir(hostHome), marker?.stagingFile ?? ""),
          ),
        ).toBe(true);
        expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(
          false,
        );
        expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
      },
    });
    expect(osMutated).toBe(true);
    const live = parseCliInvocationRecord(
      JSON.parse(await readFile(cliInvocationRecordPath(hostHome), "utf8")),
    );
    expect(live?.command).toBe(process.execPath);
    expect(live?.args).toEqual([scriptPath]);
    expect(live?.source).toEqual({
      kind: "service-registration",
      platform:
        process.platform === "darwin"
          ? "macos"
          : process.platform === "win32"
            ? "windows"
            : "linux",
      serviceLabel: LABEL,
    });
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
    expect(
      (await readdir(cliInvocationStateDir(hostHome))).filter((name) =>
        name.startsWith(CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX),
      ),
    ).toEqual([]);
    expect(await transactionMarkerNames()).toEqual([]);
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      false,
    );
    if (process.platform !== "win32") {
      expect((await stat(cliInvocationRecordPath(hostHome))).mode & 0o777).toBe(
        0o600,
      );
    }
  });

  it("does not mutate the OS when staging fails, and leaves no sidecars", async () => {
    mocks.failNextWrite = true;
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(osMutated).toBe(false);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
    expect(await transactionMarkerNames()).toEqual([]);
  });

  it("on OS throw, marks stale, removes a matching-label prior live record, and releases the txn", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          throw new Error("os-refused");
        },
      }),
    ).rejects.toThrow("os-refused");
    // The controllers do not roll back, so the prior live record - matching
    // this label - may now describe a registration that no longer exists. It
    // is removed, and a stale marker carrying our label sends the host to the
    // OS definition instead.
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe(LABEL);
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
    expect(await transactionMarkerNames()).toEqual([]);
  });

  it("on OS throw, retains a prior live record for a DIFFERENT label while still writing the stale marker", async () => {
    const foreign = {
      schemaVersion: 1,
      command: process.execPath,
      args: [scriptPath],
      source: {
        kind: "service-registration",
        platform: "linux",
        serviceLabel: "ai.traycer.host.dev.other",
      },
      recoveredAt: "2026-09-01T00:00:00.000Z",
    };
    await writeFile(
      cliInvocationRecordPath(hostHome),
      `${JSON.stringify(foreign, null, 2)}\n`,
      { mode: 0o600 },
    );
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          throw new Error("os-refused");
        },
      }),
    ).rejects.toThrow("os-refused");
    const live = parseCliInvocationRecord(
      JSON.parse(await readFile(cliInvocationRecordPath(hostHome), "utf8")),
    );
    expect(live?.source.serviceLabel).toBe("ai.traycer.host.dev.other");
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe(LABEL);
    expect(await transactionMarkerNames()).toEqual([]);
  });

  it("on commit failure after OS success, marks stale, unprefers live, and drops txn", async () => {
    await writeFile(
      cliInvocationRecordPath(hostHome),
      JSON.stringify({
        schemaVersion: 1,
        command: process.execPath,
        args: [scriptPath],
        source: {
          kind: "legacy-os-service",
          platform: "macos",
          serviceLabel: LABEL,
        },
        recoveredAt: "2026-01-01T00:00:00.000Z",
      }),
      { mode: 0o600 },
    );
    mocks.crashOnNextRename = true;
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(osMutated).toBe(true);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      true,
    );
    expect(await transactionMarkerNames()).toEqual([]);
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
  });

  it("allows a later successful install to replace and clear a stale marker", async () => {
    mocks.crashOnNextRename = true;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      true,
    );
    expect(await transactionMarkerNames()).toEqual([]);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);

    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      false,
    );
  });

  it("does not mutate the OS when the transaction marker write fails, and leaves no sidecars", async () => {
    mocks.failWriteCallNumber = 2; // txn acquired, unique staging write fails
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(osMutated).toBe(false);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
    expect(await transactionMarkerNames()).toEqual([]);
  });

  it("retains the transaction marker when both the commit and the stale-marker write fail", async () => {
    mocks.crashOnNextRename = true;
    mocks.failWriteCallNumber = 3; // txn(1) + staging(2) succeed, stale-marker(3) fails
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(osMutated).toBe(true);
    // Stale write failed, so the txn marker is deliberately kept: the host
    // must not persist a recovery while either marker exists, and this is
    // the only remaining signal that the live record predates the OS change.
    expect(await transactionMarkerNames()).toHaveLength(1);
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      false,
    );
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
  });

  it("isolates slotted-dev writes to the supplied host home", async () => {
    const otherHome = await mkdtemp(
      join(tmpdir(), "traycer-cli-invocation-slot-"),
    );
    try {
      await runServiceRegistrationWithInvocationRecord({
        environment: "dev",
        hostHomeDir: otherHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: "ai.traycer.host.dev.my-slot",
        cli: npmCli(),
        register: async () => undefined,
      });
      expect(await exists(cliInvocationRecordPath(otherHome))).toBe(true);
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    } finally {
      await rm(otherHome, { recursive: true, force: true });
    }
  });

  it("does not let a second install steal the first transaction or mutate OS while the first holds it", async () => {
    let unblock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let firstInOs = false;
    const first = runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => {
        firstInOs = true;
        await held;
      },
    });
    while (!firstInOs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    const firstTxn = (await readSoleTransactionMarker()).raw;
    let secondMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 0,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          secondMutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(secondMutated).toBe(false);
    expect((await readSoleTransactionMarker()).raw).toBe(firstTxn);
    unblock();
    await first;
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await transactionMarkerNames()).toEqual([]);
  });

  it("does not let a concurrent uninstall delete an in-flight install's markers", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    let unblock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let secondInOs = false;
    const second = runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => {
        secondInOs = true;
        await held;
      },
    });
    while (!secondInOs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    let uninstalled = false;
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 0,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          uninstalled = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED });
    expect(uninstalled).toBe(false);
    expect(await transactionMarkerNames()).toHaveLength(1);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    unblock();
    await second;
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
  });

  it("reclaims a transaction whose owner pid is positively gone", async () => {
    const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const exactPath = cliInvocationRecordTransactionMarkerPath(hostHome);
    const exactRaw = serializeCliInvocationTransactionMarker({
      schemaVersion: 1,
      kind: "transaction",
      owner: {
        pid: 2147483646,
        token,
        processStartIdentity: null,
        startedAtMs: 1,
      },
      stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${token}`,
      operation: "install",
      serviceLabel: LABEL,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    await writeFile(exactPath, exactRaw, { mode: 0o600 });
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
    expect(await transactionMarkerNames()).toEqual(["cli-invocation.txn"]);
  });

  it("removes an earlier stale marker carrying our own label on a successful registration", async () => {
    await writeFile(
      cliInvocationRecordStaleMarkerPath(hostHome),
      serializeCliInvocationStaleMarker({ serviceLabel: LABEL }),
      { mode: 0o600 },
    );
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      false,
    );
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
  });

  it("removes a legacy (label-less) stale marker on a successful registration", async () => {
    await writeFile(
      cliInvocationRecordStaleMarkerPath(hostHome),
      '{"schemaVersion":1,"kind":"stale"}\n',
      { mode: 0o600 },
    );
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      false,
    );
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
  });

  it("commits the record but reports failure when a foreign-label stale marker survives the strict clear", async () => {
    await writeFile(
      cliInvocationRecordStaleMarkerPath(hostHome),
      serializeCliInvocationStaleMarker({
        serviceLabel: "ai.traycer.host.dev.other",
      }),
      { mode: 0o600 },
    );
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      details: { phase: "stale-clear", outcome: "foreign" },
    });
    // The OS registration and record commit still happened; only the
    // strict foreign-marker clear failed.
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await exists(cliInvocationLifecyclePath(hostHome))).toBe(true);
    expect(await transactionMarkerNames()).toEqual([]);
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe("ai.traycer.host.dev.other");
  });

  it("succeeds when a symlink occupies the stale-marker path (skip-not-live, absent not foreign)", async () => {
    // The stale marker is read O_NOFOLLOW; a symlink there reads as absent,
    // not foreign or failed, so a successful registration is not blocked by
    // it and the planted link is left untouched.
    if (process.platform === "win32") return;
    const sentinel = join(hostHome, "stale-sentinel");
    await writeFile(sentinel, "sentinel\n", { mode: 0o600 });
    await symlink(sentinel, cliInvocationRecordStaleMarkerPath(hostHome));
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).resolves.toBeUndefined();
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    const linkStat = await lstatFile(
      cliInvocationRecordStaleMarkerPath(hostHome),
    );
    expect(linkStat.isSymbolicLink()).toBe(true);
    expect(await readFile(sentinel, "utf8")).toBe("sentinel\n");
  });
});

describe("runServiceUninstallWithInvocationRecord", () => {
  it("removes the live record only after confirmed uninstall", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    let uninstalled = false;
    await runServiceUninstallWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      uninstall: async () => {
        uninstalled = true;
        expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
      },
    });
    expect(uninstalled).toBe(true);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
    expect(await transactionMarkerNames()).toEqual([]);
    expect(await exists(cliInvocationRecordStaleMarkerPath(hostHome))).toBe(
      false,
    );
  });

  it("retains the live record when uninstall throws", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          throw new Error("indeterminate");
        },
      }),
    ).rejects.toThrow("indeterminate");
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
  });

  it("retains a live record whose serviceLabel does not match", async () => {
    await mkdir(hostHome, { recursive: true });
    const foreign = {
      schemaVersion: 1,
      command: process.execPath,
      args: [scriptPath],
      source: {
        kind: "service-registration",
        platform: "linux",
        serviceLabel: "ai.traycer.host.dev.other",
      },
      recoveredAt: "2026-09-01T00:00:00.000Z",
    };
    await writeFile(
      cliInvocationRecordPath(hostHome),
      `${JSON.stringify(foreign, null, 2)}\n`,
      { mode: 0o600 },
    );
    await runServiceUninstallWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      uninstall: async () => undefined,
    });
    const live = parseCliInvocationRecord(
      JSON.parse(await readFile(cliInvocationRecordPath(hostHome), "utf8")),
    );
    expect(live?.source.serviceLabel).toBe("ai.traycer.host.dev.other");
  });

  it("no-ops cleanly when there was never a live record (fresh uninstall)", async () => {
    let uninstalled = false;
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          uninstalled = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(uninstalled).toBe(true);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
  });

  it("isolates slotted-dev uninstall removal to the supplied host home", async () => {
    const otherHome = await mkdtemp(
      join(tmpdir(), "traycer-cli-invocation-slot-"),
    );
    try {
      await runServiceRegistrationWithInvocationRecord({
        environment: "dev",
        hostHomeDir: otherHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: "ai.traycer.host.dev.my-slot",
        cli: npmCli(),
        register: async () => undefined,
      });
      await runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      });
      await runServiceUninstallWithInvocationRecord({
        environment: "dev",
        hostHomeDir: otherHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: "ai.traycer.host.dev.my-slot",
        uninstall: async () => undefined,
      });
      expect(await exists(cliInvocationRecordPath(otherHome))).toBe(false);
      // The unrelated production home's live record is untouched.
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    } finally {
      await rm(otherHome, { recursive: true, force: true });
    }
  });

  it("marks stale and reports failure when the live record cannot be removed after a confirmed OS uninstall", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    mocks.failRmPath = cliInvocationRecordPath(hostHome);
    let uninstalled = false;
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          uninstalled = true;
        },
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
      details: { phase: "record-remove" },
    });
    expect(uninstalled).toBe(true);
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe(LABEL);
  });

  it("leaves a foreign-label stale marker in place but still succeeds (best-effort clear)", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    // Written AFTER the registration so it is not this test's registration
    // that has to clear it; uninstall's clear is best-effort, unlike
    // registration's strict clear.
    await writeFile(
      cliInvocationRecordStaleMarkerPath(hostHome),
      serializeCliInvocationStaleMarker({
        serviceLabel: "ai.traycer.host.dev.other",
      }),
      { mode: 0o600 },
    );
    let uninstalled = false;
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          uninstalled = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(uninstalled).toBe(true);
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe("ai.traycer.host.dev.other");
  });

  it("leaves an unparseable live record untouched and still succeeds", async () => {
    await mkdir(cliInvocationStateDir(hostHome), { recursive: true });
    await writeFile(cliInvocationRecordPath(hostHome), "not-json-garbage\n", {
      mode: 0o600,
    });
    let uninstalled = false;
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          uninstalled = true;
        },
      }),
    ).resolves.toBeUndefined();
    expect(uninstalled).toBe(true);
    expect(await readFile(cliInvocationRecordPath(hostHome), "utf8")).toBe(
      "not-json-garbage\n",
    );
  });
});

async function readLifecycle(): Promise<CliInvocationLifecycle | null> {
  return parseCliInvocationLifecycle(
    JSON.parse(await readFile(cliInvocationLifecyclePath(hostHome), "utf8")),
  );
}

describe("lifecycle generation", () => {
  it("writes a unique generation before releasing the txn on register and uninstall", async () => {
    let generationDuringOs: string | null = null;
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => {
        expect(await transactionMarkerNames()).toHaveLength(1);
        generationDuringOs = (await exists(
          cliInvocationLifecyclePath(hostHome),
        ))
          ? ((await readLifecycle())?.generation ?? null)
          : null;
      },
    });
    expect(await transactionMarkerNames()).toEqual([]);
    const afterRegister = await readLifecycle();
    expect(afterRegister?.event).toBe("registered");
    expect(afterRegister?.serviceLabel).toBe(LABEL);
    expect(afterRegister?.generation).not.toBe(generationDuringOs);

    await runServiceUninstallWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      uninstall: async () => undefined,
    });
    const afterUninstall = await readLifecycle();
    expect(afterUninstall?.event).toBe("uninstalled");
    expect(afterUninstall?.generation).not.toBe(afterRegister?.generation);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    expect(await transactionMarkerNames()).toEqual([]);
  });

  it("does not rewrite generation when uninstall throws or the live record is foreign", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    const registered = await readLifecycle();
    await expect(
      runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => {
          throw new Error("indeterminate");
        },
      }),
    ).rejects.toThrow("indeterminate");
    expect((await readLifecycle())?.generation).toBe(registered?.generation);

    await writeFile(
      cliInvocationRecordPath(hostHome),
      `${JSON.stringify({
        schemaVersion: 1,
        command: process.execPath,
        args: [scriptPath],
        source: {
          kind: "service-registration",
          platform: "linux",
          serviceLabel: "ai.traycer.host.dev.other",
        },
        recoveredAt: "2026-09-01T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    await runServiceUninstallWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      uninstall: async () => undefined,
    });
    expect((await readLifecycle())?.generation).toBe(registered?.generation);
    expect((await readLifecycle())?.event).toBe("registered");
  });

  it("does not let a contended install rewrite the generation", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    const registered = await readLifecycle();
    let unblock: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    let inOs = false;
    const first = runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => {
        inOs = true;
        await held;
      },
    });
    while (!inOs) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 0,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect((await readLifecycle())?.generation).toBe(registered?.generation);
    unblock();
    await first;
    expect((await readLifecycle())?.generation).not.toBe(
      registered?.generation,
    );
    expect((await readLifecycle())?.event).toBe("registered");
  });

  async function leftoverLifecycleTemps(): Promise<string[]> {
    return (await readdir(cliInvocationStateDir(hostHome))).filter(
      (name) =>
        name.startsWith("cli-invocation.lifecycle.") && name.endsWith(".tmp"),
    );
  }

  it("marks stale, keeps the just-committed live record, and releases the txn when the lifecycle temp write fails", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    const prior = await readLifecycle();
    mocks.failLifecycleTempWrite = true;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    // The lifecycle generation write failed, so the OLD generation is
    // unchanged...
    expect((await readLifecycle())?.generation).toBe(prior?.generation);
    // ...but the RECORD was already committed by this second call's rename
    // before the lifecycle write was attempted, so it reflects THIS
    // invocation, not the prior one.
    const committedRecordRaw = await readFile(
      cliInvocationRecordPath(hostHome),
      "utf8",
    );
    const committedRecord = parseCliInvocationRecord(
      JSON.parse(committedRecordRaw),
    );
    expect(committedRecord?.source.serviceLabel).toBe(LABEL);
    expect(committedRecord?.command).toBe(process.execPath);
    expect(committedRecord?.args).toEqual([scriptPath]);
    // The stale marker is the durable substitute for the missing generation;
    // once written, this owner's transaction is released, not kept.
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe(LABEL);
    expect(await transactionMarkerNames()).toEqual([]);
    expect(await leftoverLifecycleTemps()).toEqual([]);
  });

  it("marks stale, keeps the just-committed live record, and releases the txn when the lifecycle rename fails", async () => {
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    const prior = await readLifecycle();
    mocks.crashOnLifecycleRename = true;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect((await readLifecycle())?.generation).toBe(prior?.generation);
    const committedRecordRaw = await readFile(
      cliInvocationRecordPath(hostHome),
      "utf8",
    );
    const committedRecord = parseCliInvocationRecord(
      JSON.parse(committedRecordRaw),
    );
    expect(committedRecord?.source.serviceLabel).toBe(LABEL);
    expect(committedRecord?.command).toBe(process.execPath);
    expect(committedRecord?.args).toEqual([scriptPath]);
    const stale = parseCliInvocationStaleMarker(
      JSON.parse(
        await readFile(cliInvocationRecordStaleMarkerPath(hostHome), "utf8"),
      ),
    );
    expect(stale?.serviceLabel).toBe(LABEL);
    expect(await transactionMarkerNames()).toEqual([]);
    expect(await leftoverLifecycleTemps()).toEqual([]);
  });
});

describe("cross-process transaction ownership", () => {
  it("serializes genuine install actors and preserves the first owner's staging", async () => {
    if (process.platform === "win32") return;
    const firstEntered = join(hostHome, "first-entered");
    const firstRelease = join(hostHome, "first-release");
    const firstResult = join(hostHome, "first-result");
    const secondEntered = join(hostHome, "second-entered");
    const secondResult = join(hostHome, "second-result");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstRelease,
      resultPath: firstResult,
      waitMs: 2_000,
      command: process.execPath,
      argument: scriptPath,
    });
    try {
      await waitForFile(firstEntered);
      const markerRaw = (await readSoleTransactionMarker()).raw;
      const marker = parseCliInvocationTransactionMarker(JSON.parse(markerRaw));
      expect(marker?.operation).toBe("install");
      expect(marker?.stagingFile).toMatch(
        /^cli-invocation\.json\.staging\.[0-9a-f-]+$/,
      );
      expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(
        false,
      );
      expect(
        await exists(
          join(
            cliInvocationStateDir(hostHome),
            marker?.stagingFile ?? "missing",
          ),
        ),
      ).toBe(true);

      const second = spawnWorker({
        operation: "install",
        enteredPath: secondEntered,
        resultPath: secondResult,
        waitMs: 0,
        command: process.execPath,
        argument: scriptPath,
      });
      const secondCode = await waitForExit(second);
      expect(secondCode).toBe(1);
      expect(await readWorkerResult(secondResult)).toContain(
        '"code":"E_SERVICE_INSTALL_FAILED"',
      );
      expect(await exists(secondEntered)).toBe(false);
      expect((await readSoleTransactionMarker()).raw).toBe(markerRaw);
    } finally {
      await writeFile(firstRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
    }
    expect(await readWorkerResult(firstResult)).toBe("ok\n");
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await transactionMarkerNames()).toEqual([]);
  }, 30_000);

  it("prevents a genuine uninstall actor from deleting an install owner's state", async () => {
    if (process.platform === "win32") return;
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    const firstEntered = join(hostHome, "install-entered");
    const firstRelease = join(hostHome, "install-release");
    const firstResult = join(hostHome, "install-result");
    const uninstallEntered = join(hostHome, "uninstall-entered");
    const uninstallResult = join(hostHome, "uninstall-result");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstRelease,
      resultPath: firstResult,
      waitMs: 2_000,
      command: process.execPath,
      argument: scriptPath,
    });
    try {
      await waitForFile(firstEntered);
      const uninstall = spawnWorker({
        operation: "uninstall",
        enteredPath: uninstallEntered,
        resultPath: uninstallResult,
        waitMs: 0,
      });
      expect(await waitForExit(uninstall)).toBe(1);
      expect(await readWorkerResult(uninstallResult)).toContain(
        '"code":"E_SERVICE_UNINSTALL_FAILED"',
      );
      expect(await exists(uninstallEntered)).toBe(false);
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
      expect(await transactionMarkerNames()).toHaveLength(1);
    } finally {
      await writeFile(firstRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
    }
    expect(await readWorkerResult(firstResult)).toBe("ok\n");
    const cleanupEntered = join(hostHome, "cleanup-entered");
    const cleanupResult = join(hostHome, "cleanup-result");
    const cleanup = spawnWorker({
      operation: "uninstall",
      enteredPath: cleanupEntered,
      resultPath: cleanupResult,
      waitMs: 2_000,
    });
    expect(await waitForExit(cleanup)).toBe(0);
    expect(await readWorkerResult(cleanupResult)).toBe("ok\n");
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
  }, 30_000);

  it("reclaims a killed owner's marker without deleting its uniquely owned staging", async () => {
    if (process.platform === "win32") return;
    const entered = join(hostHome, "crashed-entered");
    const release = join(hostHome, "crashed-release");
    const result = join(hostHome, "crashed-result");
    const crashed = spawnWorker({
      operation: "install",
      enteredPath: entered,
      releasePath: release,
      resultPath: result,
      waitMs: 2_000,
      command: process.execPath,
      argument: scriptPath,
    });
    await waitForFile(entered);
    const marker = parseCliInvocationTransactionMarker(
      JSON.parse((await readSoleTransactionMarker()).raw),
    );
    if (marker === null) throw new Error("worker marker did not parse");
    const abandonedStaging = join(
      cliInvocationStateDir(hostHome),
      marker.stagingFile,
    );
    expect(await exists(abandonedStaging)).toBe(true);
    crashed.kill("SIGKILL");
    expect(await waitForExit(crashed)).not.toBe(0);
    expect(await transactionMarkerNames()).toHaveLength(1);
    expect(await exists(abandonedStaging)).toBe(true);

    const replacementEntered = join(hostHome, "replacement-entered");
    const replacementResult = join(hostHome, "replacement-result");
    const replacement = spawnWorker({
      operation: "install",
      enteredPath: replacementEntered,
      resultPath: replacementResult,
      waitMs: 5_000,
      command: process.execPath,
      argument: scriptPath,
    });
    expect(await waitForExit(replacement)).toBe(0);
    expect(await readWorkerResult(replacementResult)).toBe("ok\n");
    expect(await transactionMarkerNames()).toEqual([]);
    // A replacement owner may reclaim the transaction marker, but it may not
    // clean an abandoned staging file that it does not own.
    expect(await exists(abandonedStaging)).toBe(true);
  }, 30_000);

  it("treats a PID-reused owner identity as abandoned", async () => {
    const identity = currentProcessIdentityToken();
    if (identity.startIdentity === null) return;
    const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const exactPath = cliInvocationRecordTransactionMarkerPath(hostHome);
    const exactRaw = serializeCliInvocationTransactionMarker({
      schemaVersion: 1,
      kind: "transaction",
      owner: {
        pid: process.pid,
        token,
        processStartIdentity: `${identity.startIdentity}-reused`,
        startedAtMs: identity.startedAtMs,
      },
      stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${token}`,
      operation: "install",
      serviceLabel: LABEL,
      startedAt: new Date().toISOString(),
    });
    await writeFile(exactPath, exactRaw);
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => undefined,
    });
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
    expect(await transactionMarkerNames()).toEqual(["cli-invocation.txn"]);
  });

  it("does not reclaim a torn marker before the shared abandonment age", async () => {
    await writeFile(
      cliInvocationRecordTransactionMarkerPath(hostHome),
      '{"kind"',
    );
    const beforeSharedAge = new Date(
      Date.now() - Math.floor(CLI_INVOCATION_TXN_ABANDON_AFTER_MS / 2),
    );
    await utimes(
      cliInvocationRecordTransactionMarkerPath(hostHome),
      beforeSharedAge,
      beforeSharedAge,
    );
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 0,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(
      await exists(cliInvocationRecordTransactionMarkerPath(hostHome)),
    ).toBe(true);
    expect(
      await readFile(
        cliInvocationRecordTransactionMarkerPath(hostHome),
        "utf8",
      ),
    ).toBe('{"kind"');
  });

  it("leaves an abandoned exact marker byte-identical while a unique owner succeeds", async () => {
    const exactPath = cliInvocationRecordTransactionMarkerPath(hostHome);
    const exactRaw = serializeCliInvocationTransactionMarker({
      schemaVersion: 1,
      kind: "transaction",
      owner: {
        pid: 2147483646,
        token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        processStartIdentity: null,
        startedAtMs: 1,
      },
      stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      operation: "install",
      serviceLabel: LABEL,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    await writeFile(exactPath, exactRaw, { mode: 0o600 });
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: npmCli(),
      register: async () => {
        expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
        expect(await transactionMarkerNames()).toContain("cli-invocation.txn");
        expect(await transactionMarkerNames()).toHaveLength(2);
      },
    });
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
    expect(await transactionMarkerNames()).toEqual(["cli-invocation.txn"]);
  });

  it("blocks a new unique owner when the exact marker is positively live", async () => {
    const identity = currentProcessIdentityToken();
    const exactPath = cliInvocationRecordTransactionMarkerPath(hostHome);
    const exactRaw = serializeCliInvocationTransactionMarker({
      schemaVersion: 1,
      kind: "transaction",
      owner: {
        pid: identity.pid,
        token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        processStartIdentity: identity.startIdentity,
        startedAtMs: identity.startedAtMs,
      },
      stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      operation: "install",
      serviceLabel: LABEL,
      startedAt: new Date().toISOString(),
    });
    await writeFile(exactPath, exactRaw, { mode: 0o600 });
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 0,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
    expect(osMutated).toBe(false);
    expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
    expect(await transactionMarkerNames()).toEqual(["cli-invocation.txn"]);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
  });

  it("cannot rename or unlink an exact marker recreated by an old writer", async () => {
    if (process.platform === "win32") return;
    const exactPath = cliInvocationRecordTransactionMarkerPath(hostHome);
    const exactRaw = serializeCliInvocationTransactionMarker({
      schemaVersion: 1,
      kind: "transaction",
      owner: {
        pid: 2147483646,
        token: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        processStartIdentity: null,
        startedAtMs: 1,
      },
      stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`,
      operation: "install",
      serviceLabel: LABEL,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    await writeFile(exactPath, exactRaw, { mode: 0o600 });
    const firstEntered = join(hostHome, "exact-first-entered");
    const firstOsRelease = join(hostHome, "exact-first-os-release");
    const firstResult = join(hostHome, "exact-first-result");
    const firstPauseReady = join(hostHome, "exact-first-pause-ready");
    const firstPauseRelease = join(hostHome, "exact-first-pause-release");
    const secondEntered = join(hostHome, "exact-second-entered");
    const secondResult = join(hostHome, "exact-second-result");
    const secondPauseReady = join(hostHome, "exact-second-pause-ready");
    const secondPauseRelease = join(hostHome, "exact-second-pause-release");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstOsRelease,
      resultPath: firstResult,
      waitMs: 15_000,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: firstPauseReady,
      pauseReleasePath: firstPauseRelease,
    });
    const second = spawnWorker({
      operation: "install",
      enteredPath: secondEntered,
      resultPath: secondResult,
      waitMs: 0,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: secondPauseReady,
      pauseReleasePath: secondPauseRelease,
    });
    try {
      await waitForFile(firstPauseReady);
      await waitForFile(secondPauseReady);
      expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
      await writeFile(firstPauseRelease, "go\n");
      await waitForFile(firstEntered);
      expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
      const uniqueNames = (await transactionMarkerNames()).filter(
        (name) => name !== "cli-invocation.txn",
      );
      expect(uniqueNames).toHaveLength(1);
      await writeFile(secondPauseRelease, "go\n");
      expect(await waitForExit(second)).toBe(1);
      expect(await exists(secondEntered)).toBe(false);
      expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
    } finally {
      await writeFile(firstOsRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
    }
    expect(await readWorkerResult(firstResult)).toBe("ok\n");
    expect(await readFile(exactPath, "utf8")).toBe(exactRaw);
    expect(await transactionMarkerNames()).toEqual(["cli-invocation.txn"]);
  }, 30_000);

  async function writeDeadUniqueMarker(): Promise<{
    readonly path: string;
    readonly raw: string;
  }> {
    const token = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const raw = serializeCliInvocationTransactionMarker({
      schemaVersion: 1,
      kind: "transaction",
      owner: {
        pid: 2147483646,
        token,
        processStartIdentity: null,
        startedAtMs: 1,
      },
      stagingFile: `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${token}`,
      operation: "install",
      serviceLabel: LABEL,
      startedAt: "2020-01-01T00:00:00.000Z",
    });
    const path = cliInvocationRecordOwnedTransactionPath(hostHome, token);
    await writeFile(path, raw, { mode: 0o600 });
    return { path, raw };
  }

  it("does not let a paused reclaimer delete a unique owner acquired from the same abandoned marker", async () => {
    if (process.platform === "win32") return;
    const dead = await writeDeadUniqueMarker();
    const firstEntered = join(hostHome, "reclaim-first-entered");
    const firstOsRelease = join(hostHome, "reclaim-first-os-release");
    const firstResult = join(hostHome, "reclaim-first-result");
    const firstPauseReady = join(hostHome, "reclaim-first-pause-ready");
    const firstPauseRelease = join(hostHome, "reclaim-first-pause-release");
    const secondEntered = join(hostHome, "reclaim-second-entered");
    const secondResult = join(hostHome, "reclaim-second-result");
    const secondPauseReady = join(hostHome, "reclaim-second-pause-ready");
    const secondPauseRelease = join(hostHome, "reclaim-second-pause-release");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstOsRelease,
      resultPath: firstResult,
      waitMs: 15_000,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: firstPauseReady,
      pauseReleasePath: firstPauseRelease,
    });
    const second = spawnWorker({
      operation: "install",
      enteredPath: secondEntered,
      resultPath: secondResult,
      waitMs: 0,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: secondPauseReady,
      pauseReleasePath: secondPauseRelease,
    });
    try {
      await waitForFile(firstPauseReady);
      await waitForFile(secondPauseReady);
      expect(await exists(dead.path)).toBe(true);
      await writeFile(firstPauseRelease, "go\n");
      await waitForFile(firstEntered);
      const owner = await readSoleTransactionMarker();
      expect(owner.name).not.toBe("cli-invocation.txn");
      expect(await exists(dead.path)).toBe(false);
      await writeFile(secondPauseRelease, "go\n");
      expect(await waitForExit(second)).toBe(1);
      expect(await readWorkerResult(secondResult)).toContain(
        '"code":"E_SERVICE_INSTALL_FAILED"',
      );
      expect(await exists(secondEntered)).toBe(false);
      expect((await readSoleTransactionMarker()).raw).toBe(owner.raw);
    } finally {
      await writeFile(firstOsRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
    }
    expect(await readWorkerResult(firstResult)).toBe("ok\n");
    expect(await transactionMarkerNames()).toEqual([]);
  }, 30_000);

  it("keeps a newly live owner safe from two other paused reclaimers", async () => {
    if (process.platform === "win32") return;
    const dead = await writeDeadUniqueMarker();
    const firstEntered = join(hostHome, "three-first-entered");
    const firstOsRelease = join(hostHome, "three-first-os-release");
    const firstResult = join(hostHome, "three-first-result");
    const firstPauseReady = join(hostHome, "three-first-pause-ready");
    const firstPauseRelease = join(hostHome, "three-first-pause-release");
    const secondEntered = join(hostHome, "three-second-entered");
    const secondResult = join(hostHome, "three-second-result");
    const secondPauseReady = join(hostHome, "three-second-pause-ready");
    const secondPauseRelease = join(hostHome, "three-second-pause-release");
    const thirdEntered = join(hostHome, "three-third-entered");
    const thirdResult = join(hostHome, "three-third-result");
    const thirdPauseReady = join(hostHome, "three-third-pause-ready");
    const thirdPauseRelease = join(hostHome, "three-third-pause-release");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstOsRelease,
      resultPath: firstResult,
      waitMs: 15_000,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: firstPauseReady,
      pauseReleasePath: firstPauseRelease,
    });
    const second = spawnWorker({
      operation: "install",
      enteredPath: secondEntered,
      resultPath: secondResult,
      waitMs: 0,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: secondPauseReady,
      pauseReleasePath: secondPauseRelease,
    });
    const third = spawnWorker({
      operation: "install",
      enteredPath: thirdEntered,
      resultPath: thirdResult,
      waitMs: 0,
      command: process.execPath,
      argument: scriptPath,
      pauseReadyPath: thirdPauseReady,
      pauseReleasePath: thirdPauseRelease,
    });
    let firstExited = false;
    let secondExited = false;
    let thirdExited = false;
    try {
      // All three actors must hold the same abandoned snapshot before any one
      // is allowed to clean it. This is the interleaving that used to let a
      // delayed compare/unlink reach a pathname after its replacement.
      await waitForFile(firstPauseReady);
      await waitForFile(secondPauseReady);
      await waitForFile(thirdPauseReady);
      expect(await exists(dead.path)).toBe(true);

      await writeFile(firstPauseRelease, "go\n");
      await waitForFile(firstEntered);
      const owner = await readSoleTransactionMarker();
      expect(owner.name).not.toBe("cli-invocation.txn");
      expect(await exists(dead.path)).toBe(false);

      // Each delayed reclaimer still has the abandoned marker in its local
      // snapshot. Releasing it now must not remove the first actor's newly
      // live unique marker or enter the OS mutation itself.
      await writeFile(secondPauseRelease, "go\n");
      expect(await waitForExit(second)).toBe(1);
      secondExited = true;
      expect(await exists(secondEntered)).toBe(false);
      expect((await readSoleTransactionMarker()).raw).toBe(owner.raw);

      await writeFile(thirdPauseRelease, "go\n");
      expect(await waitForExit(third)).toBe(1);
      thirdExited = true;
      expect(await exists(thirdEntered)).toBe(false);
      expect((await readSoleTransactionMarker()).raw).toBe(owner.raw);
    } finally {
      await writeFile(firstPauseRelease, "go\n");
      await writeFile(secondPauseRelease, "go\n");
      await writeFile(thirdPauseRelease, "go\n");
      await writeFile(firstOsRelease, "release\n");
      if (!firstExited) {
        expect(await waitForExit(first)).toBe(0);
        firstExited = true;
      }
      if (!secondExited) {
        await waitForExit(second);
        secondExited = true;
      }
      if (!thirdExited) {
        await waitForExit(third);
        thirdExited = true;
      }
    }
    expect(await readWorkerResult(firstResult)).toBe("ok\n");
    expect(await readWorkerResult(secondResult)).toContain(
      '"code":"E_SERVICE_INSTALL_FAILED"',
    );
    expect(await readWorkerResult(thirdResult)).toContain(
      '"code":"E_SERVICE_INSTALL_FAILED"',
    );
    expect(await transactionMarkerNames()).toEqual([]);
  }, 30_000);

  it("does not let a late contender preempt an established live unique owner", async () => {
    if (process.platform === "win32") return;
    const firstEntered = join(hostHome, "late-first-entered");
    const firstOsRelease = join(hostHome, "late-first-os-release");
    const firstResult = join(hostHome, "late-first-result");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstOsRelease,
      resultPath: firstResult,
      waitMs: 15_000,
      command: process.execPath,
      argument: scriptPath,
    });
    try {
      await waitForFile(firstEntered);
      const owner = await readSoleTransactionMarker();
      const lateEntered = join(hostHome, "late-second-entered");
      const lateResult = join(hostHome, "late-second-result");
      const late = spawnWorker({
        operation: "install",
        enteredPath: lateEntered,
        resultPath: lateResult,
        waitMs: 0,
        command: process.execPath,
        argument: scriptPath,
      });
      expect(await waitForExit(late)).toBe(1);
      expect(await exists(lateEntered)).toBe(false);
      expect((await readSoleTransactionMarker()).raw).toBe(owner.raw);
      expect(await transactionMarkerNames()).toEqual([owner.name]);
    } finally {
      await writeFile(firstOsRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
    }
    expect(await readWorkerResult(firstResult)).toBe("ok\n");
  }, 30_000);

  it("converges simultaneous unique contenders to a single OS mutator", async () => {
    if (process.platform === "win32") return;
    const firstEntered = join(hostHome, "sim-first-entered");
    const firstOsRelease = join(hostHome, "sim-first-os-release");
    const firstResult = join(hostHome, "sim-first-result");
    const secondEntered = join(hostHome, "sim-second-entered");
    const secondOsRelease = join(hostHome, "sim-second-os-release");
    const secondResult = join(hostHome, "sim-second-result");
    const first = spawnWorker({
      operation: "install",
      enteredPath: firstEntered,
      releasePath: firstOsRelease,
      resultPath: firstResult,
      waitMs: 15_000,
      command: process.execPath,
      argument: scriptPath,
    });
    const second = spawnWorker({
      operation: "install",
      enteredPath: secondEntered,
      releasePath: secondOsRelease,
      resultPath: secondResult,
      waitMs: 15_000,
      command: process.execPath,
      argument: scriptPath,
    });
    const winnerDeadline = Date.now() + 15_000;
    let winner: "first" | "second" | null = null;
    while (Date.now() < winnerDeadline && winner === null) {
      if (await exists(firstEntered)) winner = "first";
      else if (await exists(secondEntered)) winner = "second";
      else {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 20);
        });
      }
    }
    if (winner === null) {
      throw new Error("neither simultaneous contender entered the OS mutation");
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 300);
    });
    const firstInOs = await exists(firstEntered);
    const secondInOs = await exists(secondEntered);
    expect(firstInOs !== secondInOs).toBe(true);
    expect(await transactionMarkerNames()).toHaveLength(1);
    const ownerRaw = (await readSoleTransactionMarker()).raw;
    if (winner === "first") {
      expect(secondInOs).toBe(false);
      await writeFile(firstOsRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
      await writeFile(secondOsRelease, "release\n");
      expect(await waitForExit(second)).toBe(0);
    } else {
      expect(firstInOs).toBe(false);
      await writeFile(secondOsRelease, "release\n");
      expect(await waitForExit(second)).toBe(0);
      await writeFile(firstOsRelease, "release\n");
      expect(await waitForExit(first)).toBe(0);
    }
    expect(ownerRaw.length).toBeGreaterThan(0);
    expect(await transactionMarkerNames()).toEqual([]);
  }, 30_000);
});

describe("invocation validation", () => {
  it("refuses a command that is not an executable regular file before OS mutation", async () => {
    const directoryCommand = join(hostHome, "not-a-binary");
    await mkdir(directoryCommand);
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: directoryCommand, args: [] },
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
    expect(osMutated).toBe(false);
  });

  it("refuses an npm-style interpreter registration whose script argument is relative", async () => {
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: process.execPath, args: ["./traycer.js"] },
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
    expect(osMutated).toBe(false);
    expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    expect(await exists(cliInvocationRecordStagingPath(hostHome))).toBe(false);
  });

  it("accepts a non-node command with a relative leading argument (not the npm shape)", async () => {
    // Only a node-family basename (`node`/`node.exe`/`bun`/`bun.exe`) triggers
    // the "leading arg must be an absolute script" rule; a standalone binary
    // is free to carry other leading args, e.g. a preserved flag.
    await runServiceRegistrationWithInvocationRecord({
      environment: "production",
      hostHomeDir: hostHome,
      waitMs: 2_000,
      pollIntervalMs: 20,
      serviceLabel: LABEL,
      cli: { command: standaloneCliPath, args: ["--flag"] },
      register: async () => undefined,
    });
    const live = parseCliInvocationRecord(
      JSON.parse(await readFile(cliInvocationRecordPath(hostHome), "utf8")),
    );
    expect(live?.command).toBe(standaloneCliPath);
    expect(live?.args).toEqual(["--flag"]);
  });

  it("refuses a file-like absolute leading argument that is not a regular file", async () => {
    const missing = join(hostHome, "does-not-exist.js");
    let osMutated = false;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: process.execPath, args: [missing] },
        register: async () => {
          osMutated = true;
        },
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
    expect(osMutated).toBe(false);
  });

  it("refuses a leading argument containing NUL", async () => {
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: standaloneCliPath, args: ["bad\0arg"] },
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
  });

  it("refuses a leading argument exceeding the length bound", async () => {
    const tooLong = "a".repeat(CLI_INVOCATION_RECORD_MAX_ARG_LENGTH + 1);
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: standaloneCliPath, args: [tooLong] },
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
  });

  it("refuses a command exceeding the length bound", async () => {
    const tooLong = `/${"a".repeat(CLI_INVOCATION_RECORD_MAX_ARG_LENGTH)}`;
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: tooLong, args: [] },
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
  });

  it("refuses more leading arguments than the frozen bound", async () => {
    const args = Array.from(
      { length: CLI_INVOCATION_RECORD_MAX_ARGS + 1 },
      (_, i) => `--flag-${i}`,
    );
    await expect(
      runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: { command: standaloneCliPath, args },
        register: async () => undefined,
      }),
    ).rejects.toMatchObject({
      code: CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED,
    });
  });

  if (process.platform !== "win32") {
    it("succeeds through a 0700 child when the parent host home is 0775", async () => {
      await chmod(hostHome, 0o775);
      await runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      });
      expect((await stat(hostHome)).mode & 0o777).toBe(0o775);
      expect((await stat(cliInvocationStateDir(hostHome))).mode & 0o777).toBe(
        0o700,
      );
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
    });

    it("rejects an existing unsafe state child without chmod-narrowing it or the parent", async () => {
      await chmod(hostHome, 0o755);
      await chmod(cliInvocationStateDir(hostHome), 0o750);
      let osMutated = false;
      await expect(
        runServiceRegistrationWithInvocationRecord({
          environment: "production",
          hostHomeDir: hostHome,
          waitMs: 2_000,
          pollIntervalMs: 20,
          serviceLabel: LABEL,
          cli: npmCli(),
          register: async () => {
            osMutated = true;
          },
        }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
      expect(osMutated).toBe(false);
      expect((await stat(hostHome)).mode & 0o777).toBe(0o755);
      expect((await stat(cliInvocationStateDir(hostHome))).mode & 0o777).toBe(
        0o750,
      );
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    });

    it("does not treat root-level residue as authority", async () => {
      const rootRecord = join(hostHome, "cli-invocation.json");
      await writeFile(rootRecord, "not-authority\n", { mode: 0o644 });
      await chmod(hostHome, 0o775);
      await runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      });
      expect(await readFile(rootRecord, "utf8")).toBe("not-authority\n");
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
      expect(cliInvocationRecordPath(hostHome)).not.toBe(rootRecord);
      expect((await stat(hostHome)).mode & 0o777).toBe(0o775);
    });

    it("rejects a symlinked state child on install and uninstall without touching the target", async () => {
      const target = join(hostHome, "not-the-state-dir");
      await mkdir(target, { recursive: true, mode: 0o700 });
      await chmod(target, 0o700);
      await writeFile(join(target, "sentinel"), "keep\n", { mode: 0o600 });
      await rm(cliInvocationStateDir(hostHome), {
        recursive: true,
        force: true,
      });
      await symlink(target, cliInvocationStateDir(hostHome));
      let osMutated = false;
      await expect(
        runServiceRegistrationWithInvocationRecord({
          environment: "production",
          hostHomeDir: hostHome,
          waitMs: 2_000,
          pollIntervalMs: 20,
          serviceLabel: LABEL,
          cli: npmCli(),
          register: async () => {
            osMutated = true;
          },
        }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
        details: { causeCode: expect.any(String) },
      });
      expect(osMutated).toBe(false);
      await expect(
        runServiceUninstallWithInvocationRecord({
          environment: "production",
          hostHomeDir: hostHome,
          waitMs: 2_000,
          pollIntervalMs: 20,
          serviceLabel: LABEL,
          uninstall: async () => {
            osMutated = true;
          },
        }),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_UNINSTALL_FAILED,
        details: { causeCode: expect.any(String) },
      });
      expect(osMutated).toBe(false);
      expect(await readFile(join(target, "sentinel"), "utf8")).toBe("keep\n");
      expect(await exists(join(target, "cli-invocation.json"))).toBe(false);
    });

    it("skips a symlink at a unique txn basename and does not treat it as a live contender", async () => {
      const sentinel = join(hostHome, "marker-sentinel");
      await writeFile(sentinel, "do-not-read\n", { mode: 0o600 });
      const planted = `${CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX}aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`;
      await symlink(sentinel, join(cliInvocationStateDir(hostHome), planted));
      let osMutated = false;
      await runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      });
      expect(osMutated).toBe(true);
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("do-not-read\n");
      expect(await transactionMarkerNames()).toEqual([planted]);
    });

    it("does not pathname-chmod a sentinel after exclusive create if the child is swapped", async () => {
      const ready = join(hostHome, "excl-ready");
      const release = join(hostHome, "excl-release");
      __setCliInvocationPauseAfterExclusiveCreateForTest(async () => {
        await writeFile(ready, "ready\n");
        await waitForFile(release);
      });
      let osMutated = false;
      const install = runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      });
      await waitForFile(ready);
      const names = await transactionMarkerNames();
      const txn = names.find((name) =>
        name.startsWith(CLI_INVOCATION_RECORD_TXN_FILENAME_PREFIX),
      );
      if (txn === undefined) throw new Error("expected unique txn after wx");
      const sentinel = join(hostHome, "mode-sentinel");
      await writeFile(sentinel, "mode\n", { mode: 0o644 });
      await chmod(sentinel, 0o644);
      expect((await stat(sentinel)).mode & 0o777).toBe(0o644);
      const original = cliInvocationStateDir(hostHome);
      const attacker = join(hostHome, "attacker-chmod");
      await mkdir(attacker, { recursive: true, mode: 0o700 });
      await chmod(attacker, 0o700);
      await symlink(sentinel, join(attacker, txn));
      await renameFile(original, join(hostHome, "original-chmod-state"));
      await renameFile(attacker, original);
      await writeFile(release, "go\n");
      await expect(install).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      });
      expect(osMutated).toBe(false);
      expect((await stat(sentinel)).mode & 0o777).toBe(0o644);
    });

    it("fails closed if the child is swapped after the gate, without truncating a sentinel", async () => {
      const ready = join(hostHome, "gate-ready");
      const release = join(hostHome, "gate-release");
      __setCliInvocationStateDirPauseAfterGateForTest(async () => {
        await writeFile(ready, "ready\n");
        await waitForFile(release);
      });
      let osMutated = false;
      const install = runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => {
          osMutated = true;
        },
      });
      await waitForFile(ready);
      const original = cliInvocationStateDir(hostHome);
      const attacker = join(hostHome, "attacker-state");
      await mkdir(attacker, { recursive: true, mode: 0o700 });
      await chmod(attacker, 0o700);
      const sentinel = join(hostHome, "sentinel-file");
      await writeFile(sentinel, "untouched\n", { mode: 0o600 });
      await symlink(
        sentinel,
        join(
          attacker,
          "cli-invocation.json.staging.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        ),
      );
      await symlink(sentinel, join(attacker, "cli-invocation.lifecycle"));
      await symlink(sentinel, join(attacker, "cli-invocation.stale"));
      await renameFile(original, join(hostHome, "original-state"));
      await renameFile(attacker, original);
      await writeFile(release, "go\n");
      await expect(install).rejects.toMatchObject({
        code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED,
      });
      expect(osMutated).toBe(false);
      expect(await readFile(sentinel, "utf8")).toBe("untouched\n");
    });

    it("fails closed on wx EEXIST of a fresh staging path and does not mutate the OS", async () => {
      let writes = 0;
      __setCliInvocationStateDirPauseBeforeWriteForTest(async () => {
        writes += 1;
        if (writes !== 2) return;
        const names = await transactionMarkerNames();
        const txn = names.find((name) =>
          name.startsWith("cli-invocation.txn."),
        );
        if (txn === undefined) throw new Error("expected unique txn marker");
        const token = txn.slice("cli-invocation.txn.".length);
        await writeFile(
          join(
            cliInvocationStateDir(hostHome),
            `${CLI_INVOCATION_RECORD_STAGING_FILENAME_PREFIX}${token}`,
          ),
          "occupied\n",
          { mode: 0o600 },
        );
      });
      let osMutated = false;
      await expect(
        runServiceRegistrationWithInvocationRecord({
          environment: "production",
          hostHomeDir: hostHome,
          waitMs: 2_000,
          pollIntervalMs: 20,
          serviceLabel: LABEL,
          cli: npmCli(),
          register: async () => {
            osMutated = true;
          },
        }),
      ).rejects.toMatchObject({ code: CLI_ERROR_CODES.SERVICE_INSTALL_FAILED });
      expect(osMutated).toBe(false);
    });

    it("creates a missing state child privately at 0700 without forcing the parent to 0700", async () => {
      const nested = join(hostHome, "nested-home");
      await mkdir(nested, { recursive: true, mode: 0o755 });
      await chmod(nested, 0o755);
      await runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: nested,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      });
      expect((await stat(nested)).mode & 0o777).toBe(0o755);
      expect((await stat(cliInvocationStateDir(nested))).mode & 0o777).toBe(
        0o700,
      );
      expect(await exists(cliInvocationRecordPath(nested))).toBe(true);
    });
  }

  if (process.platform === "win32") {
    it("installs and uninstalls through the state directory without opening it as a file", async () => {
      await runServiceRegistrationWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        cli: npmCli(),
        register: async () => undefined,
      });
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(true);
      await runServiceUninstallWithInvocationRecord({
        environment: "production",
        hostHomeDir: hostHome,
        waitMs: 2_000,
        pollIntervalMs: 20,
        serviceLabel: LABEL,
        uninstall: async () => undefined,
      });
      expect(await exists(cliInvocationRecordPath(hostHome))).toBe(false);
    });
  }
});
