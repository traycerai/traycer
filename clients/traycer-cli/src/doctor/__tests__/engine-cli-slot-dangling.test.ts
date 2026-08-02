import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The stable CLI path (`~/.traycer/cli/bin/traycer`) is a symlink the
// Desktop app points into its own bundle; removing or replacing the bundle
// leaves it dangling. `ls` (lstat) still shows the file while executing it
// fails with ENOENT, and the only repair runs at the app's next
// *successful* launch - a state users cannot self-diagnose from the shell.
// Doctor must name that state, and must stay silent for a healthy link or
// a regular-file binary so the probe never becomes noise.
//
// Skipped on Windows: creating symlinks there requires elevation, and the
// desktop stages a real file (not a symlink) into the Windows slot.

// `store/paths` binds its home root from `os.homedir()` at module load.
// Keep the environment mutation below, but redirect `homedir()` too.
const osHome = vi.hoisted(() => ({ current: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => osHome.current || actual.tmpdir() };
});

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_USERPROFILE = process.env.USERPROFILE;

let workHome: string;

beforeEach(() => {
  workHome = mkdtempSync(join(tmpdir(), "traycer-doctor-dangling-test-"));
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
  vi.restoreAllMocks();
  vi.doUnmock("../../manifest/host-install");
  vi.doUnmock("../../host/bootstrap-log");
  vi.doUnmock("../../host/pid-metadata");
  vi.doUnmock("../../service");
});

function stageServiceMocks(hostExecutablePath: string): void {
  vi.doMock("../../manifest/host-install", () => ({
    readHostInstallRecord: () => ({
      version: "1.4.0",
      environment: "production",
      executablePath: hostExecutablePath,
      installedAt: "2026-04-01T00:00:00Z",
      source: "registry",
      archiveSha256: "f".repeat(64),
      signatureKeyId: "registry:prod-2026",
    }),
  }));
  vi.doMock("../../host/bootstrap-log", () => ({
    readBootstrapMarkers: async () => [],
  }));
  vi.doMock("../../host/pid-metadata", () => ({
    readHostPidMetadata: async () => null,
  }));
  vi.doMock("../../service", () => ({
    createServiceController: () => ({
      status: async () => ({
        state: "stopped",
        version: "1.4.0",
        listenUrl: null,
        pid: null,
      }),
      install: async () => undefined,
      uninstall: async () => undefined,
      start: async () => undefined,
      stop: async () => undefined,
      restart: async () => undefined,
    }),
    serviceLabelFor: (environment: string) => ({
      id: `ai.traycer.host.${environment}`,
    }),
  }));
}

function writeManifestFixture(binaryPath: string, source: string): void {
  const cliDir = join(workHome, ".traycer", "cli");
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    join(cliDir, "manifest.json"),
    JSON.stringify({
      version: "1.4.0",
      installedAt: "2026-04-01T00:00:00Z",
      binaryPath,
      source,
      pendingUpgrade: null,
    }),
  );
}

function stageHostExecutable(): string {
  const hostExecutablePath = join(workHome, "host-bin", "host");
  mkdirSync(join(workHome, "host-bin"), { recursive: true });
  writeFileSync(hostExecutablePath, "host-bin");
  return hostExecutablePath;
}

describe.runIf(process.platform !== "win32")(
  "runDoctor dangling CLI slot symlink",
  () => {
    it("names the dangling-symlink state with the app-relaunch repair for a desktop-staged CLI", async () => {
      stageServiceMocks(stageHostExecutable());
      const binDir = join(workHome, ".traycer", "cli", "bin");
      mkdirSync(binDir, { recursive: true });
      const slotPath = join(binDir, "traycer");
      const goneTarget = join(workHome, "Traycer.app-removed", "traycer");
      symlinkSync(goneTarget, slotPath);
      writeManifestFixture(slotPath, "desktop");

      const { runDoctor } = await import("../engine");
      const result = await runDoctor({
        environment: "production",
        portConflictDeps: null,
      });

      const issue = result.issues.find(
        (i) => i.code === "CLI_SLOT_BINARY_DANGLING",
      );
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe("warning");
      // Both halves of the confusing state, named: the path the user can
      // see, and the target that no longer exists.
      expect(issue?.message).toContain(slotPath);
      expect(issue?.message).toContain(goneTarget);
      expect(issue?.message).toContain("no such file or directory");
      // Desktop-staged slot: the working repair is relaunching the app.
      expect(issue?.message).toContain("Traycer Desktop app");
      // No CLI subcommand repairs the slot - the app does. A fixAction
      // here would be a button that cannot work.
      expect(issue?.fixAction).toBeNull();
      expect(issue?.terminalCommand).toBeNull();
      expect(issue?.details).toMatchObject({
        binaryPath: slotPath,
        linkTarget: goneTarget,
        installSource: "desktop",
      });
    });

    it("stays silent for a symlink whose target exists", async () => {
      stageServiceMocks(stageHostExecutable());
      const binDir = join(workHome, ".traycer", "cli", "bin");
      mkdirSync(binDir, { recursive: true });
      const realBinary = join(workHome, "Traycer.app", "traycer");
      mkdirSync(join(workHome, "Traycer.app"), { recursive: true });
      writeFileSync(realBinary, "cli-bin");
      const slotPath = join(binDir, "traycer");
      symlinkSync(realBinary, slotPath);
      writeManifestFixture(slotPath, "desktop");

      const { runDoctor } = await import("../engine");
      const result = await runDoctor({
        environment: "production",
        portConflictDeps: null,
      });

      expect(
        result.issues.find((i) => i.code === "CLI_SLOT_BINARY_DANGLING"),
      ).toBeUndefined();
    });

    it("stays silent for a regular-file binary (package-manager installs)", async () => {
      stageServiceMocks(stageHostExecutable());
      const binDir = join(workHome, ".traycer", "cli", "bin");
      mkdirSync(binDir, { recursive: true });
      const slotPath = join(binDir, "traycer");
      writeFileSync(slotPath, "cli-bin");
      writeManifestFixture(slotPath, "manual");

      const { runDoctor } = await import("../engine");
      const result = await runDoctor({
        environment: "production",
        portConflictDeps: null,
      });

      expect(
        result.issues.find((i) => i.code === "CLI_SLOT_BINARY_DANGLING"),
      ).toBeUndefined();
    });
  },
);
