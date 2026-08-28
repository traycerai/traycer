import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { PathLike, RmOptions } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Environment = "dev" | "production";

let sandboxRoot = "";

function hostHomeFor(environment: Environment): string {
  return join(sandboxRoot, "host", environment);
}
function installDirFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install");
}
function stagingRootFor(environment: Environment): string {
  return join(hostHomeFor(environment), "install-staging");
}

// Mirrors stage-reconcile.test.ts's seam: forces `unlink`/`rm`/`rename` to
// fail for one specific path while every other path proxies through to the
// real implementation - the exact operations layered invalidation and the
// commit rename depend on. `forceRenameFailureForDestination` matches on
// the rename's destination (`to`) argument, since the source is a
// dynamically-generated staging dir the test can't hardcode.
const mocks = vi.hoisted(() => ({
  forceUnlinkFailureForPath: null as string | null,
  forceRmFailureForPath: null as string | null,
  forceRenameFailureForDestination: null as string | null,
  // Finding-2 regression (reconcile-before-commit): the reconcile restore
  // rename and atomicSwap's own swap-in rename can share the exact same
  // destination (`install/`), so distinguishing "let the Nth call to this
  // destination succeed, fail a LATER one" needs a call-index gate on top
  // of the plain destination match above. `null` preserves every existing
  // test's behavior (fail on every call to the matched destination).
  forceRenameFailureForDestinationOnCall: null as number | null,
  // Prefix-matched variant of the destination match above, for renames
  // whose destination the test cannot hardcode - atomicSwap's aside rename
  // targets `install.old-<Date.now()>`. Call counting keys on the prefix.
  forceRenameFailureForDestinationPrefix: null as string | null,
  // Error code the simulated failure carries. "EIO" (non-retryable) by
  // default so a matched rename fails on the first attempt instead of
  // spending the swap retry schedule; the swap-lock-recovery tests set
  // "EBUSY" to exercise the retries.
  forceRenameFailureCode: "EIO" as string,
  // Retry-until-success gate: when set, calls 1..N to the matched
  // destination fail and later calls succeed. Mutually exclusive with the
  // exact-call gate above.
  forceRenameFailureUntilCall: null as number | null,
  renameCallCountByDestination: new Map<string, number>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    unlink: async (path: PathLike) => {
      if (path === mocks.forceUnlinkFailureForPath) {
        throw Object.assign(new Error("simulated unlink failure"), {
          code: "EPERM",
        });
      }
      return actual.unlink(path);
    },
    rm: async (path: PathLike, options: RmOptions) => {
      if (path === mocks.forceRmFailureForPath) {
        throw Object.assign(new Error("simulated rm failure"), {
          code: "EPERM",
        });
      }
      return actual.rm(path, options);
    },
    rename: async (from: PathLike, to: PathLike) => {
      const toKey = String(to);
      const prefix = mocks.forceRenameFailureForDestinationPrefix;
      const prefixMatched = prefix !== null && toKey.startsWith(prefix);
      if (to === mocks.forceRenameFailureForDestination || prefixMatched) {
        const countKey = prefixMatched && prefix !== null ? prefix : toKey;
        const callNumber =
          (mocks.renameCallCountByDestination.get(countKey) ?? 0) + 1;
        mocks.renameCallCountByDestination.set(countKey, callNumber);
        const gate = mocks.forceRenameFailureForDestinationOnCall;
        const until = mocks.forceRenameFailureUntilCall;
        const shouldFail =
          until !== null
            ? callNumber <= until
            : gate === null || callNumber === gate;
        if (shouldFail) {
          // "EIO" (non-retryable) unless a test overrides the code, so
          // `renameWithRetry` fails on the first attempt instead of
          // spending the retry schedule on EBUSY/EPERM/etc.
          throw Object.assign(new Error("simulated rename failure"), {
            code: mocks.forceRenameFailureCode,
          });
        }
      }
      return actual.rename(from, to);
    },
  };
});

// `store/paths` computes `TRAYCER_HOME` from `os.homedir()` once at module
// load - any export this mock leaves un-overridden would otherwise resolve
// against the REAL production `~/.traycer`, not this sandbox. Redirect the
// `os` boundary itself so `vi.importActual`'s fresh module evaluation picks
// up the sandbox (falling back to the real tmpdir, never the real home,
// before the first `beforeEach` has set `sandboxRoot`).
// `vi.mock` factories are hoisted above this file's own top-level `let
// sandboxRoot` - a direct reference hits a TDZ `ReferenceError`, so the
// live value has to live in `vi.hoisted` instead.
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
    hostStagingRoot: (environment: Environment) => stagingRootFor(environment),
    ensureHostHomeDir: async (environment: Environment) => {
      mkdirSync(hostHomeFor(environment), { recursive: true });
    },
    ensureHostInstallDir: async (environment: Environment) => {
      mkdirSync(installDirFor(environment), { recursive: true });
    },
    ensureHostStagingRoot: async (environment: Environment) => {
      mkdirSync(stagingRootFor(environment), { recursive: true });
    },
  };
});

import {
  commitHostInstallSource as commitHostInstallSourceWithAuthority,
  commitInstallFromSource as commitInstallFromSourceWithAuthority,
  currentInstallArch,
  currentInstallPlatform,
  discardStagedHostInstallSource,
  installHost,
  setSwapRenameDelaysForTests,
  SWAP_RENAME_DELAYS_MS,
  SWAP_RENAME_MAX_TOTAL_MS,
  sweepOldTrash,
  type StagedHostInstallSource,
} from "../install";
import { readHostInstallRecord } from "../../manifest/host-install";
import { createCliLogger } from "../../logger";
import { CLI_ERROR_CODES, CliError } from "../../runner/errors";

const ENV: Environment = "production";

const testMutationVerifier = async (): Promise<void> => undefined;
type CommitHostOptions = Parameters<
  typeof commitHostInstallSourceWithAuthority
>[0];
const commitHostInstallSource = (
  options: Omit<CommitHostOptions, "verifyMutationCapability"> &
    Partial<Pick<CommitHostOptions, "verifyMutationCapability">>,
) =>
  commitHostInstallSourceWithAuthority({
    ...options,
    verifyMutationCapability:
      options.verifyMutationCapability ?? testMutationVerifier,
  });
type CommitSourceOptions = Parameters<
  typeof commitInstallFromSourceWithAuthority
>[0];
const commitInstallFromSource = (
  options: Omit<CommitSourceOptions, "verifyMutationCapability"> &
    Partial<Pick<CommitSourceOptions, "verifyMutationCapability">>,
) =>
  commitInstallFromSourceWithAuthority({
    ...options,
    verifyMutationCapability:
      options.verifyMutationCapability ?? testMutationVerifier,
  });

function writeLocalHostSource(sourceDir: string, marker: string): void {
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(sourceDir, "traycer-host"), `binary-${marker}`);
}

describe("sweepOldTrash", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    mocks.forceRenameFailureForDestination = null;
    mocks.forceRenameFailureForDestinationOnCall = null;
    mocks.renameCallCountByDestination.clear();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("invalidates install.old-* litter even when the sidecar unlink AND the recursive removal both fail", async () => {
    // Same shape as stage-reconcile.test.ts's identical staged-aside test:
    // the rename-to-`.dead-*` primary layer is left real (not forced to
    // fail), so forcing exactly the two operations that were the pre-parity
    // implementation's whole defense to fail no longer matters - the
    // candidate is already structurally invisible to the `.old-*` scan
    // before unlink/rm are ever reached.
    const installDir = installDirFor(ENV);
    mkdirSync(installDir, { recursive: true });
    const asideDir = `${installDir}.old-${Date.now()}`;
    mkdirSync(asideDir, { recursive: true });
    writeFileSync(join(asideDir, "install.json"), '{"version":"1.0.0"}');
    mocks.forceUnlinkFailureForPath = join(asideDir, "install.json");
    mocks.forceRmFailureForPath = asideDir;

    const logger = createCliLogger(ENV);
    await sweepOldTrash(
      installDir,
      "install.json",
      logger,
      testMutationVerifier,
    );

    expect(existsSync(asideDir)).toBe(false);
    // Not restorable by a subsequent sweep either - nothing is left under
    // the `.old-*` prefix that `sweepOldTrash`'s listing scans.
    const remaining = readdirSync(hostHomeFor(ENV)).filter((name) =>
      name.includes(".old-"),
    );
    expect(remaining).toEqual([]);
  });
});

describe("installHost", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    mocks.forceRenameFailureForDestination = null;
    mocks.forceRenameFailureForDestinationOnCall = null;
    mocks.renameCallCountByDestination.clear();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("mints a fresh installId on every successful install", async () => {
    const sourceDir = join(sandboxRoot, "source-1");
    writeLocalHostSource(sourceDir, "v1");

    const { record } = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: sourceDir },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: "1.0.0",
    });

    expect(record.installId).not.toBeNull();
    expect(typeof record.installId).toBe("string");
    const stored = await readHostInstallRecord(ENV);
    expect(stored?.installId).toBe(record.installId);
  });

  it("replaces an existing install and leaves no install.old-* trash behind", async () => {
    const firstSource = join(sandboxRoot, "source-1");
    writeLocalHostSource(firstSource, "v1");
    const first = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: firstSource },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: "1.0.0",
    });

    const secondSource = join(sandboxRoot, "source-2");
    writeLocalHostSource(secondSource, "v2");
    const second = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: secondSource },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: "2.0.0",
    });

    expect(second.previous?.version).toBe("1.0.0");
    expect(second.record.version).toBe("2.0.0");
    // installId is a fresh identity per materialization, not reused across
    // installs - see the shared install-generation fingerprint module.
    expect(second.record.installId).not.toBe(first.record.installId);
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-v2",
    );

    const leftoverTrash = readdirSync(hostHomeFor(ENV)).filter((name) =>
      name.includes(".old-"),
    );
    expect(leftoverTrash).toEqual([]);
  });
});

describe("commitInstallFromSource", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    mocks.forceRenameFailureForDestination = null;
    mocks.forceRenameFailureForDestinationOnCall = null;
    mocks.renameCallCountByDestination.clear();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  it("materializes install.json inside the source tree BEFORE the commit rename, so it survives a failed swap", async () => {
    // Proves the crash-safety property the commit tail exists for: the
    // record and the bytes travel in ONE rename, not a rename followed by
    // a separate post-swap write (which could land bytes with no record on
    // a crash in between). Forcing the commit rename itself to fail here
    // means the source dir is never consumed - if the write happened
    // AFTER the rename (the pre-refactor ordering), it would never have
    // been attempted at all.
    const sourceDir = join(sandboxRoot, "pre-staged");
    writeLocalHostSource(sourceDir, "v1");
    const executablePath = join(sourceDir, "traycer-host");
    mocks.forceRenameFailureForDestination = installDirFor(ENV);

    await expect(
      commitInstallFromSource({
        environment: ENV,
        sourceDir,
        executablePath,
        version: "1.0.0",
        runtimeVersion: null,
        source: { kind: "local-file", value: sourceDir },
        archiveSha256: null,
        signatureVerifiedAt: new Date().toISOString(),
        signatureKeyId: "local-file:unsigned",
        sizeBytes: 0,
        onProgress: () => {},
        lifecycle: null,
        onCommitted: () => {},
      }),
    ).rejects.toThrow();

    expect(existsSync(installDirFor(ENV))).toBe(false);
    const recordPath = join(sourceDir, "install.json");
    expect(existsSync(recordPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(recordPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.version).toBe("1.0.0");
    expect(typeof parsed.installId).toBe("string");
  });

  it("invokes onCommitted only after the rename succeeds, never on a failed swap", async () => {
    const sourceDir = join(sandboxRoot, "pre-staged");
    writeLocalHostSource(sourceDir, "v1");
    const executablePath = join(sourceDir, "traycer-host");
    mocks.forceRenameFailureForDestination = installDirFor(ENV);
    let committed = false;

    await expect(
      commitInstallFromSource({
        environment: ENV,
        sourceDir,
        executablePath,
        version: "1.0.0",
        runtimeVersion: null,
        source: { kind: "local-file", value: sourceDir },
        archiveSha256: null,
        signatureVerifiedAt: new Date().toISOString(),
        signatureKeyId: "local-file:unsigned",
        sizeBytes: 0,
        onProgress: () => {},
        lifecycle: null,
        onCommitted: () => {
          committed = true;
        },
      }),
    ).rejects.toThrow();

    expect(committed).toBe(false);
  });
});

describe("atomicSwap - swap-lock recovery", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    mocks.forceRenameFailureForDestination = null;
    mocks.forceRenameFailureForDestinationOnCall = null;
    mocks.forceRenameFailureForDestinationPrefix = null;
    mocks.forceRenameFailureCode = "EIO";
    mocks.forceRenameFailureUntilCall = null;
    mocks.renameCallCountByDestination.clear();
    setSwapRenameDelaysForTests(null);
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  async function installVersion(marker: string, version: string) {
    const sourceDir = join(sandboxRoot, `source-${marker}`);
    writeLocalHostSource(sourceDir, marker);
    return installHost({
      environment: ENV,
      source: { kind: "local-file", path: sourceDir },
      onProgress: () => {},
      lifecycle: null,
      recordVersionOverride: version,
    });
  }

  it("re-kills lingering slot processes between retryable aside-rename attempts and then succeeds", async () => {
    await installVersion("v1", "1.0.0");
    // The aside rename targets `install.old-<Date.now()>` - only the
    // prefix is predictable. Two EBUSY failures, then the rename goes
    // through: the shape of a lingering handle that a re-kill releases.
    mocks.forceRenameFailureForDestinationPrefix = `${installDirFor(ENV)}.old-`;
    mocks.forceRenameFailureCode = "EBUSY";
    mocks.forceRenameFailureUntilCall = 2;
    const kill = vi.fn(async () => {});

    const sourceDir = join(sandboxRoot, "source-v2");
    writeLocalHostSource(sourceDir, "v2");
    const { record } = await installHost({
      environment: ENV,
      source: { kind: "local-file", path: sourceDir },
      onProgress: () => {},
      lifecycle: {
        beforeSwap: async () => {},
        afterSwap: async () => {},
        swapLockRecovery: {
          killLingeringProcesses: kill,
          describeLockHolders: async () => [],
        },
      },
      recordVersionOverride: "2.0.0",
    });

    expect(record.version).toBe("2.0.0");
    expect(kill).toHaveBeenCalledTimes(2);
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-v2",
    );
  });

  it("wraps a stuck aside rename in a CliError naming the lock holders and leaves the previous install intact", async () => {
    await installVersion("v1", "1.0.0");
    // Default "EIO" fails the aside rename on the first attempt - the
    // exhausted-retries shape without the schedule's wall-clock cost.
    mocks.forceRenameFailureForDestinationPrefix = `${installDirFor(ENV)}.old-`;

    const sourceDir = join(sandboxRoot, "source-v2");
    writeLocalHostSource(sourceDir, "v2");
    let thrown: unknown;
    try {
      await installHost({
        environment: ENV,
        source: { kind: "local-file", path: sourceDir },
        onProgress: () => {},
        lifecycle: {
          beforeSwap: async () => {},
          afterSwap: async () => {},
          swapLockRecovery: {
            killLingeringProcesses: async () => {},
            describeLockHolders: async () => [
              {
                pid: 4242,
                name: "claude.exe",
                executablePath: "C:\\clients\\claude.exe",
              },
            ],
          },
        },
        recordVersionOverride: "2.0.0",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const cliErr = thrown as CliError;
    expect(cliErr.code).toBe(CLI_ERROR_CODES.HOST_INSTALL_FAILED);
    expect(cliErr.message).toContain(
      "failed to move the previous install aside",
    );
    expect(cliErr.message).toContain(
      "processes still holding the install directory: pid 4242 (claude.exe) at C:\\clients\\claude.exe",
    );
    expect(cliErr.details?.lockHolders).toEqual([
      {
        pid: 4242,
        name: "claude.exe",
        executablePath: "C:\\clients\\claude.exe",
      },
    ]);
    // The aside rename is the FIRST move - nothing has been swapped, so
    // the previous install must still be fully in place.
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-v1",
    );
  });

  it("names the lock holders when the swap-in rename fails too", async () => {
    await installVersion("v1", "1.0.0");
    mocks.forceRenameFailureForDestination = installDirFor(ENV);

    const sourceDir = join(sandboxRoot, "source-v2");
    writeLocalHostSource(sourceDir, "v2");
    let thrown: unknown;
    try {
      await installHost({
        environment: ENV,
        source: { kind: "local-file", path: sourceDir },
        onProgress: () => {},
        lifecycle: {
          beforeSwap: async () => {},
          afterSwap: async () => {},
          swapLockRecovery: {
            killLingeringProcesses: async () => {},
            describeLockHolders: async () => [
              { pid: 77, name: null, executablePath: null },
            ],
          },
        },
        recordVersionOverride: "2.0.0",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const cliErr = thrown as CliError;
    expect(cliErr.code).toBe(CLI_ERROR_CODES.HOST_INSTALL_FAILED);
    expect(cliErr.message).toContain("failed to swap staging dir into place");
    expect(cliErr.message).toContain(
      "processes still holding the install directory: pid 77",
    );
    expect(cliErr.details?.lockHolders).toEqual([
      { pid: 77, name: null, executablePath: null },
    ]);
  });

  it("gives rollback the same verified retry schedule without re-killing from compensation", async () => {
    // CodeRabbit finding on PR #829: the restore rename (trash -> target,
    // the worst failure path - it runs when the swap-in itself already
    // failed, and its own failure leaves NO install dir at all) used the
    // plain `renameWithRetry` default (~2.5s) while a comment claimed it
    // "gets the same retry" as the forward renames. Rollback now shares the
    // bounded schedule and per-attempt verifier, but deliberately does not
    // re-kill: compensation may restore old bytes, never kill another process
    // on behalf of a stale forward transaction.
    // Both the swap-in and the restore target the SAME destination
    // (`target`), so one shared call-count gate drives both: calls 1-4
    // fail, call 5+ succeeds.
    //   - swap-in: 3 calls (attempt, retry, retry) against a 2-entry test
    //     schedule - exhausts and throws, invoking the kill hook twice.
    //   - restore: call 4 fails without a kill hook, call 5 succeeds.
    // The successful fifth call distinguishes the shared test schedule from
    // a one-shot restore; the kill count pins the no-destructive-compensation
    // invariant.
    await installVersion("v1", "1.0.0");
    setSwapRenameDelaysForTests([1, 1]);
    mocks.forceRenameFailureForDestination = installDirFor(ENV);
    mocks.forceRenameFailureCode = "EBUSY";
    mocks.forceRenameFailureUntilCall = 4;
    const killAfterRenameAttempts: number[] = [];
    const kill = vi.fn(async () => {
      killAfterRenameAttempts.push(
        mocks.renameCallCountByDestination.get(installDirFor(ENV)) ?? 0,
      );
    });

    const sourceDir = join(sandboxRoot, "source-v2");
    writeLocalHostSource(sourceDir, "v2");
    let thrown: unknown;
    try {
      await installHost({
        environment: ENV,
        source: { kind: "local-file", path: sourceDir },
        onProgress: () => {},
        lifecycle: {
          beforeSwap: async () => {},
          afterSwap: async () => {},
          swapLockRecovery: {
            killLingeringProcesses: kill,
            describeLockHolders: async () => [],
          },
        },
        recordVersionOverride: "2.0.0",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).message).toContain(
      "failed to swap staging dir into place",
    );
    // The forward swap re-kills after its first and second failed attempts.
    expect(killAfterRenameAttempts.filter((attempt) => attempt < 4)).toEqual([
      1, 2,
    ]);
    // Compensation may restore old bytes but must never kill another process
    // as part of a stale forward transaction. The restore's first failure is
    // destination attempt 4; no kill may occur at or after that boundary.
    expect(killAfterRenameAttempts.filter((attempt) => attempt >= 4)).toEqual(
      [],
    );
    expect(mocks.renameCallCountByDestination.get(installDirFor(ENV))).toBe(5);
    // The restore itself succeeded (on its 2nd call) - the previous
    // install is back in place rather than stranded as `install.old-*`.
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-v1",
    );
  });

  it("gives an actionable fallback when EBUSY exhausts every retry and the scan names nothing", async () => {
    // The field cohort the scan is structurally blind to: a CWD-only
    // holder has no install path in its exe or command line, so the
    // re-kill runs on every retry, releases nothing, and the detail scan
    // comes back empty. The user must get told what actually unblocks
    // them instead of a bare errno. Production timing would sleep the
    // whole ~24s schedule here - inject a short one.
    await installVersion("v1", "1.0.0");
    setSwapRenameDelaysForTests([1, 1]);
    mocks.forceRenameFailureForDestinationPrefix = `${installDirFor(ENV)}.old-`;
    mocks.forceRenameFailureCode = "EBUSY";
    const kill = vi.fn(async () => {});

    const sourceDir = join(sandboxRoot, "source-v2");
    writeLocalHostSource(sourceDir, "v2");
    let thrown: unknown;
    try {
      await installHost({
        environment: ENV,
        source: { kind: "local-file", path: sourceDir },
        onProgress: () => {},
        lifecycle: {
          beforeSwap: async () => {},
          afterSwap: async () => {},
          swapLockRecovery: {
            killLingeringProcesses: kill,
            describeLockHolders: async () => [],
          },
        },
        recordVersionOverride: "2.0.0",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    const cliErr = thrown as CliError;
    expect(cliErr.code).toBe(CLI_ERROR_CODES.HOST_INSTALL_FAILED);
    // One re-kill per schedule entry - the retries genuinely ran.
    expect(kill).toHaveBeenCalledTimes(2);
    expect(cliErr.message).toContain(
      "no Traycer process matches the install directory",
    );
    expect(cliErr.message).toContain("restart Windows");
    expect(cliErr.details?.lockHolders).toEqual([]);
    // The previous install must survive the failed update untouched.
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-v1",
    );
  });

  it("keeps the raw error unembellished for a non-lock failure code", async () => {
    // A genuine I/O failure is not lock contention - steering the user
    // toward "close the program holding it" there would be a lie.
    await installVersion("v1", "1.0.0");
    mocks.forceRenameFailureForDestinationPrefix = `${installDirFor(ENV)}.old-`;

    const sourceDir = join(sandboxRoot, "source-v2");
    writeLocalHostSource(sourceDir, "v2");
    let thrown: unknown;
    try {
      await installHost({
        environment: ENV,
        source: { kind: "local-file", path: sourceDir },
        onProgress: () => {},
        lifecycle: {
          beforeSwap: async () => {},
          afterSwap: async () => {},
          swapLockRecovery: {
            killLingeringProcesses: async () => {},
            describeLockHolders: async () => [],
          },
        },
        recordVersionOverride: "2.0.0",
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(CliError);
    expect((thrown as CliError).message).not.toContain(
      "another program is holding it open",
    );
  });
});

describe("swap rename schedule contract", () => {
  it("stays far above the default ~2.5s retry and is never truncated by its own ceiling", () => {
    // The whole point of the schedule is outlasting AV scans and orphan
    // handle release that the previous ~2.5s budget could not - pin the
    // floor so a refactor cannot quietly regress it. The ceiling exists
    // for slow RE-KILLS, so it must clear the sleep schedule itself with
    // room for healthy (couple-of-seconds) hook passes.
    const totalDelayMs = SWAP_RENAME_DELAYS_MS.reduce((sum, d) => sum + d, 0);
    expect(totalDelayMs).toBeGreaterThanOrEqual(20_000);
    expect(SWAP_RENAME_DELAYS_MS.length).toBeGreaterThanOrEqual(7);
    expect(SWAP_RENAME_MAX_TOTAL_MS).toBeGreaterThanOrEqual(totalDelayMs * 2);
  });
});

describe("commitHostInstallSource - reconcile runs BEFORE the commit (Finding 2)", () => {
  beforeEach(() => {
    sandboxRoot = mkdtempSync(join(tmpdir(), "traycer-install-test-"));
    osHome.current = sandboxRoot;
  });

  afterEach(() => {
    mocks.forceUnlinkFailureForPath = null;
    mocks.forceRmFailureForPath = null;
    mocks.forceRenameFailureForDestination = null;
    mocks.forceRenameFailureForDestinationOnCall = null;
    mocks.renameCallCountByDestination.clear();
    rmSync(sandboxRoot, { recursive: true, force: true });
  });

  function seedRecoverableAside(version: string): string {
    // `install/` itself does NOT exist - only a valid `install.old-*`
    // aside does. `validateInstallAsideCandidate` requires `executablePath`
    // to resolve (relative to the FINAL install dir, not the aside's own
    // path) to a file that actually exists in the aside.
    const installDir = installDirFor(ENV);
    const asideDir = `${installDir}.old-1000`;
    mkdirSync(asideDir, { recursive: true });
    writeFileSync(join(asideDir, "traycer-host"), `binary-${version}`);
    writeFileSync(
      join(asideDir, "install.json"),
      JSON.stringify({
        installId: `install-${version}`,
        version,
        runtimeVersion: null,
        platform: currentInstallPlatform(),
        arch: currentInstallArch(),
        installedAt: "2026-01-01T00:00:00.000Z",
        source: { kind: "local-file", value: version },
        archiveSha256: null,
        signatureVerifiedAt: "2026-01-01T00:00:00.000Z",
        signatureKeyId: "local-file:unsigned",
        sizeBytes: 0,
        executablePath: join(installDir, "traycer-host"),
      }),
    );
    return asideDir;
  }

  function freshStagedSource(version: string): StagedHostInstallSource {
    const stagingDir = join(sandboxRoot, `fresh-staged-${version}`);
    writeLocalHostSource(stagingDir, version);
    return {
      stagingDir,
      archivePath: join(stagingDir, "archive.tar.gz"),
      archiveIsTemporary: false,
      executablePath: join(stagingDir, "traycer-host"),
      version,
      runtimeVersion: null,
      source: { kind: "local-file", value: stagingDir },
      archiveSha256: null,
      signatureVerifiedAt: new Date().toISOString(),
      signatureKeyId: "local-file:unsigned",
      sizeBytes: 0,
    };
  }

  it("restores a missing install/ from its .old-* aside before atomicSwap's entry sweep can destroy it, so a later swap failure still leaves a restorable install", async () => {
    seedRecoverableAside("1.0.0");
    expect(existsSync(installDirFor(ENV))).toBe(false);

    // Let the FIRST rename onto `install/` succeed (reconcile's own
    // target-missing recovery, restoring the aside) and force the SECOND
    // one (atomicSwap's swap-in of the fresh staged tree) to fail - the
    // exact "sweep already ran, then the new rename also failed" window
    // Finding 2 closes. Verified by temporarily reverting the fix: WITHOUT
    // it, `install/` is still missing when atomicSwap runs, so only ONE
    // rename ever targets it (the swap-in) - this gate's "fail on call 2"
    // never fires, the swap-in (call 1) succeeds using the fresh v2.0.0
    // tree, and the promise resolves instead of rejecting, failing the
    // assertion below. That divergence is itself the regression signal:
    // reconcile not running first means the entry sweep silently destroyed
    // the only recovery copy of v1.0.0 moments earlier with nothing to
    // show for it - exactly the "sweep already ran, nothing left to roll
    // back to" case Finding 2 requires never happen.
    mocks.forceRenameFailureForDestination = installDirFor(ENV);
    mocks.forceRenameFailureForDestinationOnCall = 2;

    await expect(
      commitHostInstallSource({
        environment: ENV,
        staged: freshStagedSource("2.0.0"),
        onProgress: () => {},
        lifecycle: null,
      }),
    ).rejects.toThrow();

    // With reconcile running first, `install/` already existed (restored
    // from the aside) when atomicSwap ran, so `targetExists === true`
    // meant the failed swap-in (call 2) triggered atomicSwap's own
    // rollback (`renameWithRetry(trash, target)`) - the recovered v1.0.0
    // install survives rather than being lost.
    expect(existsSync(installDirFor(ENV))).toBe(true);
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-1.0.0",
    );
    const record = await readHostInstallRecord(ENV);
    expect(record?.version).toBe("1.0.0");
  });

  it("commits the fresh staged source normally when nothing needs recovering", async () => {
    const result = await commitHostInstallSource({
      environment: ENV,
      staged: freshStagedSource("2.0.0"),
      onProgress: () => {},
      lifecycle: null,
    });

    expect(result.record.version).toBe("2.0.0");
    expect(readFileSync(join(installDirFor(ENV), "traycer-host"), "utf8")).toBe(
      "binary-2.0.0",
    );
  });

  it("cleans the staged source when pre-commit reconciliation throws", async () => {
    // A present but malformed install record makes the first reconcile throw
    // before `commitInstallFromSource` begins. The staged tree still belongs
    // to this call and must be cleaned by commitHostInstallSource's finally.
    mkdirSync(installDirFor(ENV), { recursive: true });
    writeFileSync(join(installDirFor(ENV), "install.json"), "not-json");
    const staged = freshStagedSource("2.0.0");

    await expect(
      commitHostInstallSource({
        environment: ENV,
        staged,
        onProgress: () => {},
        lifecycle: null,
      }),
    ).rejects.toMatchObject({ code: "E_HOST_INSTALL_RECORD_INVALID" });

    expect(existsSync(staged.stagingDir)).toBe(false);
  });

  // Change 12 (fixup ticket): `cleanupStagingArtifacts`'s finally-block
  // cleanup used to let a rejecting `verifyMutationCapability` throw
  // straight out of `discardStagedHostInstallSource`/`commitHostInstallSource`'s
  // `finally` - which, from a REAL `finally`, replaces whatever the caller
  // was already returning or throwing. Best-effort cleanup losing its
  // capability must degrade to "leave the leftovers for the next admitted
  // run's sweep", never surface as this call's own failure.
  it("discardStagedHostInstallSource does not throw when verifyMutationCapability rejects during cleanup, and leaves the staging dir for a later sweep", async () => {
    const staged = freshStagedSource("2.0.0");
    expect(existsSync(staged.stagingDir)).toBe(true);

    await expect(
      discardStagedHostInstallSource(ENV, staged, async () => {
        throw new Error("mutation capability lost mid-cleanup");
      }),
    ).resolves.toBeUndefined();

    // The capability loss skipped the destructive removal rather than
    // throwing through it - the staged tree is still on disk for the next
    // admitted run to sweep.
    expect(existsSync(staged.stagingDir)).toBe(true);
  });
});
