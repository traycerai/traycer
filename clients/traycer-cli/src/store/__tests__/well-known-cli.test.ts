import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";
import type { CliInstallSource } from "../../manifest/cli-manifest";

// `store/paths` binds its home root from `os.homedir()` at module load -
// mirror the established pattern
// (`commands/__tests__/cli-finalize-upgrade.test.ts`) so each test's dynamic
// import of `../well-known-cli` (and the `../paths` it pulls in) binds to a
// fresh tmp HOME instead of the real one.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

// `node:sea` is absent under interpreter runs (bun, tsx); `isPackagedRun` in
// `well-known-cli.ts` treats an import failure as "not packaged". Mock it
// with mutable state so individual tests can flip "packaged" on and off -
// mirrors `service/__tests__/cli-binary.test.ts`, which mocks the same
// module for the same reason.
const seaState = vi.hoisted(() => ({ current: false }));
vi.mock("node:sea", () => ({ isSea: () => seaState.current }));

// Lets the win32 publish-failure test intercept exactly ONE `rename()` call
// by its 1-based call number: the call at `failOnCallNumber` throws, and
// every other call - the rename-aside before it, the restore after it -
// delegates to the real implementation. That way the test exercises the
// module's actual on-disk recovery path rather than a fully-stubbed one.
// Every other test in this file leaves `failOnCallNumber` null, so every
// `rename()` call is a plain passthrough.
const renameControl = vi.hoisted(() => ({
  callCount: 0,
  failOnCallNumber: null as number | null,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (oldPath: PathLike, newPath: PathLike): Promise<void> => {
      renameControl.callCount += 1;
      if (renameControl.callCount === renameControl.failOnCallNumber) {
        throw new Error("simulated publish rename failure");
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ENVIRONMENT: Environment = "production";
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-cli-well-known-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  seaState.current = false;
  renameControl.callCount = 0;
  renameControl.failOnCallNumber = null;
  vi.resetModules();
});

afterEach(() => {
  if (ORIGINAL_HOME === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = ORIGINAL_HOME;
  }
  if (ORIGINAL_USERPROFILE === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = ORIGINAL_USERPROFILE;
  }
  rmSync(workHome, { recursive: true, force: true });
});

describe("wellKnownCliBinaryPath", () => {
  it("resolves to <cliInstallHomeDir>/bin/traycer[.exe]", async () => {
    const { wellKnownCliBinaryPath } = await import("../well-known-cli");
    const { cliInstallHomeDir } = await import("../paths");
    const expectedBasename =
      process.platform === "win32" ? "traycer.exe" : "traycer";
    expect(wellKnownCliBinaryPath(ENVIRONMENT)).toBe(
      join(cliInstallHomeDir(ENVIRONMENT), "bin", expectedBasename),
    );
  });
});

describe("isInterpreterDistribution", () => {
  // One row per CliInstallSource. `writeMarkSource`
  // (commands/cli-mark-source.ts) and `resolveServiceCliInvocation`
  // (service/cli-binary.ts) both gate slot-staging on this single
  // predicate - the completeness check below fails the moment
  // VALID_CLI_INSTALL_SOURCES gains a source without a matching row here,
  // rather than letting a new source silently default to "not an
  // interpreter" and stage a slot for it sight unseen.
  const CASES: ReadonlyArray<{
    readonly source: CliInstallSource;
    readonly interpreter: boolean;
  }> = [
    { source: "npm", interpreter: true },
    { source: "homebrew", interpreter: false },
    { source: "desktop", interpreter: false },
    { source: "manual", interpreter: false },
    { source: "apt", interpreter: false },
    { source: "rpm", interpreter: false },
    { source: "winget", interpreter: false },
    { source: "scoop", interpreter: false },
  ];

  it.each(CASES)(
    "returns $interpreter for source=$source",
    async ({ source, interpreter }) => {
      const { isInterpreterDistribution } = await import("../well-known-cli");
      expect(isInterpreterDistribution(source)).toBe(interpreter);
    },
  );

  it("covers every source in VALID_CLI_INSTALL_SOURCES - a new source there needs a row above", async () => {
    const { VALID_CLI_INSTALL_SOURCES } =
      await import("../../manifest/cli-manifest");
    const coveredSources = new Set(CASES.map((row) => row.source));
    expect(coveredSources).toEqual(new Set(VALID_CLI_INSTALL_SOURCES));
  });
});

describe("stageWellKnownCliBinary", () => {
  it("stages a regular-file copy of the binary's bytes at the well-known path", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const target = join(workHome, "real-binary");
    writeFileSync(target, "binary-one");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: target,
    });

    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    expect(result).toEqual({ staged: "staged", wellKnownPath });
    const stat = await lstat(wellKnownPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    // The POSIX chmod branch never runs on win32 - Windows has no
    // equivalent notion of an 0o755 mode bit.
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o755);
    }
    expect(readFileSync(wellKnownPath, "utf8")).toBe("binary-one");
  });

  it("re-staging over an already-staged slot replaces its bytes with the second binary's", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const first = join(workHome, "binary-one");
    const second = join(workHome, "binary-two");
    writeFileSync(first, "binary-one");
    writeFileSync(second, "binary-two");

    const firstResult = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: first,
    });
    expect(firstResult.staged).toBe("staged");

    const secondResult = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: second,
    });

    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    expect(secondResult).toEqual({ staged: "staged", wellKnownPath });
    expect(readFileSync(wellKnownPath, "utf8")).toBe("binary-two");
  });

  it("replaces an existing unrelated regular file at the well-known path with the staged bytes", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "stale copy");
    const target = join(workHome, "real-binary");
    writeFileSync(target, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: target,
    });

    expect(result).toEqual({ staged: "staged", wellKnownPath });
    const stat = await lstat(wellKnownPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(readFileSync(wellKnownPath, "utf8")).toBe("binary bytes");
  });

  // Windows symlink creation needs Developer Mode (or an elevated prompt),
  // which CI runners don't grant - `symlinkSync` itself would throw before
  // the behavior under test ever runs.
  it.skipIf(process.platform === "win32")(
    "upgrades a legacy symlink at the well-known path to a regular-file copy (rename swallows the old symlink)",
    async () => {
      const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
        await import("../well-known-cli");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(dirname(wellKnownPath), { recursive: true });
      // A leftover symlink from a pre-copy install, pointing anywhere - the
      // rename-into-place must replace it outright, not follow or preserve it.
      symlinkSync(join(workHome, "nonexistent-legacy-target"), wellKnownPath);
      const target = join(workHome, "real-binary");
      writeFileSync(target, "binary bytes");

      const result = await stageWellKnownCliBinary({
        environment: ENVIRONMENT,
        binaryPath: target,
      });

      expect(result).toEqual({ staged: "staged", wellKnownPath });
      const stat = await lstat(wellKnownPath);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(readFileSync(wellKnownPath, "utf8")).toBe("binary bytes");
    },
  );

  it("returns already-well-known when binaryPath equals the well-known path, without re-staging it", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "the real binary");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: wellKnownPath,
    });

    expect(result).toEqual({ staged: "already-well-known", wellKnownPath });
    const stat = await lstat(wellKnownPath);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(stat.isFile()).toBe(true);
    expect(readFileSync(wellKnownPath, "utf8")).toBe("the real binary");
  });

  it("returns a failed outcome without throwing when the well-known slot's parent cannot be created", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { cliInstallHomeDir } = await import("../paths");
    const parentDir = cliInstallHomeDir(ENVIRONMENT);
    const binDirPath = join(parentDir, "bin");
    // A REGULAR FILE at the parent dir path (`bin`) makes
    // `mkdir(dirname(wellKnownPath), { recursive: true })` fail.
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(binDirPath, "not a directory");
    const target = join(workHome, "real-binary");
    writeFileSync(target, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: target,
    });

    expect(result.staged).toBe("failed");
    if (result.staged === "failed") {
      expect(result.wellKnownPath).toBe(wellKnownCliBinaryPath(ENVIRONMENT));
      expect(result.errorName.length).toBeGreaterThan(0);
      expect(result.errorMessage.length).toBeGreaterThan(0);
    }
  });

  it("leaves no .staging- leftovers behind after a failure", async () => {
    const { stageWellKnownCliBinary } = await import("../well-known-cli");
    const { cliInstallHomeDir } = await import("../paths");
    const parentDir = cliInstallHomeDir(ENVIRONMENT);
    const binDirPath = join(parentDir, "bin");
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(binDirPath, "not a directory");
    const target = join(workHome, "real-binary");
    writeFileSync(target, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: target,
    });

    expect(result.staged).toBe("failed");
    if (existsSync(parentDir)) {
      const entries = readdirSync(parentDir);
      expect(entries.some((entry) => entry.includes(".staging-"))).toBe(false);
    }
  });

  // Windows-only recovery path: `stageWellKnownCliBinary` renames a
  // pre-existing slot binary ASIDE before publishing the new one (a running
  // image blocks delete/overwrite but permits being renamed itself). If the
  // publish rename then fails - antivirus holding the staged file, a racing
  // installer, a transient share violation - the aside binary must be moved
  // BACK so an already-registered service keeps launching the CLI it was
  // launching before this attempt, never landing on "slot absent".
  it("restores the original slot bytes when the win32 publish rename fails after the rename-aside succeeded", async () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    if (platformDescriptor === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", {
      value: "win32",
      configurable: true,
    });
    // Call #1 is the rename-aside (real move); call #2 is the publish,
    // which must fail here. Any further call (the failure-path restore)
    // is left un-intercepted and delegates to the real implementation.
    renameControl.failOnCallNumber = 2;
    try {
      const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
        await import("../well-known-cli");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(dirname(wellKnownPath), { recursive: true });
      const originalBytes = "original slot bytes";
      writeFileSync(wellKnownPath, originalBytes);
      const target = join(workHome, "new-binary");
      writeFileSync(target, "new binary bytes that must never publish");

      const result = await stageWellKnownCliBinary({
        environment: ENVIRONMENT,
        binaryPath: target,
      });

      expect(result.staged).toBe("failed");
      if (result.staged === "failed") {
        expect(result.wellKnownPath).toBe(wellKnownPath);
        expect(result.errorName.length).toBeGreaterThan(0);
        expect(result.errorMessage.length).toBeGreaterThan(0);
      }
      const stat = await lstat(wellKnownPath);
      expect(stat.isSymbolicLink()).toBe(false);
      expect(stat.isFile()).toBe(true);
      expect(readFileSync(wellKnownPath, "utf8")).toBe(originalBytes);
      // The restore MOVES the aside file back rather than copying it, so
      // no `.old-*` leftover should remain once it succeeds.
      const leftovers = readdirSync(dirname(wellKnownPath)).filter((entry) =>
        entry.includes(".old-"),
      );
      expect(leftovers).toEqual([]);
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      renameControl.callCount = 0;
      renameControl.failOnCallNumber = null;
    }
  });

  // Sweep tests exercise `sweepSlotLeftovers` indirectly through
  // `stageWellKnownCliBinary`, which is its only caller - see the sweep's
  // own doc comment in well-known-cli.ts for why `.staging-` orphans get
  // age-gated treatment while `.old-` ones are swept on sight.
  it("removes a .staging- orphan older than the 1 hour cutoff during the next staging", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const orphanPath = `${wellKnownPath}.staging-77777-killed-attempt`;
    writeFileSync(orphanPath, "half-copied leftover from a killed staging");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(orphanPath, old, old);
    const source = join(workHome, "real-binary");
    writeFileSync(source, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    expect(existsSync(orphanPath)).toBe(false);
  });

  it("does not remove a FRESH .staging- orphan, which may belong to a live concurrent writer", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const orphanPath = `${wellKnownPath}.staging-88888-concurrent-writer`;
    writeFileSync(orphanPath, "in-flight copy from another installer");
    const source = join(workHome, "real-binary");
    writeFileSync(source, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    expect(existsSync(orphanPath)).toBe(true);
  });

  it("stages successfully with both a stale and a fresh .staging- orphan present, landing the new bytes", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const staleOrphan = `${wellKnownPath}.staging-11111-stale`;
    writeFileSync(staleOrphan, "stale orphan");
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(staleOrphan, old, old);
    const freshOrphan = `${wellKnownPath}.staging-22222-fresh`;
    writeFileSync(freshOrphan, "fresh orphan");
    const source = join(workHome, "real-binary");
    const sourceBytes = "the newly staged binary bytes";
    writeFileSync(source, sourceBytes);

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    // The sweep also runs against the current invocation's OWN staging
    // file, skipped by name rather than by age - a successful stage with
    // unrelated orphans present is proof it never mistook its own
    // in-flight copy for one of them.
    expect(result.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(sourceBytes);
    expect(existsSync(staleOrphan)).toBe(false);
    expect(existsSync(freshOrphan)).toBe(true);
  });
});

// `refreshWellKnownSlotIfStale` takes only the environment: it decides for
// itself which binary the slot should hold (the CLI manifest when one names
// an executable, otherwise the running process), so these tests drive it by
// stubbing `process.execPath` and by writing real manifests.
function withExecPath<T>(execPath: string, run: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, "execPath");
  if (original === undefined) {
    throw new Error("process.execPath descriptor missing");
  }
  Object.defineProperty(process, "execPath", {
    value: execPath,
    configurable: true,
    writable: true,
  });
  return run().finally(() => {
    Object.defineProperty(process, "execPath", original);
  });
}

// The identity staging writes: same bytes AND the source's mtime mirrored
// onto the copy. Tests that want a slot the refresh should consider FRESH
// build it this way rather than hand-setting timestamps.
function seedMirroredSlot(slotPath: string, source: string): void {
  mkdirSync(dirname(slotPath), { recursive: true });
  writeFileSync(slotPath, readFileSync(source));
  const sourceStat = statSync(source);
  utimesSync(slotPath, sourceStat.atime, sourceStat.mtime);
}

describe("refreshWellKnownSlotIfStale", () => {
  it("not packaged: returns null and leaves an existing stale slot's bytes untouched", async () => {
    // seaState.current stays false (the beforeEach default), so this
    // exercises isPackagedRun()'s real "not packaged" answer - the guard
    // that stops any suite (or a plain dev invocation) from ever
    // overwriting a developer's real `~/.traycer` slot.
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const staleBytes = "stale slot bytes that must survive untouched";
    writeFileSync(wellKnownPath, staleBytes);
    const running = join(workHome, "running-binary");
    writeFileSync(running, "a completely different running binary payload");

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe(staleBytes);
  });

  // An absent slot on a machine whose service is already registered against
  // that path is a BROKEN machine, not a clean one - the service and the
  // host daemon both launch from it. Repairing beats waiting for a
  // re-registration that a hookless channel never performs.
  it("packaged, slot absent: recreates it from the running binary", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    const running = join(workHome, "running-binary");
    writeFileSync(running, "running binary bytes");

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe("running binary bytes");
  });

  it("packaged, slot already mirrors the running binary: returns null", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    const running = join(workHome, "running-binary");
    writeFileSync(running, "matching binary bytes");
    seedMirroredSlot(wellKnownPath, running);

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe("matching binary bytes");
  });

  it("packaged, running binary differs in size: re-stages", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "short");
    const running = join(workHome, "running-binary");
    const runningBytes = "a much longer running binary payload";
    writeFileSync(running, runningBytes);

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(runningBytes);
  });

  // The case a "is the slot newer than the source?" test could never see: a
  // package manager that preserves archive timestamps ships a same-sized
  // binary whose mtime is OLDER than the slot's. Mirroring makes it a plain
  // mismatch.
  it("packaged, same size but an OLDER source mtime: still re-stages", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "AAAAAAAAAA");
    const running = join(workHome, "running-binary");
    writeFileSync(running, "BBBBBBBBBB");
    const base = Date.now();
    utimesSync(wellKnownPath, new Date(base), new Date(base));
    utimesSync(running, new Date(base - 120_000), new Date(base - 120_000));

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe("BBBBBBBBBB");
  });

  it("packaged, the running binary IS the slot: returns null", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const bytes = "the well-known binary itself";
    writeFileSync(wellKnownPath, bytes);

    const result = await withExecPath(wellKnownPath, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe(bytes);
  });

  // Manifest precedence. Without it, a machine with two packaged CLIs
  // installed would let whichever one the user happened to invoke overwrite
  // the shared slot - silently repointing the registered service and the
  // host daemon at a possibly OLDER binary.
  it("packaged: stages the MANIFEST's binary, not the running one", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "stale slot bytes");
    const anchored = join(workHome, "anchored-binary");
    writeFileSync(anchored, "the anchored homebrew binary");
    const running = join(workHome, "other-binary");
    writeFileSync(running, "some other packaged CLI that was invoked");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.2.3",
      installedAt: new Date(0).toISOString(),
      binaryPath: anchored,
      source: "homebrew",
      pendingUpgrade: null,
    });

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "the anchored homebrew binary",
    );
  });

  it("packaged: an npm manifest nominates no source, so the slot is left alone", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "previously anchored executable");
    const bundle = join(workHome, "npm-bundle.js");
    writeFileSync(bundle, "#!/usr/bin/env node\nconsole.log('cli');");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.2.3",
      installedAt: new Date(0).toISOString(),
      binaryPath: bundle,
      source: "npm",
      pendingUpgrade: null,
    });

    const result = await withExecPath(bundle, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "previously anchored executable",
    );
  });

  it("staging mirrors the source's mtime onto the slot, which is what makes freshness decidable", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const source = join(workHome, "real-binary");
    writeFileSync(source, "binary bytes");
    const past = new Date(Date.now() - 300_000);
    utimesSync(source, past, past);

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    // Date precision, matching how staging writes it: `utimes` cannot
    // carry the source's sub-millisecond digits, so this is the identity
    // `mirrors()` actually compares.
    const slotStat = statSync(wellKnownCliBinaryPath(ENVIRONMENT));
    expect(slotStat.mtime.getTime()).toBe(statSync(source).mtime.getTime());
  });
});
