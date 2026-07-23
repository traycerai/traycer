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
      if (to === mocks.forceRenameFailureForDestination) {
        const toKey = String(to);
        const callNumber =
          (mocks.renameCallCountByDestination.get(toKey) ?? 0) + 1;
        mocks.renameCallCountByDestination.set(toKey, callNumber);
        const gate = mocks.forceRenameFailureForDestinationOnCall;
        if (gate === null || callNumber === gate) {
          // A non-retryable code so `renameWithRetry` fails on the first
          // attempt instead of spending ~2.5s retrying EBUSY/EPERM/etc.
          throw Object.assign(new Error("simulated rename failure"), {
            code: "EIO",
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
  commitHostInstallSource,
  commitInstallFromSource,
  currentInstallArch,
  currentInstallPlatform,
  installHost,
  sweepOldTrash,
  type StagedHostInstallSource,
} from "../install";
import { readHostInstallRecord } from "../../manifest/host-install";
import { createCliLogger } from "../../logger";

const ENV: Environment = "production";

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
    await sweepOldTrash(installDir, "install.json", logger);

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
});
