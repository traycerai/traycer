import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { cliLockPath } from "../../host/host-paths";

// The slot used to be a POSIX symlink into the .app bundle - field report
// 5's "file exists but won't run": remove or replace the bundle and the
// link dangles, `ls`/lstat still succeed, exec fails ENOENT, and the only
// healer ran at the next *successful* app launch - circular exactly when
// the app is the broken part. The slot is now a COPY on every platform.
// These tests pin the property that closes the class: the staged binary
// must survive its bundled source disappearing.

vi.mock("electron-log", () => ({
  default: {
    transports: {
      file: { level: "info" },
      console: { level: "info" },
    },
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: (): string => "/tmp/desktop-app",
  },
}));

vi.mock("../../../config", async (importActual) => {
  const actual = await importActual<typeof import("../../../config")>();
  return {
    ...actual,
    isDevBuild: false,
    config: { ...actual.config, environment: "production" },
  };
});

// Change 2 (`installBundledCli` takes the CLI lock): `publishBundledCli`
// makes exactly one top-level `node:fs/promises` write once the binary
// itself is staged - the manifest write. (The lock's own metadata write
// goes through a `FileHandle.writeFile()` method on the handle `open()`
// returns, never this named export, so intercepting the export cannot see
// the lock writing its own metadata.) Observing lock-file existence at that
// exact moment is an in-process seam for "was the lock still held while the
// manifest was written", without changing production code.
const manifestWriteObserved = vi.hoisted(() => ({
  lockPathToCheck: null as string | null,
  sawLockDuringManifestWrite: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const mockedWriteFile = async (
    path: PathLike,
    data: string,
    encoding: BufferEncoding,
  ): Promise<void> => {
    if (manifestWriteObserved.lockPathToCheck !== null) {
      manifestWriteObserved.sawLockDuringManifestWrite = existsSync(
        manifestWriteObserved.lockPathToCheck,
      );
    }
    await actual.writeFile(path, data, encoding);
  };
  const mocked = {
    ...actual,
    writeFile: mockedWriteFile,
  };
  // Mirror the override onto `default` too - Vite/esbuild's CJS interop can
  // read `default.writeFile` rather than the top-level named export
  // (`clients/desktop/src/electron-main/windows/__tests__/desktop-state-store.test.ts`
  // hits the identical gotcha), and a plain spread of the real namespace
  // would otherwise leave the un-mocked implementation reachable there,
  // silently missing every call `cli-discovery.ts` makes.
  return { ...mocked, default: mocked };
});

let work: string;
let homeDir: string;

const CLI_BINARY_NAME =
  process.platform === "win32" ? "traycer.exe" : "traycer";

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "traycer-install-bundled-cli-"));
  homeDir = join(work, "home");
  mkdirSync(homeDir, { recursive: true });
  sandboxHome(homeDir);
  vi.resetModules();
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.resetModules();
});

function stageBundled(content: string): string {
  const bundleCliDir = join(
    work,
    "Traycer.app",
    "Contents",
    "Resources",
    "cli",
  );
  mkdirSync(bundleCliDir, { recursive: true });
  const bundled = join(bundleCliDir, CLI_BINARY_NAME);
  writeFileSync(bundled, content);
  return bundled;
}

describe("installBundledCli stages a copy that outlives the bundle", () => {
  it("stages a regular executable file (never a symlink) and writes the manifest", async () => {
    const bundled = stageBundled("cli-bytes-v1");
    const { installBundledCli } = await import("../cli-discovery");

    const stable = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    expect(lstatSync(stable).isSymbolicLink()).toBe(false);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v1");
    if (process.platform !== "win32") {
      expect(statSync(stable).mode & 0o111).not.toBe(0);
    }
    const manifest: { binaryPath: string; version: string } = JSON.parse(
      readFileSync(join(homeDir, ".traycer", "cli", "manifest.json"), "utf8"),
    );
    expect(manifest.binaryPath).toBe(stable);
    expect(manifest.version).toBe("1.0.0");
  });

  it("keeps working after the bundle is deleted - the exact class of field report 5", async () => {
    const bundled = stageBundled("cli-bytes-v1");
    const { installBundledCli } = await import("../cli-discovery");
    const stable = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    rmSync(join(work, "Traycer.app"), { recursive: true, force: true });

    // `stat` FOLLOWS links: with the old symlink staging this is exactly
    // where ENOENT surfaced while lstat (and `ls`) kept succeeding.
    expect(statSync(stable).size).toBeGreaterThan(0);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v1");
  });

  it.runIf(process.platform !== "win32")(
    "replaces a legacy dangling symlink from the pre-copy era with a real copy",
    async () => {
      const bundled = stageBundled("cli-bytes-v2");
      const binDir = join(homeDir, ".traycer", "cli", "bin");
      mkdirSync(binDir, { recursive: true });
      const legacySlot = join(binDir, "traycer");
      symlinkSync(join(work, "removed-bundle-target"), legacySlot);

      const { installBundledCli } = await import("../cli-discovery");
      const stable = await installBundledCli({
        bundledCliPath: bundled,
        version: "2.0.0",
        source: "desktop",
      });

      expect(stable).toBe(legacySlot);
      expect(lstatSync(stable).isSymbolicLink()).toBe(false);
      expect(readFileSync(stable, "utf8")).toBe("cli-bytes-v2");
    },
  );
});

describe("installBundledCli takes the CLI lock", () => {
  afterEach(() => {
    manifestWriteObserved.lockPathToCheck = null;
    manifestWriteObserved.sawLockDuringManifestWrite = false;
  });

  it("holds the lock file while writing the manifest and releases it once the call resolves", async () => {
    const bundled = stageBundled("cli-bytes-lock-held");
    const lockPath = cliLockPath("production");
    manifestWriteObserved.lockPathToCheck = lockPath;
    const { installBundledCli } = await import("../cli-discovery");
    const { default: electronLogMock } = await import("electron-log");

    expect(existsSync(lockPath)).toBe(false);

    const stable = await installBundledCli({
      bundledCliPath: bundled,
      version: "1.0.0",
      source: "desktop",
    });

    // The lock file existed at the moment the manifest write ran (inside the
    // locked section) and is gone again once installBundledCli resolved -
    // acquired and released for exactly this call.
    expect(manifestWriteObserved.sawLockDuringManifestWrite).toBe(true);
    expect(existsSync(lockPath)).toBe(false);
    expect(readFileSync(stable, "utf8")).toBe("cli-bytes-lock-held");
    // No contention on this call: the fast, uncontended path never logs the
    // best-effort fallback warning.
    expect(electronLogMock.warn).not.toHaveBeenCalled();
  });
});

describe("installBundledCli proceeds past lock contention", () => {
  // A holder record that stays un-breakable for the WHOLE 15s wait
  // (`CLI_SLOT_LOCK_WAIT_MS` in cli-discovery.ts): `cross-process-lock.ts`
  // only ever breaks a lock on POSITIVE evidence - the holder's pid is dead,
  // or a fresh identity read positively mismatches the recorded one - and an
  // "indeterminate" verdict waits regardless of age. Recording THIS
  // process's own pid with no `processStartIdentity` hits that branch
  // deterministically on every platform: `verifyOwnProcessIdentity` compares
  // the recorded `null` identity against this process's real one via
  // `compareProcessStartIdentity`, which returns "unknown" whenever either
  // side is `null` - true here no matter whether the real identity probe
  // itself succeeds on this machine. A plain EMPTY lock file would NOT work
  // for this: an empty/corrupt lock is judged solely by age
  // (`EMPTY_LOCK_GRACE_MS` = 5s) and would be broken well before the 15s
  // deadline, producing no contention at all.
  function writeUnbreakableHolderLock(lockPath: string): void {
    mkdirSync(dirname(lockPath), { recursive: true });
    const metadata = {
      pid: process.pid,
      reason: "external-test-holder",
      startedAt: new Date().toISOString(),
      hostname: null,
      token: "external-test-token",
      processStartedAtMs: null,
      processStartIdentity: null,
    };
    writeFileSync(lockPath, JSON.stringify(metadata, null, 2), "utf8");
  }

  it("publishes the binary and writes the manifest after the lock wait elapses", async () => {
    const bundled = stageBundled("cli-bytes-contended");
    const lockPath = cliLockPath("production");
    writeUnbreakableHolderLock(lockPath);
    const { installBundledCli } = await import("../cli-discovery");
    const { default: electronLogMock } = await import("electron-log");

    vi.useFakeTimers();
    try {
      let settled = false;
      let settledValue: string | null = null;
      let settledError: unknown = null;
      installBundledCli({
        bundledCliPath: bundled,
        version: "1.0.0",
        source: "desktop",
      }).then(
        (value) => {
          settled = true;
          settledValue = value;
        },
        (error: unknown) => {
          settled = true;
          settledError = error;
        },
      );
      // Fast-forward past the 15s wait (`CLI_SLOT_LOCK_WAIT_MS` in
      // cli-discovery.ts) without a real wall-clock wait. A single large
      // jump does not work here: at the moment it runs, the poll loop has
      // not yet scheduled its first `setTimeout` (it is still awaiting the
      // real, unmocked lock-read I/O ahead of it), so the jump finds
      // nothing pending, fast-forwards the reported clock, and returns
      // immediately - after which the loop's later, real `setTimeout` calls
      // target a fake "now" that nothing is advancing anymore and never
      // fire. Pumping in small increments instead lets each new
      // `setTimeout` the loop schedules get caught by a later pump, with
      // real I/O interleaved between pumps (the `Async` variant yields to
      // it).
      for (let pump = 0; pump < 300 && !settled; pump += 1) {
        await vi.advanceTimersByTimeAsync(100);
      }
      if (!settled) {
        throw new Error(
          "installBundledCli did not settle after pumping fake timers past the lock wait",
        );
      }
      if (settledError !== null) {
        throw settledError;
      }
      if (settledValue === null) {
        throw new Error("installBundledCli resolved without a value");
      }
      const stable = settledValue;

      expect(readFileSync(stable, "utf8")).toBe("cli-bytes-contended");
      const manifest: { binaryPath: string; version: string } = JSON.parse(
        readFileSync(join(homeDir, ".traycer", "cli", "manifest.json"), "utf8"),
      );
      expect(manifest.binaryPath).toBe(stable);
      expect(manifest.version).toBe("1.0.0");
      // The pre-created holder lock was never touched by the best-effort
      // fallback - proving this went through the "busy" branch rather than
      // somehow acquiring or breaking the contended lock.
      expect(readFileSync(lockPath, "utf8")).toContain("external-test-token");
      expect(electronLogMock.warn).toHaveBeenCalledWith(
        "[cli] publishing bundled CLI without the cli-lock",
        expect.objectContaining({
          lockPath,
          holderPid: process.pid,
          holderReason: "external-test-holder",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
