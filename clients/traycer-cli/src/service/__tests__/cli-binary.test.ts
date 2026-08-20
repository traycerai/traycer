import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

  it("uses the manifest binaryPath directly when source is npm but the distribution shim env is unset", async () => {
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
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: binaryPath, args: [] });
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
  });

  it("uses the manifest binaryPath directly when source is npm and the shim env is set but the resolving run is packaged (execPath is not an interpreter)", async () => {
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
    const { resolveServiceCliInvocation } = await import("../cli-binary");

    const result = await resolveServiceCliInvocation({
      environment: ENVIRONMENT,
      override: null,
      allowSelfInvocation: false,
    });

    expect(result).toEqual({ command: binaryPath, args: [] });
    // Even a PACKAGED run must never stage the slot on the npm source
    // branch - that branch returns before the packaged self-invocation
    // path is ever reached.
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    expect(existsSync(wellKnownCliBinaryPath(ENVIRONMENT))).toBe(false);
  });

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
