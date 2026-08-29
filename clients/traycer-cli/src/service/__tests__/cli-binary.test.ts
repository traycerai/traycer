import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";

// `node:sea` is absent under interpreter runs (bun, tsx); `isPackagedRun` in
// `cli-binary.ts` treats an import failure as "not packaged". Mock it with
// mutable state so individual tests can flip "packaged" on and off - vitest
// intercepts the dynamic `await import("node:sea")` through this mock.
const seaState = vi.hoisted(() => ({ current: false }));
vi.mock("node:sea", () => ({ isSea: () => seaState.current }));

// `stagedSlotInvocation` verifies that the path it is about to register can
// actually be EXECUTED, which is the only way to detect a home directory
// mounted `noexec`: there the copy and the chmod both succeed and only
// `execve` refuses. Simulated by refusing the listed paths with EACCES, the
// same errno that mount flag produces, and letting every other path "run".
//
// Callback-style deliberately: `cli-binary.ts` builds its probe with
// `promisify(execFile)`, and without `util.promisify.custom` on this mock
// promisify wraps it by the ordinary callback convention. A promise-returning
// mock would never resolve.
// `versionForPath` also drives `resolveNodeOnPath`, which now checks that the
// `node` it is about to pin into a unit file actually reports a supported
// version. The default is a supported one, so every test that only cares
// about WHICH candidate is chosen keeps expressing exactly that.
const execControl = vi.hoisted(() => ({
  refuseWithEaccesForPaths: [] as string[],
  // A failure that is NOT a spawn refusal - ETIMEDOUT here, standing in for
  // the whole family (a loaded machine, a non-zero exit). `canExecute`'s
  // conservative arm answers "yes" for these, and that arm needs its own
  // control: without one, only the EACCES side of the errno split is ever
  // exercised, and a `catch { return false }` rewrite would stay green.
  failWithEtimedoutForPaths: [] as string[],
  versionForPath: new Map<string, string>(),
  defaultVersion: "v22.11.0\n",
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  const run = (
    file: string,
  ): { readonly error: Error | null; readonly stdout: string } => {
    if (execControl.refuseWithEaccesForPaths.includes(file)) {
      return {
        error: Object.assign(new Error(`simulated EACCES executing ${file}`), {
          code: "EACCES",
        }),
        stdout: "",
      };
    }
    if (execControl.failWithEtimedoutForPaths.includes(file)) {
      return {
        error: Object.assign(
          new Error(`simulated ETIMEDOUT executing ${file}`),
          { code: "ETIMEDOUT" },
        ),
        stdout: "",
      };
    }
    return {
      error: null,
      stdout:
        execControl.versionForPath.get(file) ?? execControl.defaultVersion,
    };
  };
  const mockExecFile = (
    file: string,
    _args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ): unknown => {
    const { error, stdout } = run(file);
    callback(error, stdout, "");
    return {};
  };
  // The real `child_process.execFile` carries `util.promisify.custom`, which
  // is why `promisify(execFile)` resolves `{ stdout, stderr }` rather than a
  // bare string. Without it here, promisify would fall back to the plain
  // callback convention and hand production's `const { stdout } = ...`
  // destructure an undefined - i.e. the mock would be testing a DIFFERENT
  // contract than the one that ships, and would fail code that is correct.
  Object.defineProperty(mockExecFile, promisify.custom, {
    value: (file: string) =>
      new Promise<{ stdout: string; stderr: string }>(
        (resolvePromise, reject) => {
          const { error, stdout } = run(file);
          if (error !== null) reject(error);
          else resolvePromise({ stdout, stderr: "" });
        },
      ),
  });
  return { ...actual, execFile: mockExecFile };
});

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

// Lets the win32 slot-exists-after-a-failed-publish test (Fix 3's "stale
// slot survives a failed staging attempt" branch) intercept exactly ONE
// `rename()` call by its 1-based call number - the identical technique
// `store/__tests__/well-known-cli.test.ts` uses for the same underlying
// `stageWellKnownCliBinary` win32 rename-aside/restore path. Every other
// test in this file leaves `failOnCallNumber` null, so every `rename()`
// call is a plain passthrough.
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

// `stagedSlotInvocation`'s "staging failed and nothing is staged" branch
// reports through the real CLI logger, which appends to the invoking user's
// `~/.traycer` log file. Stub it so the suite stays hermetic and that
// warning is assertable - mirrors
// `service/__tests__/install-lifecycle.test.ts`'s identical stub.
const mocks = vi.hoisted(() => ({
  cliLoggerWarnMock: vi.fn(),
}));
vi.mock("../../logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../logger")>();
  return {
    ...actual,
    createCliLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mocks.cliLoggerWarnMock,
      error: vi.fn(),
    }),
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ORIGINAL_DISTRIBUTION = process.env.TRAYCER_CLI_DISTRIBUTION;
const ORIGINAL_PATH = process.env.PATH;
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
  renameControl.callCount = 0;
  renameControl.failOnCallNumber = null;
  execControl.refuseWithEaccesForPaths = [];
  execControl.failWithEtimedoutForPaths = [];
  execControl.versionForPath = new Map();
  mocks.cliLoggerWarnMock.mockClear();
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
  if (ORIGINAL_PATH === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = ORIGINAL_PATH;
  }
  process.argv = ORIGINAL_ARGV;
  rmSync(workHome, { recursive: true, force: true });
});

// `npmInterpreterInvocation`'s PATH fallback (Fix 4) resolves an absolute
// `node` off `process.env.PATH` - tests that want a deterministic answer
// point PATH at a directory they fully control rather than trusting
// whatever the host machine happens to have installed.
function withPath<T>(pathValue: string, run: () => Promise<T>): Promise<T> {
  const original = process.env.PATH;
  process.env.PATH = pathValue;
  return run().finally(() => {
    if (original === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = original;
    }
  });
}

// A minimal stand-in `node`/`node.exe` on PATH: `resolveNodeOnPath` only
// checks that the candidate exists and is executable
// (`access(candidate, X_OK)`), so the file's actual contents never run.
function writeFakeExecutableNode(dir: string): string {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const path = join(dir, name);
  writeFileSync(path, "#!/bin/sh\necho fake-node\n");
  if (process.platform !== "win32") {
    chmodSync(path, 0o755);
  }
  return path;
}

// A directory named `node`/`node.exe` on a PATH entry: execute permission on
// a directory means "searchable", not "runs as a program" - the regression
// this guards against is `resolveNodeOnPath` accepting it via
// `access(candidate, X_OK)` alone, ahead of a real interpreter sitting on a
// later PATH entry.
function writeNodeLookingDirectory(dir: string): string {
  const name = process.platform === "win32" ? "node.exe" : "node";
  const path = join(dir, name);
  mkdirSync(path);
  return path;
}

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

  // A path that EXISTS is not a path that can be run. `access()` succeeds on
  // a directory, so an existence test would hand a directory straight through
  // to the service definition, producing a unit systemd and launchd both
  // accept and neither can ever start. Every path this resolver returns has
  // to be a regular file, and an override is the one a user types.
  it("throws SERVICE_CLI_PATH_UNRESOLVED when the override is a DIRECTORY", async () => {
    const overridePath = join(workHome, "a-directory-not-a-binary");
    mkdirSync(overridePath, { recursive: true });
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

  // Manifest branch, source !== "npm": the registered command must be the
  // well-known slot (`<cliInstallHomeDir>/bin/traycer`), staged as a COPY of
  // the manifest binary's bytes - not the manifest's binaryPath directly.
  // The host daemon's own CLI discovery reads ONLY that slot, so a
  // registration naming any other path leaves it reporting
  // `cli-unavailable` even while the service runs.
  it("stages the well-known slot from the CLI manifest's binaryPath and returns the slot path", async () => {
    const binaryPath = join(workHome, "manifest-binary");
    const binaryBytes = "manifest binary bytes";
    writeFileSync(binaryPath, binaryBytes);
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "manual",
      pendingUpgrade: null,
    });
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
    expect(readFileSync(wellKnownPath, "utf8")).toBe(binaryBytes);
  });

  // Re-anchor regression: `cli re-anchor` rewrites the manifest's
  // binaryPath in place (e.g. after a manual re-anchor to a different
  // binary). Both resolutions must register the SAME well-known slot path
  // - the host's discovery never changes - and the slot's bytes must track
  // the newest manifest binary, not whichever one staged it first.
  it("re-anchoring the manifest to a different binaryPath re-stages the SAME well-known slot with the new bytes", async () => {
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const { resolveServiceCliInvocation } = await import("../cli-binary");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);

    const binaryA = join(workHome, "manifest-binary-a");
    writeFileSync(binaryA, "binary-a-bytes");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath: binaryA,
      source: "manual",
      pendingUpgrade: null,
    });

    const firstResult = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });
    expect(firstResult).toEqual({ command: wellKnownPath, args: [] });
    expect(readFileSync(wellKnownPath, "utf8")).toBe("binary-a-bytes");

    const binaryB = join(workHome, "manifest-binary-b");
    writeFileSync(binaryB, "binary-b-bytes-different");
    await writeCliManifest(ENVIRONMENT, {
      version: "2.0.0",
      installedAt: new Date().toISOString(),
      binaryPath: binaryB,
      source: "manual",
      pendingUpgrade: null,
    });

    const secondResult = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(secondResult).toEqual({ command: wellKnownPath, args: [] });
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "binary-b-bytes-different",
    );
  });

  // Staging is best-effort (see `stagedSlotInvocation` in cli-binary.ts):
  // when it fails, the service must still be registered against the real
  // manifest binary rather than left unresolved.
  it("falls back to the manifest's binaryPath directly when staging the well-known slot fails", async () => {
    const binaryPath = join(workHome, "manifest-binary-staging-fails");
    writeFileSync(binaryPath, "binary bytes");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "manual",
      pendingUpgrade: null,
    });
    const { cliInstallHomeDir } = await import("../../store/paths");
    const parentDir = cliInstallHomeDir(ENVIRONMENT);
    const binDirPath = join(parentDir, "bin");
    // A REGULAR FILE at the `bin` directory path makes
    // `stageWellKnownCliBinary`'s `mkdir(dirname(wellKnownPath), { recursive: true })`
    // fail, forcing the staging outcome to "failed" - same technique the
    // well-known-cli suite uses.
    writeFileSync(binDirPath, "not a directory");
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: binaryPath, args: [] });
  });

  // Native Packaging system-marker fallback: `readCliManifest` SYNTHESIZES a
  // manifest from `/var/lib/traycer/source.{apt,rpm}` on Linux prod when no
  // per-user manifest file exists yet (first invocation after an
  // unattended apt/rpm install). That manifest's source is "apt"/"rpm", not
  // "npm", so it must take the staging branch end-to-end exactly like a
  // hand-written manifest would. `process.platform` is stubbed (rather than
  // `it.runIf`-gated) so this exercises the real Linux code path on every
  // CI runner, not just Linux ones.
  it("stages the well-known slot end-to-end from a synthesized apt/rpm system-source manifest", async () => {
    const { __setSystemSourceMarkerDirForTest } =
      await import("../../manifest/cli-manifest");
    const markerDir = mkdtempSync(
      join(tmpdir(), "traycer-cli-binary-marker-test-"),
    );
    const previousMarkerDir = __setSystemSourceMarkerDirForTest(markerDir);
    const platformDescriptor = Object.getOwnPropertyDescriptor(
      process,
      "platform",
    );
    if (platformDescriptor === undefined) {
      throw new Error("process.platform descriptor missing");
    }
    Object.defineProperty(process, "platform", {
      value: "linux",
      configurable: true,
    });
    try {
      const aptBinaryPath = join(workHome, "apt-installed-traycer");
      writeFileSync(aptBinaryPath, "apt binary bytes");
      writeFileSync(
        join(markerDir, "source.apt"),
        JSON.stringify({ binaryPath: aptBinaryPath, version: "1.5.0" }),
        "utf8",
      );
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
      expect(readFileSync(wellKnownPath, "utf8")).toBe("apt binary bytes");
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      __setSystemSourceMarkerDirForTest(previousMarkerDir);
      rmSync(markerDir, { recursive: true, force: true });
    }
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

  // The npm distribution ships a shebanged Node bundle with no install
  // hook: `readCliManifest` SYNTHESIZES an npm-source manifest from the
  // `TRAYCER_CLI_DISTRIBUTION=npm` env shim (binaryPath = process.argv[1])
  // when no manifest file exists on disk. Registering that script directly
  // makes the service depend on `node` being on the service manager's PATH
  // (false for nvm under systemd), so the resolver pins the absolute
  // interpreter instead - but only when the RESOLVING process is that same
  // npm bundle (env shim set, not packaged).
  it("pins the interpreter when a persisted manifest's source is npm and the distribution shim env is set", async () => {
    const binaryPath = join(workHome, "npm-bundle.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "npm",
      pendingUpgrade: null,
    });
    process.env.TRAYCER_CLI_DISTRIBUTION = "npm";
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: process.execPath, args: [binaryPath] });
    // npm never gets an executable slot: it ships a shebanged script, not a
    // binary, and staging it into the well-known slot would leave the host
    // trying to exec JavaScript directly.
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
  });

  // Fix 4 (`npmInterpreterInvocation`'s PATH fallback): a PERSISTED npm
  // manifest resolved by a DIFFERENT process than the one that wrote it (no
  // distribution shim env) no longer falls back to the raw bundle path
  // directly - it pins the first executable `node` it finds on the
  // resolving user's PATH, so the eventual service unit never depends on the
  // SERVICE MANAGER's PATH containing `node` (false for nvm/asdf under
  // systemd). PATH is pointed at a directory this test fully controls so the
  // answer does not depend on whatever the host machine has installed.
  it("pins the first executable node found on PATH when source is npm and the distribution shim env is unset", async () => {
    const binaryPath = join(workHome, "npm-bundle.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "npm",
      pendingUpgrade: null,
    });
    const pathDir = mkdtempSync(join(tmpdir(), "traycer-cli-fake-node-"));
    const fakeNode = writeFakeExecutableNode(pathDir);
    try {
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await withPath(pathDir, () =>
        resolveServiceCliInvocation({
          environment: ENVIRONMENT,
          override: null,
          allowSelfInvocation: false,
        }),
      );

      expect(result).toEqual({ command: fakeNode, args: [binaryPath] });
      const { wellKnownCliBinaryPath } =
        await import("../../store/well-known-cli");
      expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
    } finally {
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  // Same PATH fallback, but for a resolving process that IS packaged (a SEA
  // binary sharing the machine with an npm install). The shim env being set
  // is irrelevant once `isPackagedRun()` is true - `process.execPath` is the
  // SEA binary's own bytes, not a node interpreter, so this must still go
  // through the PATH scan rather than pin `process.execPath`.
  it("pins the first executable node found on PATH when source is npm, the shim env is set, but the resolving run is packaged", async () => {
    seaState.current = true;
    const binaryPath = join(workHome, "npm-bundle.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "npm",
      pendingUpgrade: null,
    });
    process.env.TRAYCER_CLI_DISTRIBUTION = "npm";
    const pathDir = mkdtempSync(join(tmpdir(), "traycer-cli-fake-node-"));
    const fakeNode = writeFakeExecutableNode(pathDir);
    try {
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await withPath(pathDir, () =>
        resolveServiceCliInvocation({
          environment: ENVIRONMENT,
          override: null,
          allowSelfInvocation: false,
        }),
      );

      expect(result).toEqual({ command: fakeNode, args: [binaryPath] });
      // Even a PACKAGED run must never stage the slot on the npm source
      // branch - that branch returns before the packaged self-invocation
      // path is ever reached.
      const { wellKnownCliBinaryPath } =
        await import("../../store/well-known-cli");
      expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
    } finally {
      rmSync(pathDir, { recursive: true, force: true });
    }
  });

  // No `node` reachable anywhere on PATH: the scan comes back empty and
  // `npmInterpreterInvocation` returns null. POSIX no longer refuses here -
  // it registers the bare script directly, with a warning, because this
  // process's PATH is not authoritative for the unit: a re-registration
  // driven by the host, or a stripped shell, can resolve here with a
  // minimal PATH while the systemd user manager's own environment holds a
  // perfectly good node. Refusing would convert installs that launched
  // fine yesterday into hard errors on the next re-registration. Only
  // win32 still throws - a `.js` cannot execute there under any PATH - so
  // this is skipped there rather than faked, per the module's own
  // platform-at-import contract.
  it.skipIf(process.platform === "win32")(
    "registers the bare script with a warning when no node executable exists anywhere on PATH (POSIX fallback)",
    async () => {
      const binaryPath = join(workHome, "npm-bundle.js");
      writeFileSync(binaryPath, "#!/usr/bin/env node\n");
      const { writeCliManifest } = await import("../../manifest/cli-manifest");
      await writeCliManifest(ENVIRONMENT, {
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        binaryPath,
        source: "npm",
        pendingUpgrade: null,
      });
      const emptyPathDir = mkdtempSync(
        join(tmpdir(), "traycer-cli-empty-path-"),
      );
      try {
        const { resolveServiceCliInvocation } = await import("../cli-binary");

        const result = await withPath(emptyPathDir, () =>
          resolveServiceCliInvocation({
            environment: ENVIRONMENT,
            override: null,
            allowSelfInvocation: false,
          }),
        );

        expect(result).toEqual({ command: binaryPath, args: [] });
        expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
          expect.stringMatching(/falling back to the bare script/),
          expect.objectContaining({ binaryPath }),
        );
      } finally {
        rmSync(emptyPathDir, { recursive: true, force: true });
      }
    },
  );

  // Fix: `resolveNodeOnPath` used to accept any PATH candidate that passed
  // `access(candidate, X_OK)` alone. Execute permission on a DIRECTORY means
  // "searchable", not "runs as a program" - so a directory named `node`
  // sitting on an earlier PATH entry used to satisfy that check and win over
  // the real interpreter sitting on a later entry. The fix `stat`s first and
  // requires `isFile()`, continuing the scan past a directory instead.
  it("skips a directory named node on an earlier PATH entry and pins the real executable on a later entry", async () => {
    const binaryPath = join(workHome, "npm-bundle.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "npm",
      pendingUpgrade: null,
    });
    const firstDir = mkdtempSync(join(tmpdir(), "traycer-cli-node-dir-first-"));
    const secondDir = mkdtempSync(
      join(tmpdir(), "traycer-cli-node-real-second-"),
    );
    writeNodeLookingDirectory(firstDir);
    const realNode = writeFakeExecutableNode(secondDir);
    try {
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await withPath(`${firstDir}${delimiter}${secondDir}`, () =>
        resolveServiceCliInvocation({
          environment: ENVIRONMENT,
          override: null,
          allowSelfInvocation: false,
        }),
      );

      expect(result).toEqual({ command: realNode, args: [binaryPath] });
      // npm never gets an executable slot, same as the sibling PATH tests
      // above.
      const { wellKnownCliBinaryPath } =
        await import("../../store/well-known-cli");
      expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
    } finally {
      rmSync(firstDir, { recursive: true, force: true });
      rmSync(secondDir, { recursive: true, force: true });
    }
  });

  // Being executable is not being USABLE. The npm package declares
  // `engines.node >= 20.18.1`, and npm enforces that at INSTALL time only -
  // which says nothing about the interpreter a service definition written
  // later will name. The configuration this protects is ordinary rather than
  // exotic: an nvm or asdf user installs under a current Node while
  // `/usr/bin/node` 18 sits earlier on the SERVICE manager's PATH. Pinning
  // the 18 rewrites a working registration into a unit that dies at every
  // start, on a definition nothing rewrites afterwards.
  it("skips a too-old node on an earlier PATH entry and pins a supported one later", async () => {
    const binaryPath = join(workHome, "npm-bundle.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "npm",
      pendingUpgrade: null,
    });
    const oldDir = mkdtempSync(join(tmpdir(), "traycer-cli-node-old-"));
    const newDir = mkdtempSync(join(tmpdir(), "traycer-cli-node-new-"));
    const oldNode = writeFakeExecutableNode(oldDir);
    const newNode = writeFakeExecutableNode(newDir);
    // Both are perfectly executable regular files - the ONLY difference is
    // what they report, which is the whole point of the check.
    execControl.versionForPath.set(oldNode, "v18.20.4\n");
    execControl.versionForPath.set(newNode, "v22.11.0\n");
    try {
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await withPath(`${oldDir}${delimiter}${newDir}`, () =>
        resolveServiceCliInvocation({
          environment: ENVIRONMENT,
          override: null,
          allowSelfInvocation: false,
        }),
      );

      expect(result).toEqual({ command: newNode, args: [binaryPath] });
    } finally {
      rmSync(oldDir, { recursive: true, force: true });
      rmSync(newDir, { recursive: true, force: true });
    }
  });

  // The floor used to be enforced by refusing outright. It no longer is:
  // POSIX registers the bare script with a warning even when every `node` on
  // PATH is too old, for the same reason as the empty-PATH case above - this
  // process's PATH is not authoritative for the unit the service manager
  // will actually launch from.
  it.skipIf(process.platform === "win32")(
    "registers the bare script with a warning when every node on PATH is below the required version (POSIX fallback)",
    async () => {
      const binaryPath = join(workHome, "npm-bundle.js");
      writeFileSync(binaryPath, "#!/usr/bin/env node\n");
      const { writeCliManifest } = await import("../../manifest/cli-manifest");
      await writeCliManifest(ENVIRONMENT, {
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        binaryPath,
        source: "npm",
        pendingUpgrade: null,
      });
      const oldDir = mkdtempSync(join(tmpdir(), "traycer-cli-node-all-old-"));
      const oldNode = writeFakeExecutableNode(oldDir);
      execControl.versionForPath.set(oldNode, "v18.20.4\n");
      try {
        const { resolveServiceCliInvocation } = await import("../cli-binary");

        const result = await withPath(oldDir, () =>
          resolveServiceCliInvocation({
            environment: ENVIRONMENT,
            override: null,
            allowSelfInvocation: false,
          }),
        );

        expect(result).toEqual({ command: binaryPath, args: [] });
        expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
          expect.stringMatching(/falling back to the bare script/),
          expect.objectContaining({ binaryPath }),
        );
      } finally {
        rmSync(oldDir, { recursive: true, force: true });
      }
    },
  );

  // The boundary itself. `20.18.1` is the declared floor, so it must be
  // ACCEPTED - a `>` where `>=` belongs would reject the exact version the
  // package says it supports, and a test that only ever checked 18 vs 22
  // could not tell the two comparisons apart.
  it("accepts a node at exactly the declared minimum version", async () => {
    const binaryPath = join(workHome, "npm-bundle.js");
    writeFileSync(binaryPath, "#!/usr/bin/env node\n");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "npm",
      pendingUpgrade: null,
    });
    const dir = mkdtempSync(join(tmpdir(), "traycer-cli-node-exact-"));
    const exactNode = writeFakeExecutableNode(dir);
    execControl.versionForPath.set(exactNode, "v20.18.1\n");
    try {
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await withPath(dir, () =>
        resolveServiceCliInvocation({
          environment: ENVIRONMENT,
          override: null,
          allowSelfInvocation: false,
        }),
      );

      expect(result).toEqual({ command: exactNode, args: [binaryPath] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // One patch below the floor, which no major-only comparison can see - and,
  // like the other two node-version tests above, no longer a refusal on
  // POSIX: the bare script is registered with a warning instead.
  it.skipIf(process.platform === "win32")(
    "registers the bare script with a warning for a node one patch below the declared minimum version (POSIX fallback)",
    async () => {
      const binaryPath = join(workHome, "npm-bundle.js");
      writeFileSync(binaryPath, "#!/usr/bin/env node\n");
      const { writeCliManifest } = await import("../../manifest/cli-manifest");
      await writeCliManifest(ENVIRONMENT, {
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        binaryPath,
        source: "npm",
        pendingUpgrade: null,
      });
      const dir = mkdtempSync(join(tmpdir(), "traycer-cli-node-just-below-"));
      const justBelow = writeFakeExecutableNode(dir);
      execControl.versionForPath.set(justBelow, "v20.18.0\n");
      try {
        const { resolveServiceCliInvocation } = await import("../cli-binary");

        const result = await withPath(dir, () =>
          resolveServiceCliInvocation({
            environment: ENVIRONMENT,
            override: null,
            allowSelfInvocation: false,
          }),
        );

        expect(result).toEqual({ command: binaryPath, args: [] });
        expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
          expect.stringMatching(/falling back to the bare script/),
          expect.objectContaining({ binaryPath }),
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  // A directory named `node` is not a usable interpreter, so the scan still
  // comes back empty here too - and, like every other "no usable node" shape
  // above, POSIX now registers the bare script with a warning rather than
  // refusing.
  it.skipIf(process.platform === "win32")(
    "registers the bare script with a warning when PATH contains only a directory named node (POSIX fallback)",
    async () => {
      const binaryPath = join(workHome, "npm-bundle.js");
      writeFileSync(binaryPath, "#!/usr/bin/env node\n");
      const { writeCliManifest } = await import("../../manifest/cli-manifest");
      await writeCliManifest(ENVIRONMENT, {
        version: "1.0.0",
        installedAt: new Date().toISOString(),
        binaryPath,
        source: "npm",
        pendingUpgrade: null,
      });
      const dirOnlyPathDir = mkdtempSync(
        join(tmpdir(), "traycer-cli-node-dir-only-"),
      );
      writeNodeLookingDirectory(dirOnlyPathDir);
      try {
        const { resolveServiceCliInvocation } = await import("../cli-binary");

        const result = await withPath(dirOnlyPathDir, () =>
          resolveServiceCliInvocation({
            environment: ENVIRONMENT,
            override: null,
            allowSelfInvocation: false,
          }),
        );

        expect(result).toEqual({ command: binaryPath, args: [] });
        expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
          expect.stringMatching(/falling back to the bare script/),
          expect.objectContaining({ binaryPath }),
        );
      } finally {
        rmSync(dirOnlyPathDir, { recursive: true, force: true });
      }
    },
  );

  it("synthesizes an npm manifest end-to-end from the distribution shim (no manifest file, no well-known slot) and pins the interpreter", async () => {
    const argv1Path = join(workHome, "npm-bundle-argv1.js");
    writeFileSync(argv1Path, "#!/usr/bin/env node\n");
    process.env.TRAYCER_CLI_DISTRIBUTION = "npm";
    process.argv = [process.argv[0] ?? "node", argv1Path];
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({
      command: process.execPath,
      args: [argv1Path],
    });
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
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
    // Staging copies `process.execPath`'s BYTES, and under vitest that used
    // to be the real ~100MB Node binary: on a loaded CI runner pushing it
    // through the copy+rename staging pipeline blew the 5s test timeout.
    // The contract is "a copy of whatever execPath names lands in the
    // slot", not "100MB copies in 5s" - point execPath at a small stand-in,
    // exactly as the refresh test below does, which also upgrades the
    // size-only comparison to full byte equality.
    const fakeExecPath = join(workHome, "fake-packaged-binary");
    // Raw non-UTF-8 bytes: a text fixture round-trips through a utf8 decode
    // and would miss corruption that only shows on binary content.
    const packagedBytes = Buffer.from([0x00, 0xff, 0x80, 0x7f, 0x01, 0xfe]);
    writeFileSync(fakeExecPath, packagedBytes);
    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: fakeExecPath,
      configurable: true,
    });
    try {
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
      expect(readFileSync(wellKnownPath)).toEqual(packagedBytes);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }
  });

  // winget's portable installer replaces process.execPath's bytes in place
  // with no post-install hook, so an already-staged slot from a PRIOR
  // version must be refreshed from the running binary rather than trusted
  // as-is - this is why the packaged branch runs BEFORE the existing-slot
  // check (see the discovery-order comment in cli-binary.ts).
  it("refreshes an already-staged, stale well-known slot from the running binary when packaged", async () => {
    seaState.current = true;
    const fakeExecPath = join(workHome, "fake-packaged-binary");
    const freshBytes = "fresh packaged binary bytes";
    writeFileSync(fakeExecPath, freshBytes);
    const originalExecPath = process.execPath;
    Object.defineProperty(process, "execPath", {
      value: fakeExecPath,
      configurable: true,
    });
    try {
      const { wellKnownCliBinaryPath } =
        await import("../../store/well-known-cli");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(join(wellKnownPath, ".."), { recursive: true });
      writeFileSync(wellKnownPath, "stale slot bytes from a prior version");
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await resolveServiceCliInvocation({
        environment: ENVIRONMENT,
        override: null,
        allowSelfInvocation: false,
      });

      expect(result).toEqual({ command: wellKnownPath, args: [] });
      expect(readFileSync(wellKnownPath, "utf8")).toBe(freshBytes);
    } finally {
      Object.defineProperty(process, "execPath", {
        value: originalExecPath,
        configurable: true,
      });
    }
  });

  // Fix 3's "slot absent" branch: staging failed AND no slot binary exists
  // to fall back to, so the real (unstable, version-scoped) binary path gets
  // registered instead - and that degradation is logged, so the eventual
  // breakage has a recorded cause rather than presenting as a service that
  // mysteriously stopped launching.
  it("falls back to process.execPath with empty args and logs a warning when packaged but staging the well-known slot fails and no slot exists", async () => {
    seaState.current = true;
    const { cliInstallHomeDir } = await import("../../store/paths");
    const parentDir = cliInstallHomeDir(ENVIRONMENT);
    const binDirPath = join(parentDir, "bin");
    // A REGULAR FILE at the parent dir path makes `stageWellKnownCliBinary`'s
    // `mkdir(dirname(wellKnownPath), { recursive: true })` fail, so staging
    // returns "failed" - and the well-known path itself can never exist
    // either, since its parent directory is a file, not a directory.
    mkdirSync(parentDir, { recursive: true });
    writeFileSync(binDirPath, "not a directory");
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: process.execPath, args: [] });
    expect(mocks.cliLoggerWarnMock).toHaveBeenCalledTimes(1);
    expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
      "service CLI registered against an unstaged binary path",
      expect.objectContaining({ binaryPath: process.execPath }),
    );
  });

  // Fix 3's "slot exists" branch: staging fails on the PUBLISH step (the
  // win32 rename-aside/restore path - the identical technique used in
  // `store/__tests__/well-known-cli.test.ts`), but the restore leaves a
  // functional slot binary in place. That slot must be registered directly
  // (stale-but-functional, stable, host-visible) rather than falling back to
  // `process.execPath`'s own path, and WITHOUT logging the "unstaged"
  // warning - the slot IS staged, just with older bytes.
  it("registers the existing slot path without warning when staging fails but a slot binary is already present", async () => {
    seaState.current = true;
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
    // which must fail here; call #3 is the failure-path restore, left
    // un-intercepted so the module's real recovery actually runs.
    renameControl.failOnCallNumber = 2;
    try {
      const { wellKnownCliBinaryPath } =
        await import("../../store/well-known-cli");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(join(wellKnownPath, ".."), { recursive: true });
      const staleBytes = "stale-but-functional slot bytes";
      writeFileSync(wellKnownPath, staleBytes);
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await resolveServiceCliInvocation({
        environment: ENVIRONMENT,
        override: null,
        allowSelfInvocation: false,
      });

      expect(result).toEqual({ command: wellKnownPath, args: [] });
      // The restore put the ORIGINAL bytes back - process.execPath's copy
      // never got to publish over them.
      expect(readFileSync(wellKnownPath, "utf8")).toBe(staleBytes);
      expect(mocks.cliLoggerWarnMock).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", platformDescriptor);
      renameControl.callCount = 0;
      renameControl.failOnCallNumber = null;
    }
  });

  // A hardened Linux install with `/home` mounted `noexec`: the copy into
  // `~/.traycer/cli/bin` succeeds, the chmod succeeds, staging reports
  // success - and the unit built from it dies at `ExecStart` even though the
  // package manager's own binary was runnable all along. `access(X_OK)`
  // cannot see this (Linux answers it from the permission bits and the
  // refusal appears only at `execve`), which is why the check is an actual
  // execution.
  it("registers the source binary when the staged slot cannot execute but the source can", async () => {
    const binaryPath = join(workHome, "system-binary");
    writeFileSync(binaryPath, "the package manager's runnable binary");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "apt",
      pendingUpgrade: null,
    });
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    // Only the slot is refused - the source runs, which is the asymmetry that
    // makes falling back to it an improvement rather than a lateral move.
    execControl.refuseWithEaccesForPaths = [wellKnownPath];
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: binaryPath, args: [] });
    expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
      "staged CLI slot cannot be executed - registering the source binary instead",
      expect.objectContaining({ binaryPath, wellKnownPath }),
    );
  });

  // The conservative arm of the same probe, which the two EACCES tests around
  // this one cannot see: an error that is NOT a spawn refusal must keep the
  // slot registered. A timeout on a loaded machine (or a non-zero exit from a
  // binary that ran fine and disliked `--version`) is not evidence the
  // supervisor cannot start the slot, and demoting on it would trade the one
  // upgrade-stable path away over an unrelated hiccup. Without this case a
  // `catch { return false }` rewrite of `canExecute` would stay green.
  it("keeps the slot registered when the probe fails with a NON-refusal error (ETIMEDOUT)", async () => {
    const binaryPath = join(workHome, "system-binary");
    writeFileSync(binaryPath, "the package manager's runnable binary");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "apt",
      pendingUpgrade: null,
    });
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    execControl.failWithEtimedoutForPaths = [wellKnownPath];
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: wellKnownPath, args: [] });
    expect(mocks.cliLoggerWarnMock).not.toHaveBeenCalledWith(
      "staged CLI slot cannot be executed - registering the source binary instead",
      expect.anything(),
    );
  });

  // The other half of the same rule. When the source cannot run either,
  // demoting to it trades away the one property the slot exists for - a path
  // that survives upgrades - and buys nothing, since the registration would
  // still name something that does not execute.
  it("keeps the slot when NEITHER it nor the source can execute", async () => {
    const binaryPath = join(workHome, "system-binary");
    writeFileSync(binaryPath, "a binary that does not run either");
    const { writeCliManifest } = await import("../../manifest/cli-manifest");
    await writeCliManifest(ENVIRONMENT, {
      version: "1.0.0",
      installedAt: new Date().toISOString(),
      binaryPath,
      source: "apt",
      pendingUpgrade: null,
    });
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    execControl.refuseWithEaccesForPaths = [wellKnownPath, binaryPath];
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: wellKnownPath, args: [] });
    expect(mocks.cliLoggerWarnMock).not.toHaveBeenCalled();
  });

  // The failed-staging fallback prefers an EXISTING slot over the real binary
  // path, because the slot is the one path that survives an upgrade. But
  // "existing" has to mean a regular file. A slot replaced by a DIRECTORY -
  // a botched install, or a hand-rolled `mkdir ~/.traycer/bin/traycer` - is
  // also exactly why staging failed in the first place, since the publish
  // `rename` cannot land on it. Preferring it would answer a staging failure
  // by registering something no supervisor can execute, on a path nothing
  // rewrites afterwards.
  //
  // No rename interception here: the directory makes the real publish fail on
  // its own, which is the point - this is the failure as it actually occurs.
  it.skipIf(process.platform === "win32")(
    "does not register the slot when staging fails because the slot path is a DIRECTORY",
    async () => {
      seaState.current = true;
      const { wellKnownCliBinaryPath } =
        await import("../../store/well-known-cli");
      const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
      mkdirSync(wellKnownPath, { recursive: true });
      writeFileSync(join(wellKnownPath, "not-a-binary"), "occupied");
      const { resolveServiceCliInvocation } = await import("../cli-binary");

      const result = await resolveServiceCliInvocation({
        environment: ENVIRONMENT,
        override: null,
        allowSelfInvocation: false,
      });

      expect(result).toEqual({ command: process.execPath, args: [] });
      expect(result.command).not.toBe(wellKnownPath);
      // Registering a version-scoped path is the recorded worst case, so it
      // must be logged rather than left to surface later as a service that
      // mysteriously stopped launching.
      expect(mocks.cliLoggerWarnMock).toHaveBeenCalledWith(
        "service CLI registered against an unstaged binary path",
        expect.objectContaining({ wellKnownPath }),
      );
    },
  );
});
