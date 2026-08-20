import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";

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
});
