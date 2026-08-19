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

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ENVIRONMENT: Environment = "production";
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-cli-well-known-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
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
  it("resolves to <cliInstallHomeDir>/bin/traycer", async () => {
    const { wellKnownCliBinaryPath } = await import("../well-known-cli");
    const { cliInstallHomeDir } = await import("../paths");
    expect(wellKnownCliBinaryPath(ENVIRONMENT)).toBe(
      join(cliInstallHomeDir(ENVIRONMENT), "bin", "traycer"),
    );
  });
});

describe("stageWellKnownCliBinary", () => {
  it("stages a regular-file copy of the binary's bytes at the well-known path, mode 0o755", async () => {
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
    expect(stat.mode & 0o777).toBe(0o755);
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

  it("upgrades a legacy symlink at the well-known path to a regular-file copy (rename swallows the old symlink)", async () => {
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
  });

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
});
