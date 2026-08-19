import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { lstat, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";

// `node:sea` is absent under interpreter runs (bun, tsx); `isPackagedRun` in
// `cli-binary.ts` treats an import failure as "not packaged". Mock it with
// mutable state so individual tests can flip "packaged" on and off - vitest
// intercepts the dynamic `await import("node:sea")` through this mock.
const seaState = vi.hoisted(() => ({ current: false }));
vi.mock("node:sea", () => ({ isSea: () => seaState.current }));

// `store/paths` binds its home root from `os.homedir()` at module load -
// mirror the established pattern
// (`commands/__tests__/cli-finalize-upgrade.test.ts`) so each test's dynamic
// imports of the modules under test bind to a fresh tmp HOME instead of the
// real one.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DISTRIBUTION = process.env.TRAYCER_CLI_DISTRIBUTION;
const ORIGINAL_ARGV = process.argv;
const ENVIRONMENT: Environment = "production";
let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-cli-cli-binary-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  delete process.env.TRAYCER_CLI_DISTRIBUTION;
  seaState.current = false;
  process.argv = [...ORIGINAL_ARGV];
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
  if (ORIGINAL_DISTRIBUTION === undefined) {
    delete process.env.TRAYCER_CLI_DISTRIBUTION;
  } else {
    process.env.TRAYCER_CLI_DISTRIBUTION = ORIGINAL_DISTRIBUTION;
  }
  process.argv = ORIGINAL_ARGV;
  rmSync(workHome, { recursive: true, force: true });
});

describe("resolveServiceCliInvocation", () => {
  it("uses an override that exists on disk verbatim, with empty args", async () => {
    const overridePath = join(workHome, "override-binary");
    writeFileSync(overridePath, "binary");
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: overridePath,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: overridePath, args: [] });
  });

  it("throws SERVICE_CLI_PATH_UNRESOLVED when the override does not exist", async () => {
    const overridePath = join(workHome, "does-not-exist");
    const { resolveServiceCliInvocation } = await import("../cli-binary");
    const { CLI_ERROR_CODES, CliError } = await import("../../runner/errors");

    let caught: unknown = null;
    try {
      await resolveServiceCliInvocation({
        environment: ENVIRONMENT,
        override: overridePath,
        allowSelfInvocation: false,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED);
    }
  });

  it("uses the CLI manifest's binaryPath when the manifest is present and its binary exists", async () => {
    const binaryPath = join(workHome, "manifest-binary");
    writeFileSync(binaryPath, "binary");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "manual",
      pendingUpgrade: null,
    });
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: binaryPath, args: [] });
  });

  it("throws SERVICE_CLI_PATH_UNRESOLVED when the manifest is present but its binaryPath is missing", async () => {
    const binaryPath = join(workHome, "missing-manifest-binary");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "manual",
      pendingUpgrade: null,
    });
    const { resolveServiceCliInvocation } = await import("../cli-binary");
    const { CLI_ERROR_CODES, CliError } = await import("../../runner/errors");

    let caught: unknown = null;
    try {
      await resolveServiceCliInvocation({
        environment: ENVIRONMENT,
        override: null,
        allowSelfInvocation: false,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED);
    }
  });

  it("uses the well-known binary when no manifest exists but one is staged on disk", async () => {
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(join(wellKnownPath, ".."), { recursive: true });
    writeFileSync(wellKnownPath, "staged binary");
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: wellKnownPath, args: [] });
  });

  it("throws SERVICE_CLI_PATH_UNRESOLVED when nothing is staged, the run is not packaged, and allowSelfInvocation is false", async () => {
    const { resolveServiceCliInvocation } = await import("../cli-binary");
    const { CLI_ERROR_CODES, CliError } = await import("../../runner/errors");

    let caught: unknown = null;
    try {
      await resolveServiceCliInvocation({
        environment: ENVIRONMENT,
        override: null,
        allowSelfInvocation: false,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(CliError);
    if (caught instanceof CliError) {
      expect(caught.code).toBe(CLI_ERROR_CODES.SERVICE_CLI_PATH_UNRESOLVED);
    }
  });

  it("walks argv when nothing is staged, the run is not packaged, and allowSelfInvocation is true", async () => {
    process.argv = [process.argv[0] ?? "node", "/fake/entry.js"];
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: true,
    });

    expect(result).toEqual({
      command: process.execPath,
      args: ["/fake/entry.js"],
    });
  });

  // Headline regression test: the old code returned
  // `args: [process.argv[1]]` for a packaged (SEA) run too, baking the raw
  // invocation spelling (e.g. "traycer") into service units as a bogus
  // entry-script argument - a SEA binary has no entry script, so replaying
  // that arg produces "error: unknown command". The fix stages the
  // well-known slot as a COPY of `process.execPath`'s bytes and points the
  // service at THAT path with no leading args, regardless of
  // `allowSelfInvocation`.
  it("stages a copy of process.execPath at the well-known slot and returns empty args when packaged, even with allowSelfInvocation false", async () => {
    seaState.current = true;
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: wellKnownPath, args: [] });
    const slotStat = await lstat(wellKnownPath);
    expect(slotStat.isSymbolicLink()).toBe(false);
    expect(slotStat.isFile()).toBe(true);
    // process.execPath is the ~100MB running binary - compare sizes rather
    // than reading and diffing the whole file.
    const execStat = await stat(process.execPath);
    expect(slotStat.size).toBe(execStat.size);
  });

  it("falls back to process.execPath with empty args when packaged but staging the well-known slot fails", async () => {
    seaState.current = true;
    const { cliInstallHomeDir } = await import("../../store/paths");
    const parentDir = cliInstallHomeDir(ENVIRONMENT);
    const binDirPath = join(parentDir, "bin");
    // A REGULAR FILE at the parent dir path makes `stageWellKnownCliBinary`'s
    // `mkdir(dirname(wellKnownPath), { recursive: true })` fail, so staging
    // returns "failed".
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(binDirPath, "not a directory");
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: process.execPath, args: [] });
  });
});
