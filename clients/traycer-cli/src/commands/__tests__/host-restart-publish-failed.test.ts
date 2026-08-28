import type { PathLike } from "node:fs";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Codex P1 #2 (fixed on top of the CLI-014 EXDEV work): `host restart`
// stops the service, calls `finalizePendingCliUpgrade`, and only
// relaunches AFTER it returns. Before this fix, a publication failure
// (full disk, unwritable dir, or - exercised here - a corrupted
// cross-device copy) threw out of `finalizePendingCliUpgrade`, which
// propagated past the relaunch call and left the host STOPPED because a
// bolt-on CLI self-upgrade failed. The fix makes `finalizePendingCliUpgrade`
// return `{status:"publish-failed", ...}` instead of throwing, so
// `restartWithPendingCliUpgradeFinalize` always reaches
// `controller.relaunchAfterRestart(...)`.
//
// This drives the FULL `buildHostRestartCommand`, not just the split-out
// helper (host-restart-finalize.test.ts covers that), specifically to
// observe the rendered `human` string - `humanForRestart` isn't exported,
// so going through the command is the only way to see its output.

const mocks = vi.hoisted(() => ({
  controllerCalls: [] as string[],
  failRenameOnceFor: null as { src: string; dest: string } | null,
  corruptCopyDestSuffix: null as string | null,
  corruptContent: "corrupted-bytes-not-matching-anything",
}));

vi.mock("../../service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../service")>();
  return {
    ...actual,
    createServiceController: () => ({
      install: async () => undefined,
      uninstall: async () => undefined,
      status: async () => ({
        state: "stopped" as const,
        version: null,
        listenUrl: null,
        pid: null,
      }),
      stop: async () => {
        mocks.controllerCalls.push("stop");
      },
      start: async () => {
        mocks.controllerCalls.push("start");
      },
      restart: async () => {
        mocks.controllerCalls.push("restart");
      },
      stopForRestart: async () => {
        mocks.controllerCalls.push("stopForRestart");
        return { forcedRecycle: false };
      },
      relaunchAfterRestart: async () => {
        mocks.controllerCalls.push("relaunchAfterRestart");
      },
    }),
  };
});

// Selectively fails `rename` with EXDEV once, and corrupts the
// destination-side copy `publishAcrossFilesystems` makes - same rig as
// `cli-upgrade-exdev-publish.test.ts`, reused here to reach the
// `publish-failed` outcome through the real (unmocked)
// `finalizePendingCliUpgrade` this restart path calls.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (src: PathLike, dest: PathLike): Promise<void> => {
      const target = mocks.failRenameOnceFor;
      if (target !== null && src === target.src && dest === target.dest) {
        mocks.failRenameOnceFor = null;
        const err = new Error(
          "EXDEV: cross-device link not permitted, rename",
        ) as NodeJS.ErrnoException;
        err.code = "EXDEV";
        throw err;
      }
      return actual.rename(src, dest);
    },
    copyFile: async (
      src: PathLike,
      dest: PathLike,
      mode: number | undefined,
    ): Promise<void> => {
      if (
        mocks.corruptCopyDestSuffix !== null &&
        typeof dest === "string" &&
        dest.includes(mocks.corruptCopyDestSuffix)
      ) {
        await actual.writeFile(dest, mocks.corruptContent);
        return;
      }
      return actual.copyFile(src, dest, mode);
    },
  };
});

// `store/paths` binds its home root from `os.homedir()` at module load.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

import type { CommandContext } from "../../runner/runner";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
let workHome: string;

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: "production",
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    },
    output: {
      progress: vi.fn(),
      human: vi.fn(),
      humanRequired: vi.fn(),
      emitResult: vi.fn(),
      emitError: vi.fn(),
    },
    progress: vi.fn(),
  };
}

function writeManifest(opts: {
  readonly liveBinaryPath: string;
  readonly stagedBinaryPath: string;
  readonly version: string;
}): string {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(cliDir, "manifest.json");
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        version: "1.4.0",
        installedAt: "2026-04-01T00:00:00Z",
        binaryPath: opts.liveBinaryPath,
        source: "manual",
        pendingUpgrade: {
          version: opts.version,
          stagedBinaryPath: opts.stagedBinaryPath,
          stagedAt: "2026-05-10T00:00:00Z",
          reason: "binary-locked",
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
  return manifestPath;
}

describe("host restart survives a CLI upgrade publication failure (Codex P1 #2)", () => {
  beforeEach(() => {
    workHome = mkdtempSync(
      join(tmpdir(), "traycer-host-restart-publish-failed-test-"),
    );
    osHome.current = workHome;
    process.env.HOME = workHome;
    process.env.USERPROFILE = workHome;
    vi.resetModules();
    mocks.controllerCalls = [];
    mocks.failRenameOnceFor = null;
    mocks.corruptCopyDestSuffix = null;
    mocks.corruptContent = "corrupted-bytes-not-matching-anything";
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
    vi.restoreAllMocks();
  });

  it("relaunches the service, does not throw, and the human output names the publication failure, even when the CLI swap could not be published", async () => {
    const liveBinaryPath = join(workHome, "bin", "traycer");
    mkdirSync(join(workHome, "bin"), { recursive: true });
    writeFileSync(liveBinaryPath, "original-live-bytes");

    const stagingDir = join(workHome, "staging");
    mkdirSync(stagingDir, { recursive: true });
    const stagedBinaryPath = join(stagingDir, "traycer-1.5.0");
    writeFileSync(stagedBinaryPath, "staged-new-bytes-1.5.0");

    const manifestPath = writeManifest({
      liveBinaryPath,
      stagedBinaryPath,
      version: "1.5.0",
    });

    mocks.failRenameOnceFor = { src: stagedBinaryPath, dest: liveBinaryPath };
    mocks.corruptCopyDestSuffix = ".traycer-upgrade-";

    const { buildHostRestartCommand } = await import("../host-restart");
    const command = buildHostRestartCommand({ ifIdle: false, force: false });

    // Must resolve, not reject - this is the regression: before the fix
    // the publish failure's CliError propagated out of this call and the
    // relaunch below never ran.
    const result = await command(fakeCtx());

    expect(mocks.controllerCalls).toEqual([
      "stopForRestart",
      "relaunchAfterRestart",
    ]);
    expect(result.data).toMatchObject({
      restarted: true,
      cliUpgrade: {
        status: "publish-failed",
        stagedBinaryPath,
        livePath: liveBinaryPath,
      },
    });
    expect(result.human).toContain("could not publish");
    expect(result.human).toContain(stagedBinaryPath);
    expect(result.human).toContain(liveBinaryPath);
    expect(result.human).toContain("live binary unchanged");

    // The live binary was never touched - the whole point of the fix
    // this test is pinned to is that a bad copy does not corrupt it.
    expect(readFileSync(liveBinaryPath, "utf8")).toBe("original-live-bytes");

    const reread = JSON.parse(readFileSync(manifestPath, "utf8"));
    expect(reread.version).toBe("1.4.0");
    expect(reread.pendingUpgrade).not.toBeNull();
    expect(reread.pendingUpgrade.version).toBe("1.5.0");
    expect(existsSync(stagedBinaryPath)).toBe(true);
  });
});
