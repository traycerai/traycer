import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
// A deliberately far-future, arbitrary timestamp the copyFile race mock
// below stamps onto its replacement file. The race test tells "mirrored"
// from "not mirrored" by comparing the slot's mtime against this fixed
// value rather than against a second live `Date.now()` read - two
// independent "now" timestamps taken milliseconds apart can otherwise round
// to the exact same millisecond and make the assertion flaky regardless of
// which way the production code behaves.
const RACE_REPLACEMENT_MTIME = vi.hoisted(
  () => new Date("2099-06-15T12:00:00.000Z"),
);
// Lets the mtime-mirroring race test (Fix 2: `stageWellKnownCliBinary` stats
// `source` on BOTH sides of the copy) intercept exactly one `copyFile` call
// by its `src` path. After performing the REAL copy - so the staged file
// gets the ORIGINAL bytes, exactly like a copy that started just before an
// installer landed - it atomically replaces the source out from under it
// (write to a sibling temp path, stamp it with the distinctive mtime above,
// then `rename` over the source), which changes ino/dev/mtimeMs the same
// way a package manager's atomic install would. Cleared after it fires once
// so it never fires for any OTHER `copyFile` call in the same or a later
// test. Every other test in this file leaves `raceSourcePath` null, so
// every `copyFile` call is a plain passthrough.
const copyFileControl = vi.hoisted(() => ({
  raceSourcePath: null as string | null,
}));
// Lets the mtime-reproducibility probe test (`canReproduceMtime`) simulate a
// filesystem that cannot mirror timestamps at all - `utimes` unsupported, or
// coarser granularity than the source's - by making every `utimes` call a
// pure no-op: it resolves without touching the target, so the probe file
// keeps whatever mtime `writeFile` gave it and the round-trip comparison
// fails exactly like it would on such a filesystem. A control flag cleared
// in `beforeEach`, same as the controls above, so it can never leak into
// another test's real `utimes` calls - including `stageWellKnownCliBinary`'s
// own mtime-mirroring step, which every "stages successfully" test in this
// file depends on.
const utimesControl = vi.hoisted(() => ({ noop: false }));
// Lets the manifest-binary-stat-fault test intercept `stat` for exactly one
// path - the manifest's nominated binary - and throw a non-ENOENT error
// (EACCES), passthrough for every other path. `null` (the `beforeEach`
// default) means no interception at all.
const statControl = vi.hoisted(() => ({
  failEaccesForPath: null as string | null,
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
    copyFile: async (src: PathLike, dest: PathLike): Promise<void> => {
      await actual.copyFile(src, dest);
      if (src !== copyFileControl.raceSourcePath) return;
      const racedPath = copyFileControl.raceSourcePath;
      copyFileControl.raceSourcePath = null;
      const replacement = `${racedPath}.race-replacement`;
      await actual.writeFile(
        replacement,
        "bytes from a racing installer that replaced the source mid-copy",
      );
      await actual.utimes(
        replacement,
        RACE_REPLACEMENT_MTIME,
        RACE_REPLACEMENT_MTIME,
      );
      await actual.rename(replacement, racedPath);
    },
    utimes: async (
      path: PathLike,
      atime: string | number | Date,
      mtime: string | number | Date,
    ): Promise<void> => {
      if (utimesControl.noop) return;
      await actual.utimes(path, atime, mtime);
    },
    stat: async (path: PathLike) => {
      if (
        statControl.failEaccesForPath !== null &&
        path === statControl.failEaccesForPath
      ) {
        throw Object.assign(
          new Error("simulated EACCES reading manifest binary"),
          { code: "EACCES" },
        );
      }
      return actual.stat(path);
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
  copyFileControl.raceSourcePath = null;
  utimesControl.noop = false;
  statControl.failEaccesForPath = null;
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
  // own doc comment in well-known-cli.ts for the full reasoning. Both the
  // `.staging-` and `.old-` prefixes are age-gated, on different clocks: a
  // `.staging-` orphan's age comes from `stat`, but an `.old-` aside's age
  // comes from the timestamp encoded in its NAME - a rename doesn't change
  // mtime, and staging mirrors the source binary's mtime onto the slot, so
  // an aside file's mtime is its binary's timestamp, not the rename's.
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

  // Aside-sweep tests exercise the SAME sweep, but the age comes from the
  // timestamp encoded in the `.old-` name rather than from `stat` - see
  // `asideStampedAt`'s doc comment for why a rename can't be aged via mtime.
  it("does not remove a FRESH .old- aside, which may still be the slot's only rollback copy", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const asidePath = `${wellKnownPath}.old-${Date.now()}-4242`;
    writeFileSync(asidePath, "rollback copy from an in-flight rename-aside");
    // Deliberately give this FRESH aside an OLD mtime. Age is read from the
    // NAME's embedded Date.now(), never from `stat` - a rename doesn't
    // change mtime, and staging mirrors the source binary's own mtime onto
    // the slot, so an aside's real mtime is its binary's timestamp and
    // would misread as ancient if the sweep ever consulted it. This file
    // surviving the sweep is proof the code reads the name, not the mtime.
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(asidePath, old, old);
    const source = join(workHome, "real-binary");
    writeFileSync(source, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    expect(existsSync(asidePath)).toBe(true);
  });

  it("removes a STALE .old- aside past the 5 minute inflight window", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const asidePath = `${wellKnownPath}.old-${Date.now() - 10 * 60 * 1000}-4242`;
    writeFileSync(asidePath, "aside left behind by a publish that finished");
    const source = join(workHome, "real-binary");
    writeFileSync(source, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    expect(existsSync(asidePath)).toBe(false);
  });

  it("removes an unstamped legacy .old- aside whose name predates the stamp convention", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const asidePath = `${wellKnownPath}.old-legacy-name`;
    writeFileSync(asidePath, "aside with no parseable timestamp in its name");
    const source = join(workHome, "real-binary");
    writeFileSync(source, "binary bytes");

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    expect(existsSync(asidePath)).toBe(false);
  });

  // Regression test: on a FROM-SCRATCH install nothing under the CLI
  // install home exists yet, so this call is the first writer of the whole
  // `~/.traycer/cli` chain. A bare `mkdir(dirname(wellKnownPath), {
  // recursive: true })` (no explicit mode) would create that entire chain
  // at the process umask - typically 0o755 - leaving the install home
  // world-traversable for the life of the install. `stageWellKnownCliBinary`
  // creates the install home through `ensureCliInstallHomeDir` BEFORE the bin
  // directory, so both must land at 0o700 even though this single invocation
  // created every directory in the chain.
  it.skipIf(process.platform === "win32")(
    "creates the CLI install home directory (and its bin subdir) at mode 0o700 when nothing under it exists yet",
    async () => {
      const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
        await import("../well-known-cli");
      const { cliInstallHomeDir } = await import("../paths");
      const target = join(workHome, "real-binary");
      writeFileSync(target, "binary bytes");

      const result = await stageWellKnownCliBinary({
        environment: ENVIRONMENT,
        binaryPath: target,
      });

      expect(result.staged).toBe("staged");
      const installHomeDir = cliInstallHomeDir(ENVIRONMENT);
      expect(statSync(installHomeDir).mode & 0o777).toBe(0o700);
      const binDir = dirname(wellKnownCliBinaryPath(ENVIRONMENT));
      expect(statSync(binDir).mode & 0o777).toBe(0o700);
    },
  );

  // The population the test above CANNOT reach, and the one that matters
  // more: a machine that already has a CLI install. `mkdir` applies its mode
  // only to directories it actually creates, so on every pre-existing install
  // - anything staged before the 0o700 default, or a home Desktop created
  // first at the process umask - the mode is whatever the first writer chose
  // and a create-only fix never touches it. Since that directory holds the
  // credentials file, hardening only fresh machines would leave the users who
  // already have credentials on disk exactly where they were.
  it.skipIf(process.platform === "win32")(
    "repairs an EXISTING install home and bin directory from 0o755 to 0o700",
    async () => {
      const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
        await import("../well-known-cli");
      const { cliInstallHomeDir } = await import("../paths");
      const installHomeDir = cliInstallHomeDir(ENVIRONMENT);
      const binDir = dirname(wellKnownCliBinaryPath(ENVIRONMENT));
      mkdirSync(binDir, { recursive: true });
      // Pre-existing install, world-traversable, exactly as an older CLI (or
      // a bare umask-mode mkdir) would have left it.
      chmodSync(installHomeDir, 0o755);
      chmodSync(binDir, 0o755);
      const target = join(workHome, "real-binary");
      writeFileSync(target, "binary bytes");

      const result = await stageWellKnownCliBinary({
        environment: ENVIRONMENT,
        binaryPath: target,
      });

      expect(result.staged).toBe("staged");
      expect(statSync(installHomeDir).mode & 0o777).toBe(0o700);
      expect(statSync(binDir).mode & 0o777).toBe(0o700);
    },
  );
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

  // A filesystem that cannot store the mtime staging mirrors onto the slot -
  // no `utimes` support, or coarser granularity - simulated by making
  // `utimes` a no-op. Timestamps alone can never prove freshness there, so
  // the guarantee has to come from the staging RECORD instead.
  //
  // The property that matters is the second call, not the first. Staging
  // once is correct and unavoidable: with no record and no usable timestamp
  // the slot cannot be shown to be current. What must not happen is staging
  // AGAIN, which on such a machine would re-copy the whole binary on every
  // command forever. The record written by the first stage is what stops it,
  // and it does so without depending on the filesystem at all.
  it("packaged, this filesystem cannot reproduce mtimes: stages once, then the staging record keeps it from re-copying", async () => {
    seaState.current = true;
    utimesControl.noop = true;
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

    const first = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(first?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe("BBBBBBBBBB");

    const second = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(second).toBeNull();
  });

  // The direction the record must NOT lose: a same-size replacement whose
  // mtime is OLDER than the copy already in the slot. This is the case the
  // whole identity scheme exists for - it is invisible to "is the slot
  // newer?", and on a filesystem that cannot mirror timestamps it is
  // invisible to any timestamp comparison at all. The record catches it
  // because it stores the source's mtime as a number this module chose,
  // rather than one the filesystem has to reproduce.
  it("packaged, cannot reproduce mtimes, and the source is REPLACED by a same-size older file: re-stages", async () => {
    seaState.current = true;
    utimesControl.noop = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "AAAAAAAAAA");
    const running = join(workHome, "running-binary");
    writeFileSync(running, "BBBBBBBBBB");
    const base = Date.now();
    utimesSync(running, new Date(base - 120_000), new Date(base - 120_000));

    await withExecPath(running, () => refreshWellKnownSlotIfStale(ENVIRONMENT));
    expect(readFileSync(wellKnownPath, "utf8")).toBe("BBBBBBBBBB");

    // Same length, older timestamp, different bytes.
    writeFileSync(running, "CCCCCCCCCC");
    utimesSync(running, new Date(base - 600_000), new Date(base - 600_000));

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe("CCCCCCCCCC");
  });

  // The shape no metadata comparison can see, and the reason the record
  // stores inode identity rather than only size and mtime.
  //
  // This is a REAL upgrade shape, not a contrived one: rpm and dpkg both
  // restore the archive's recorded mtime onto the file they install, and two
  // builds of the same SEA routinely pad to the same length - so a same-size
  // upgrade can reproduce BOTH numbers the record used to hold. Everything
  // here is arranged to make that happen deliberately: identical length,
  // identical mtime pinned onto the replacement, published by `rename` the
  // way every package manager installs. Only `ino`/`dev` differ, and if the
  // record does not carry them the slot is declared current forever and the
  // service stays on the previous CLI.
  it.skipIf(process.platform === "win32")(
    "packaged, the source is atomically replaced by a same-size file carrying the SAME mtime: re-stages",
    async () => {
      seaState.current = true;
      const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
        await import("../well-known-cli");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(dirname(wellKnownPath), { recursive: true });
      writeFileSync(wellKnownPath, "AAAAAAAAAA");
      const running = join(workHome, "running-binary");
      writeFileSync(running, "BBBBBBBBBB");
      const pinned = new Date(Date.now() - 120_000);
      utimesSync(running, pinned, pinned);

      const first = await withExecPath(running, () =>
        refreshWellKnownSlotIfStale(ENVIRONMENT),
      );
      expect(first?.staged).toBe("staged");
      expect(readFileSync(wellKnownPath, "utf8")).toBe("BBBBBBBBBB");
      const staged = statSync(running);

      // An atomic install: different bytes, same length, the same mtime
      // restored onto the new file, published over the old one by `rename`.
      const incoming = `${running}.incoming`;
      writeFileSync(incoming, "CCCCCCCCCC");
      utimesSync(incoming, pinned, pinned);
      renameSync(incoming, running);

      // The premise of the test: everything the record compared BEFORE this
      // change still matches, so a size/mtime test cannot tell the
      // replacement happened. If any of these drift the assertion below would
      // pass for the wrong reason. Compared against the staged file's own
      // observed `mtimeMs` rather than `pinned.getTime()`: the filesystem
      // keeps nanoseconds and reconstructs a float a hair below the integer
      // millisecond, so the round-tripped value is what both the record and
      // the freshness check actually see.
      const replaced = statSync(running);
      expect(replaced.size).toBe(staged.size);
      expect(replaced.mtimeMs).toBe(staged.mtimeMs);
      expect(replaced.ino).not.toBe(staged.ino);

      const result = await withExecPath(running, () =>
        refreshWellKnownSlotIfStale(ENVIRONMENT),
      );

      expect(result?.staged).toBe("staged");
      expect(readFileSync(wellKnownPath, "utf8")).toBe("CCCCCCCCCC");
    },
  );

  // A record written by a CLI predating `sourceIno`/`sourceDev` must be
  // REJECTED rather than honoured on the fields it does carry - honouring it
  // would silently keep every already-installed machine on the weaker test
  // this change exists to replace, which is the population most likely to
  // meet a same-size upgrade.
  //
  // Rejection is observable only where the fallback disagrees with the
  // record, so `utimes` is stubbed out: the slot's mtime never mirrors the
  // source, `mirrors` therefore cannot prove freshness, and re-staging is
  // proof the stale record was discarded. Honouring it would return null.
  it("packaged: a staging record without inode identity is discarded, not trusted", async () => {
    seaState.current = true;
    utimesControl.noop = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "AAAAAAAAAA");
    const running = join(workHome, "running-binary");
    writeFileSync(running, "BBBBBBBBBB");
    // Distinct mtimes, so the first refresh definitely stages. Two files
    // written microseconds apart otherwise share a millisecond, `mirrors`
    // reports the slot already faithful, and nothing is staged at all - which
    // would leave no record to downgrade and pass the null check below for
    // entirely the wrong reason.
    const base = Date.now();
    utimesSync(wellKnownPath, new Date(base), new Date(base));
    utimesSync(running, new Date(base - 120_000), new Date(base - 120_000));

    const staged = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );
    expect(staged?.staged).toBe("staged");
    // Precondition: with the CURRENT record in place this slot is fresh, so
    // the re-stage asserted below can only come from the record being
    // discarded - not from the slot having been stale all along.
    expect(
      await withExecPath(running, () =>
        refreshWellKnownSlotIfStale(ENVIRONMENT),
      ),
    ).toBeNull();

    // Downgrade the record in place to the older format.
    const recordPath = `${wellKnownPath}.source.json`;
    const current: unknown = JSON.parse(readFileSync(recordPath, "utf8"));
    if (current === null || typeof current !== "object") {
      throw new Error("staging record is not an object");
    }
    const { sourceIno, sourceDev, ...legacy } = current as Record<
      string,
      unknown
    >;
    expect(sourceIno).toBeTypeOf("number");
    expect(sourceDev).toBeTypeOf("number");
    writeFileSync(recordPath, `${JSON.stringify(legacy)}\n`);

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
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

  // The P1 this fix exists for: `process.execPath` IS the well-known slot
  // (the Desktop / already-registered-service case), which used to be an
  // unconditional "nothing to do" returned BEFORE the manifest was ever
  // read. If a manifest has since been anchored to a DIFFERENT executable
  // (e.g. `cli re-anchor`, or a homebrew upgrade whose formula writes a new
  // keg path), the slot must follow the manifest - otherwise the machine
  // stays pinned to the stale binary under the slot forever, because the
  // "running IS slot" fast path never lets the manifest disagree.
  it("packaged, running binary IS the slot, but the manifest names a different existing binary: re-stages from the manifest's binary", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(
      wellKnownPath,
      "stale bytes pinned forever under the old code",
    );
    const anchoredElsewhere = join(workHome, "anchored-binary-b");
    writeFileSync(anchoredElsewhere, "binary B - the manifest's real anchor");
    await writeCliManifest(ENVIRONMENT, {
      version: "2.0.0",
      installedAt: new Date(0).toISOString(),
      binaryPath: anchoredElsewhere,
      source: "homebrew",
      pendingUpgrade: null,
    });

    // process.execPath IS the well-known slot itself - the fast path that
    // used to short-circuit BEFORE the manifest was ever consulted.
    const result = await withExecPath(wellKnownPath, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "binary B - the manifest's real anchor",
    );
  });

  // Sibling P1 case: the slot is not the running binary itself, but a
  // faithful COPY of it (an ordinary staged install). That copy used to be
  // enough to short-circuit before the manifest was consulted too - so a
  // manifest anchored to yet another binary was silently ignored for as
  // long as the running process kept matching what it had last staged.
  it("packaged, slot mirrors the running binary, but the manifest names a different existing binary: re-stages from the manifest's binary", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    const running = join(workHome, "running-binary-a");
    writeFileSync(running, "binary A - the running process");
    seedMirroredSlot(wellKnownPath, running);
    const anchoredElsewhere = join(workHome, "anchored-binary-b");
    writeFileSync(
      anchoredElsewhere,
      "binary B - the manifest's real anchor, a different length than A",
    );
    await writeCliManifest(ENVIRONMENT, {
      version: "2.0.0",
      installedAt: new Date(0).toISOString(),
      binaryPath: anchoredElsewhere,
      source: "homebrew",
      pendingUpgrade: null,
    });

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "binary B - the manifest's real anchor, a different length than A",
    );
  });

  // Still-null case that specifically exercises the guard via the MANIFEST
  // (rather than via the no-manifest fallback that other tests above already
  // cover): the manifest itself names the well-known slot as the anchor, so
  // there is nothing to re-stage even though the running process is a third,
  // unrelated binary.
  it("packaged, manifest's binaryPath resolves to the well-known slot itself: returns null", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const bytes = "the slot, anchored by its own manifest entry";
    writeFileSync(wellKnownPath, bytes);
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date(0).toISOString(),
      binaryPath: wellKnownPath,
      source: "desktop",
      pendingUpgrade: null,
    });
    const running = join(workHome, "some-other-running-binary");
    writeFileSync(running, "a totally different running process");

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe(bytes);
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

  // Fix 2's negative direction: `stageWellKnownCliBinary` now stats `source`
  // on BOTH sides of the copy, and only mirrors the source's mtime onto the
  // staged file when the two stats say the source did NOT change. Simulate a
  // package manager atomically replacing the source mid-copy (real copy,
  // then a sibling-temp-file `rename` over the source, which changes
  // ino/dev/mtimeMs) and confirm the slot's mtime does NOT end up equal to
  // the (new) source's mtime - without this the staged copy would wear a
  // stale bytes/fresh-looking-mtime combination that `refreshWellKnownSlotIfStale`
  // could never detect again.
  it("does not mirror the source's mtime onto the slot when the source is atomically replaced between the copy and the post-copy stat", async () => {
    const { stageWellKnownCliBinary, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const source = join(workHome, "real-binary-race");
    const originalBytes = "original binary bytes before the race";
    writeFileSync(source, originalBytes);
    const past = new Date(Date.now() - 300_000);
    utimesSync(source, past, past);
    copyFileControl.raceSourcePath = source;

    const result = await stageWellKnownCliBinary({
      environment: ENVIRONMENT,
      binaryPath: source,
    });

    expect(result.staged).toBe("staged");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    // The copy captured the ORIGINAL bytes - it ran before the replace.
    expect(readFileSync(wellKnownPath, "utf8")).toBe(originalBytes);
    const replacedSourceStat = statSync(source);
    // Sanity check that the race actually fired: the source now carries the
    // mock's distinctive far-future mtime, not the "past" one this test
    // originally set on it.
    expect(replacedSourceStat.mtime.getTime()).toBe(
      RACE_REPLACEMENT_MTIME.getTime(),
    );
    const slotStat = statSync(wellKnownPath);
    // The slot must NOT have been mirrored onto that distinctive value - it
    // keeps its own fresh "staged just now" mtime instead. Comparing against
    // a fixed far-future value (rather than a second live `Date.now()` read)
    // means this can never coincidentally pass just because two independent
    // clock reads landed in the same millisecond.
    expect(slotStat.mtime.getTime()).not.toBe(RACE_REPLACEMENT_MTIME.getTime());
    // Nor may it have been mirrored onto the PRE-copy "past" mtime either -
    // that would mean staging re-used its before-the-copy stat instead of
    // re-statting `source` afterward, which is precisely the single-stat bug
    // Fix 2 replaces (a `sourceAfter` that silently reuses `sourceBefore`
    // would pass the `isSameFile` check trivially and mirror this "past"
    // value, even though the bytes it actually copied were the source's
    // ORIGINAL ones and the source has since moved on to the replacement).
    expect(slotStat.mtime.getTime()).not.toBe(past.getTime());
  });

  // The same race, followed through to the staging RECORD - which is now the
  // authority `refreshWellKnownSlotIfStale` consults first, so leaving the
  // mtime un-mirrored is no longer sufficient on its own.
  //
  // A record written here would describe the REPLACEMENT (the only thing left
  // to stat once the race has fired) while the slot holds the ORIGINAL bytes.
  // Every later refresh would then stat the replacement, match the record it
  // wrote, and conclude the slot is current - permanently, because the
  // replacement's identity never changes again. Writing no record is what
  // keeps the mistake recoverable: the next run finds none, falls back to
  // `mirrors`, and re-stages.
  it("writes NO staging record when the source is atomically replaced mid-copy, and the next refresh re-stages", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    const source = join(workHome, "running-binary-race");
    const originalBytes = "original binary bytes before the race";
    writeFileSync(source, originalBytes);
    const past = new Date(Date.now() - 300_000);
    utimesSync(source, past, past);
    copyFileControl.raceSourcePath = source;

    const first = await withExecPath(source, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(first?.staged).toBe("staged");
    // The copy captured the ORIGINAL bytes; the source has since been
    // replaced. Sanity-check that the race actually fired before asserting
    // anything about what was recorded.
    expect(readFileSync(wellKnownPath, "utf8")).toBe(originalBytes);
    expect(statSync(source).mtime.getTime()).toBe(
      RACE_REPLACEMENT_MTIME.getTime(),
    );
    // Pins the on-disk record name alongside `SLOT_SOURCE_RECORD_SUFFIX`.
    expect(existsSync(`${wellKnownPath}.source.json`)).toBe(false);

    const second = await withExecPath(source, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    // Re-staged, and now from a source nobody is racing: the slot ends up
    // holding the replacement's bytes rather than the stale originals.
    expect(second?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "bytes from a racing installer that replaced the source mid-copy",
    );
  });

  // Fix 1: an unreadable manifest (corrupt bytes, or a real I/O fault such
  // as EACCES) must not fall back to the running binary - the manifest may
  // well name a DIFFERENT installation, and repointing on a transient read
  // error would silently move the slot (and the registered service) onto
  // whichever executable happened to be invoked. Writing invalid JSON at
  // the manifest path is enough: `readCliManifest` throws
  // CLI_MANIFEST_INVALID for any present-but-malformed manifest, which
  // reaches `authoritativeSlotSource`'s catch the same way a genuine I/O
  // fault would.
  it("packaged, manifest is unreadable (corrupt): returns null and leaves the slot untouched", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { cliManifestPath } = await import("../paths");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    // Genuinely stale relative to the running binary, so a null result
    // below is proof the manifest fault stopped the refresh - not proof
    // there was nothing to do in the first place.
    const staleBytes = "stale slot bytes a corrupt manifest must not repoint";
    writeFileSync(wellKnownPath, staleBytes);
    const running = join(workHome, "running-binary");
    writeFileSync(
      running,
      "a currently running binary, a different length than the stale slot",
    );
    const manifestPath = cliManifestPath(ENVIRONMENT);
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, "not valid json");

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe(staleBytes);
  });

  // Fix (this changeset): only a CONFIRMED absence (ENOENT) may demote the
  // manifest's binary. `probePresence` reports anything else - EACCES, EIO -
  // as "unknown", and `authoritativeSlotSource` must nominate NO source at
  // all rather than guess "absent" and repoint the slot (and the registered
  // service) onto whichever binary happened to be running. The slot here is
  // deliberately stale relative to the running binary, so a null result is
  // proof the stat fault stopped the refresh - not proof there was nothing
  // to do.
  it("packaged, manifest names a binary whose stat fails with a non-ENOENT error: returns null and leaves the slot untouched", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const staleBytes =
      "stale slot bytes a faulted manifest-binary stat must not repoint";
    writeFileSync(wellKnownPath, staleBytes);
    const running = join(workHome, "running-binary");
    writeFileSync(
      running,
      "a currently running binary, a different length than the stale slot",
    );
    const manifestBinary = join(workHome, "manifest-binary-b");
    writeFileSync(manifestBinary, "binary B bytes");
    statControl.failEaccesForPath = resolve(manifestBinary);
    await writeCliManifest(ENVIRONMENT, {
      version: "1.2.3",
      installedAt: new Date(0).toISOString(),
      binaryPath: manifestBinary,
      source: "homebrew",
      pendingUpgrade: null,
    });

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result).toBeNull();
    expect(readFileSync(wellKnownPath, "utf8")).toBe(staleBytes);
  });

  // Positive control for the case above: a manifest binary that is
  // GENUINELY absent (a real ENOENT, not merely unreadable) must still fall
  // back to the running binary exactly as before - `probePresence` only
  // refuses to nominate a source for the "unknown" case, never for a
  // confirmed "absent" one.
  it("packaged, manifest names a binary that genuinely does not exist (ENOENT): falls back to the running binary and re-stages", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(
      wellKnownPath,
      "stale bytes behind a dangling manifest anchor",
    );
    const running = join(workHome, "running-binary");
    const runningBytes = "the currently running packaged binary";
    writeFileSync(running, runningBytes);
    // Never written to disk, so `probePresence` sees a genuine ENOENT.
    const missingManifestBinary = join(
      workHome,
      "manifest-binary-never-created",
    );
    await writeCliManifest(ENVIRONMENT, {
      version: "1.2.3",
      installedAt: new Date(0).toISOString(),
      binaryPath: missingManifestBinary,
      source: "homebrew",
      pendingUpgrade: null,
    });

    const result = await withExecPath(running, () =>
      refreshWellKnownSlotIfStale(ENVIRONMENT),
    );

    expect(result?.staged).toBe("staged");
    expect(readFileSync(wellKnownPath, "utf8")).toBe(runningBytes);
  });

  // Fix 2: staleness is now decided via `lstat`, not `stat`, specifically
  // so a legacy SYMLINK slot (an older Desktop's staging strategy) is never
  // read as "already fresh". Under the old `stat`-based check this would
  // follow the link to the authoritative binary and compare that binary
  // against itself, report a faithful mirror, and leave the link in place
  // forever - a content check alone can't tell the two outcomes apart,
  // since reading THROUGH a live symlink looks correct either way. Only
  // inspecting the slot's own directory entry (lstat) does.
  it.skipIf(process.platform === "win32")(
    "packaged, slot is a legacy SYMLINK to the authoritative binary: restages it into a real file",
    async () => {
      seaState.current = true;
      const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
        await import("../well-known-cli");
      const { writeCliManifest } = await import("../../manifest/cli-manifest");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(dirname(wellKnownPath), { recursive: true });
      const anchored = join(workHome, "anchored-binary-b");
      const anchoredBytes = "binary B - the manifest's real anchor";
      writeFileSync(anchored, anchoredBytes);
      await writeCliManifest(ENVIRONMENT, {
        version: "1.2.3",
        installedAt: new Date(0).toISOString(),
        binaryPath: anchored,
        source: "homebrew",
        pendingUpgrade: null,
      });
      // A legacy slot left as a symlink straight at the authoritative
      // binary - read THROUGH it, the content already matches byte for
      // byte.
      symlinkSync(anchored, wellKnownPath);
      const running = join(workHome, "some-other-running-binary");
      writeFileSync(running, "a third, unrelated running binary");

      const result = await withExecPath(running, () =>
        refreshWellKnownSlotIfStale(ENVIRONMENT),
      );

      expect(result?.staged).toBe("staged");
      // The load-bearing assertion: the slot is now a REGULAR FILE, not
      // still a symlink. Content alone would pass even under the old
      // `stat`-based bug, since a live symlink reads through to the right
      // bytes either way.
      const slotStat = lstatSync(wellKnownPath);
      expect(slotStat.isSymbolicLink()).toBe(false);
      expect(readFileSync(wellKnownPath, "utf8")).toBe(anchoredBytes);
    },
  );

  // Fix 3: staging now runs under `withCliLock` with `waitMs: 0`, and a
  // busy lock makes the whole refresh a no-op rather than blocking startup
  // behind another process's staging. Simulated here by holding the exact
  // same lock (same environment -> same `cliLockPath`) from this test
  // itself before calling the refresh.
  it("packaged, the CLI lock is already held: returns null and leaves a stale slot untouched", async () => {
    seaState.current = true;
    const { refreshWellKnownSlotIfStale, wellKnownCliBinaryPath } =
      await import("../well-known-cli");
    const { acquireCliLock } = await import("../cli-lock");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    const staleBytes = "stale slot bytes a busy lock must leave untouched";
    writeFileSync(wellKnownPath, staleBytes);
    const running = join(workHome, "running-binary");
    writeFileSync(
      running,
      "a currently running binary, a different length than the stale slot",
    );

    const lock = await acquireCliLock({
      environment: ENVIRONMENT,
      reason: "test-hold-for-contention",
      waitMs: 0,
      pollIntervalMs: 100,
    });
    try {
      const result = await withExecPath(running, () =>
        refreshWellKnownSlotIfStale(ENVIRONMENT),
      );

      expect(result).toBeNull();
      expect(readFileSync(wellKnownPath, "utf8")).toBe(staleBytes);
    } finally {
      await lock.release();
    }
  });
});
