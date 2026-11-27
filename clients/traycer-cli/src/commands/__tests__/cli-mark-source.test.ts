import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Environment } from "../../runner/environment";
import type { CommandContext } from "../../runner/runner";
import type { CliInstallManifest } from "../../manifest/cli-manifest";
import type { WellKnownCliStageOutcome } from "../../store/well-known-cli";
import { CLI_ERROR_CODES } from "../../runner/errors";

// `writeMarkSource` (shared by `cli mark-source` and `cli re-anchor`) is the
// single writer of both the CLI install manifest and the well-known slot
// (`<cliInstallHomeDir>/bin/traycer`) that the host daemon's own CLI
// discovery reads exclusively. A review caught that it used to stage that
// slot UNCONDITIONALLY - including for the npm distribution, which ships a
// `#!/usr/bin/env node`-shebanged bundle, not an executable. Copying that
// into the slot would leave the host spawning a script that resolves `node`
// off the SERVICE MANAGER's PATH (not the interactive shell's), and on
// Windows would put JavaScript behind `traycer.exe`. The fix taught
// `isInterpreterDistribution` (well-known-cli.ts) to identify npm and made
// this function skip staging for it - reported as `staged: "not-applicable"`
// rather than silently dropped, since the host stays unable to see the
// install either way and callers must be able to surface that.
//
// No prior behavioral suite covered `writeMarkSource` at all, so this file
// exercises it directly against a real tmp HOME - the manifest write and
// slot staging both run for real, not mocked - with only the CLI lock
// replaced by a pass-through, mirroring
// `commands/__tests__/cli-finalize-upgrade.test.ts`. Two cases matter: npm
// must NOT stage the slot, and a non-interpreter source (homebrew) MUST
// still stage it byte-for-byte. The second case is what makes the first
// meaningful - without it, a `writeMarkSource` that simply never staged
// anything would pass the npm case too.

const osHome = vi.hoisted(() => ({ current: "" }));
const sea = vi.hoisted(() => ({ packaged: false }));
vi.mock("node:sea", () => ({ isSea: () => sea.packaged }));
vi.mock("../../registry/cli-versions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../registry/cli-versions")>()),
  fetchCliVersions: async () => {
    throw new Error("offline");
  },
}));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

// `withCliLock` acquires a real cross-process file lock under
// `cliInstallHomeDir`. Each test here gets its own tmp HOME, so there is
// never real contention - but neighbouring command suites
// (`cli-finalize-upgrade.test.ts`) still replace it with a pass-through that
// just runs `fn()` and records the call, and this suite follows that same
// shape rather than inventing a new one.
const lockMocks = vi.hoisted(() => ({
  calls: [] as Array<{ reason: string }>,
}));
vi.mock("../../store/cli-lock", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../store/cli-lock")>();
  return {
    ...actual,
    withCliLock: async <T>(
      opts: { reason: string },
      fn: () => Promise<T>,
    ): Promise<T> => {
      lockMocks.calls.push({ reason: opts.reason });
      return fn();
    },
  };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;
const ENVIRONMENT: Environment = "production";
let workHome: string;

function fakeCtx(): CommandContext {
  return {
    runtime: {
      json: false,
      quiet: false,
      noProgress: false,
      noBootstrap: false,
      nonInteractive: false,
      environment: ENVIRONMENT,
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

// Mirrors the `data` shape `writeMarkSource` returns (cli-mark-source.ts) -
// `CommandResult.data` is `unknown` on the wire, and there is no shared
// exported type for a single command's own payload.
interface WriteMarkSourceData {
  readonly previous: CliInstallManifest | null;
  readonly current: CliInstallManifest;
  readonly wellKnown: WellKnownCliStageOutcome;
}

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-cli-mark-source-test-"));
  osHome.current = workHome;
  process.env.HOME = workHome;
  process.env.USERPROFILE = workHome;
  lockMocks.calls = [];
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

describe("writeMarkSource", () => {
  it("for an npm (interpreter) source, writes the manifest but leaves the well-known slot empty", async () => {
    const { writeMarkSource } = await import("../cli-mark-source");
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const { readCliManifest } = await import("../../manifest/cli-manifest");

    const anchoredBinary = join(workHome, "npm-cli-bundle.js");
    writeFileSync(
      anchoredBinary,
      "#!/usr/bin/env node\nconsole.log('npm-distributed CLI bundle');\n",
      { mode: 0o644 },
    );

    const result = await writeMarkSource({
      ctx: fakeCtx(),
      source: "npm",
      binaryPath: anchoredBinary,
      version: "1.4.0",
      reason: "cli-mark-source",
    });

    expect(result.exitCode).toBe(0);
    expect(lockMocks.calls).toEqual([{ reason: "cli-mark-source" }]);

    const data = result.data as WriteMarkSourceData;
    expect(data.previous).toBeNull();
    expect(data.wellKnown.staged).toBe("not-applicable");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    expect(data.wellKnown.wellKnownPath).toBe(wellKnownPath);

    // The primary contract - the manifest - still gets written even though
    // slot staging is skipped.
    expect(data.current.source).toBe("npm");
    expect(data.current.version).toBe("1.4.0");
    expect(data.current.binaryPath).toBe(anchoredBinary);
    const persisted = await readCliManifest(ENVIRONMENT);
    expect(persisted).toEqual(data.current);

    // The hole the review caught: the well-known slot must stay untouched.
    // Staging an interpreter bundle there is worse than an empty slot - see
    // `isInterpreterDistribution`'s comment in well-known-cli.ts.
    expect(existsSync(wellKnownPath)).toBe(false);

    if (result.human === null) {
      throw new Error("expected human output for a non-json run");
    }
    expect(result.human).toContain("note:");
    expect(result.human).toContain(wellKnownPath);
  });

  // The state Codex flagged: anchoring to npm on a machine that already has
  // an executable in the slot. It is deliberately NOT deleted - the host
  // daemon and any registered service launch from it, so removing it would
  // break a working machine - but the message must say what is really
  // running rather than claim the interpreter now serves the host.
  it("for an npm source over an EXISTING slot, warns that the prior executable is still what runs", async () => {
    const { writeMarkSource } = await import("../cli-mark-source");
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");

    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(wellKnownPath), { recursive: true });
    writeFileSync(wellKnownPath, "previously anchored homebrew executable");

    const anchoredBinary = join(workHome, "npm-cli-bundle.js");
    writeFileSync(
      anchoredBinary,
      "#!/usr/bin/env node\nconsole.log('npm bundle');\n",
      { mode: 0o644 },
    );

    const result = await writeMarkSource({
      ctx: fakeCtx(),
      source: "npm",
      binaryPath: anchoredBinary,
      version: "1.4.0",
      reason: "cli-mark-source",
    });

    const data = result.data as WriteMarkSourceData;
    expect(data.wellKnown.staged).toBe("not-applicable");
    // Left in place, not retired.
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      "previously anchored homebrew executable",
    );
    if (result.human === null) {
      throw new Error("expected human output for a non-json run");
    }
    expect(result.human).toContain("warning:");
    expect(result.human).toContain("still holds the previously anchored");
    expect(result.human).not.toContain(
      "the service runs the CLI through its interpreter",
    );
  });

  it("for a non-interpreter source (homebrew), writes the manifest AND stages the slot with the anchored binary's bytes", async () => {
    const { writeMarkSource } = await import("../cli-mark-source");
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const { readCliManifest } = await import("../../manifest/cli-manifest");

    const anchoredBinary = join(workHome, "homebrew-traycer-binary");
    writeFileSync(anchoredBinary, "pretend-native-executable-bytes", {
      mode: 0o755,
    });

    const result = await writeMarkSource({
      ctx: fakeCtx(),
      source: "homebrew",
      binaryPath: anchoredBinary,
      version: "2.0.0",
      reason: "cli-mark-source",
    });

    expect(result.exitCode).toBe(0);
    expect(lockMocks.calls).toEqual([{ reason: "cli-mark-source" }]);

    const data = result.data as WriteMarkSourceData;
    expect(data.previous).toBeNull();
    expect(data.wellKnown.staged).toBe("staged");
    const wellKnownPath = wellKnownCliBinaryPath(ENVIRONMENT);
    expect(data.wellKnown.wellKnownPath).toBe(wellKnownPath);

    expect(data.current.source).toBe("homebrew");
    const persisted = await readCliManifest(ENVIRONMENT);
    expect(persisted).toEqual(data.current);

    // This is what makes the npm case above meaningful: a `writeMarkSource`
    // that never staged anything would also pass an "empty slot" assertion.
    // The slot must be a regular-file COPY (never a symlink - see
    // `stageWellKnownCliBinary`'s doc comment) holding exactly the anchored
    // binary's bytes.
    expect(existsSync(wellKnownPath)).toBe(true);
    const slotStat = await lstat(wellKnownPath);
    expect(slotStat.isSymbolicLink()).toBe(false);
    expect(slotStat.isFile()).toBe(true);
    expect(readFileSync(wellKnownPath, "utf8")).toBe(
      readFileSync(anchoredBinary, "utf8"),
    );

    // No "note:" line - that's exclusive to the not-applicable outcome.
    if (result.human === null) {
      throw new Error("expected human output for a non-json run");
    }
    expect(result.human).not.toContain("note:");
    expect(result.human).toBe(
      `marked CLI as homebrew-owned at ${anchoredBinary} (version 2.0.0)`,
    );
  });
});

describe("Windows publication with an unattended task", () => {
  async function setupBootSlot() {
    const platform = Object.getOwnPropertyDescriptor(process, "platform");
    const execPath = Object.getOwnPropertyDescriptor(process, "execPath");
    if (platform === undefined || execPath === undefined)
      throw new Error("missing process properties");
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const windows = await import("../../service/platforms/windows");
    const { serviceLabelFor } = await import("../../service/label");
    const { wellKnownCliBinaryPath } =
      await import("../../store/well-known-cli");
    const { writeCliManifest, readCliManifest } =
      await import("../../manifest/cli-manifest");
    const slot = wellKnownCliBinaryPath(ENVIRONMENT);
    mkdirSync(dirname(slot), { recursive: true });
    writeFileSync(slot, "installed CLI image");
    const manifest: CliInstallManifest = {
      version: "recorded-build-without-release-order",
      source: "manual",
      binaryPath: slot,
      installedAt: "2026-01-01T00:00:00.000Z",
      pendingUpgrade: null,
    };
    await writeCliManifest(ENVIRONMENT, manifest);
    const sid = "S-1-5-21-1000-2000-3000-1001";
    const xml = windows.buildScheduledTaskXml(
      {
        cli: { command: slot, args: [] },
        label: serviceLabelFor(ENVIRONMENT),
        windowsBootRunLevel: "LeastPrivilege",
      },
      sid,
      true,
    );
    windows.setWindowsTaskUserSidReaderForTests(() => sid);
    windows.setWindowsDefinitionDepsForTests({
      queryTaskXml: async () => ({ kind: "xml", xml }),
      predictCli: async () => {
        throw new Error("unexpected prediction");
      },
      resolveCli: async () => {
        throw new Error("unexpected resolution");
      },
    });
    return {
      slot,
      manifest,
      readManifest: () => readCliManifest(ENVIRONMENT),
      restore: () => {
        windows.setWindowsDefinitionDepsForTests(null);
        windows.setWindowsTaskUserSidReaderForTests(null);
        Object.defineProperty(process, "execPath", execPath);
        Object.defineProperty(process, "platform", platform);
        sea.packaged = false;
      },
    };
  }

  it("refuses a real re-anchor with incomparable versions and leaves the boot slot and anchor intact", async () => {
    const boot = await setupBootSlot();
    try {
      const { buildCliReAnchorCommand } = await import("../cli-re-anchor");
      const binaryPath = join(workHome, "manual.exe");
      writeFileSync(binaryPath, "different, unauthenticated image");
      await expect(
        buildCliReAnchorCommand({
          binaryPath,
          version: "local-build-without-release-order",
        })(fakeCtx()),
      ).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
      });
      expect(await boot.readManifest()).toEqual(boot.manifest);
      expect(readFileSync(boot.slot, "utf8")).toBe("installed CLI image");
    } finally {
      boot.restore();
    }
  });

  it("requires the boot capability in the packaged image that Desktop asks to publish itself", async () => {
    const boot = await setupBootSlot();
    try {
      const { buildPublishDesktopSlotCommand } =
        await import("../cli-mark-source");
      const binaryPath = join(workHome, "bundle", "traycer.exe");
      mkdirSync(dirname(binaryPath), { recursive: true });
      const header = Buffer.alloc(68);
      header.write("MZ");
      header.writeUInt32LE(64, 0x3c);
      header.write("PE\0\0", 64);
      writeFileSync(binaryPath, header);
      sea.packaged = true;
      Object.defineProperty(process, "execPath", { value: binaryPath });
      const command = buildPublishDesktopSlotCommand("desktop");
      await expect(command(fakeCtx())).rejects.toMatchObject({
        code: CLI_ERROR_CODES.CLI_UPGRADE_BOOT_TASK_UNSUPPORTED,
      });
      expect(await boot.readManifest()).toEqual(boot.manifest);
      expect(readFileSync(boot.slot, "utf8")).toBe("installed CLI image");

      const image = Buffer.concat([
        header,
        readFileSync(
          new URL(
            "../../../scripts/windows-boot-task-capability.txt",
            import.meta.url,
          ),
        ),
      ]);
      writeFileSync(binaryPath, image);
      await expect(command(fakeCtx())).resolves.toMatchObject({ exitCode: 0 });
      expect(await boot.readManifest()).toMatchObject({
        source: "desktop",
        binaryPath: boot.slot,
      });
      expect(readFileSync(boot.slot)).toEqual(image);
    } finally {
      boot.restore();
    }
  });
});
