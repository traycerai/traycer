import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DATA_BOOTSTRAP_DIRNAME,
  DATA_LOCATION_RECORD_FILENAME,
  DataRootError,
} from "@traycer/protocol/config/data-root";
import {
  cliInstallHomeDir as protocolCliInstallHomeDir,
  hostInstallDir as protocolHostInstallDir,
  hostInstallHomeDir as protocolHostInstallHomeDir,
  hostInstallRecordPath as protocolHostInstallRecordPath,
  hostStagedDir as protocolHostStagedDir,
} from "@traycer/protocol/config/installation";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../../../config";
import { sandboxHome } from "../../__tests__/sandbox-home";
import { resolvePreferredHostFilePath } from "../../selection/preferred-host-store";
import { resolveDesktopStateFilePath } from "../../windows/desktop-state-store";
import {
  cliLockPath,
  cliSlotRootForEnvironment,
  getHostFsLayout,
} from "../host-paths";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "TRAYCER_DATA_DIR",
  "DEV_DESKTOP_SLOT",
];
const FIXTURE_ROOT_NAME = "Traycer Data ✓ データ";
const ENVIRONMENTS = ["production", "staging", "dev"];

const savedEnv = new Map<string, string | undefined>();
const dirs: string[] = [];

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv.set(key, process.env[key]);
  delete process.env.TRAYCER_DATA_DIR;
  delete process.env.DEV_DESKTOP_SLOT;
});

afterEach(async () => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function fixtureDir(): Promise<string> {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "traycer-desktop-data-root-test-")),
  );
  dirs.push(dir);
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function freshHome(): Promise<string> {
  const home = await fixtureDir();
  sandboxHome(home);
  return home;
}

async function writeRecord(home: string, root: string): Promise<void> {
  await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME), { recursive: true });
  await writeFile(
    join(home, DATA_BOOTSTRAP_DIRNAME, DATA_LOCATION_RECORD_FILENAME),
    JSON.stringify({ version: 1, generation: 1, root, migrationId: null }),
    "utf8",
  );
}

async function configuredHome(): Promise<{ home: string; root: string }> {
  const home = await freshHome();
  const root = join(home, FIXTURE_ROOT_NAME);
  await mkdir(root);
  await writeRecord(home, root);
  return { home, root };
}

/** Where the per-environment desktop files live under a root. */
function environmentBase(root: string): string {
  return config.environment === "production"
    ? root
    : join(root, config.environment);
}

function expectHostPaths(root: string): void {
  for (const environment of ENVIRONMENTS) {
    const layout = getHostFsLayout(environment);
    const hostRoot =
      environment === "production"
        ? join(root, "host")
        : join(root, "host", environment);
    expect(layout.rootDir).toBe(hostRoot);
    expect(layout.pidMetadataFile).toBe(join(hostRoot, "pid.json"));
    expect(layout.installDir).toBe(join(hostRoot, "install"));
    expect(layout.installRecordFile).toBe(
      join(hostRoot, "install", "install.json"),
    );
    expect(layout.stagedDir).toBe(join(hostRoot, "staged"));

    // Parity with the protocol helpers the CLI and host share.
    expect(layout.rootDir).toBe(protocolHostInstallHomeDir(environment));
    expect(layout.installDir).toBe(protocolHostInstallDir(environment));
    expect(layout.installRecordFile).toBe(
      protocolHostInstallRecordPath(environment),
    );
    expect(layout.stagedDir).toBe(protocolHostStagedDir(environment));

    const cliRoot =
      environment === "production"
        ? join(root, "cli")
        : join(root, "cli", environment);
    expect(cliSlotRootForEnvironment(environment)).toBe(cliRoot);
    expect(cliSlotRootForEnvironment(environment)).toBe(
      protocolCliInstallHomeDir(environment),
    );
    expect(cliLockPath(environment)).toBe(join(cliRoot, ".lock"));
  }
  expect(resolveDesktopStateFilePath()).toBe(
    join(environmentBase(root), "desktop-windows.json"),
  );
  expect(resolvePreferredHostFilePath()).toBe(
    join(environmentBase(root), "desktop-preferred-host.json"),
  );
}

describe.skipIf(process.platform === "win32")(
  "desktop host paths follow the data root",
  () => {
    it("uses the historical default paths when no record exists", async () => {
      const home = await freshHome();
      expectHostPaths(join(home, ".traycer"));
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });

    it("keeps the same layout under a configured root", async () => {
      const { home, root } = await configuredHome();
      expectHostPaths(root);
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });

    it("nests a dev slot under dev-runs in the configured root", async () => {
      const { root } = await configuredHome();
      process.env.DEV_DESKTOP_SLOT = "my-slot";
      const layout = getHostFsLayout("dev");
      expect(layout.rootDir).toBe(join(root, "host", "dev-runs", "my-slot"));
      expect(layout.rootDir).toBe(protocolHostInstallHomeDir("dev"));
      expect(cliSlotRootForEnvironment("dev")).toBe(
        join(root, "cli", "dev-runs", "my-slot"),
      );
      expect(cliSlotRootForEnvironment("dev")).toBe(
        protocolCliInstallHomeDir("dev"),
      );
      expect(cliLockPath("dev")).toBe(
        join(root, "cli", "dev-runs", "my-slot", ".lock"),
      );
    });

    it("ignores TRAYCER_DATA_DIR", async () => {
      const stale = await fixtureDir();
      const home = await freshHome();
      process.env.TRAYCER_DATA_DIR = stale;
      expectHostPaths(join(home, ".traycer"));

      const configured = await configuredHome();
      process.env.TRAYCER_DATA_DIR = stale;
      expectHostPaths(configured.root);
    });

    it("throws root-unavailable and creates nothing when the recorded root is missing", async () => {
      const home = await freshHome();
      const root = join(home, "missing drive ✓", "データ");
      await writeRecord(home, root);
      const calls: [string, () => unknown][] = [
        ["getHostFsLayout", () => getHostFsLayout("production")],
        [
          "cliSlotRootForEnvironment",
          () => cliSlotRootForEnvironment("production"),
        ],
        ["cliLockPath", () => cliLockPath("production")],
        ["resolveDesktopStateFilePath", () => resolveDesktopStateFilePath()],
        ["resolvePreferredHostFilePath", () => resolvePreferredHostFilePath()],
      ];
      for (const [name, run] of calls) {
        let caught: unknown = null;
        try {
          run();
        } catch (error) {
          caught = error;
        }
        if (!(caught instanceof DataRootError)) {
          throw new Error(`${name}: expected a DataRootError`);
        }
        expect(caught.code).toBe("root-unavailable");
      }
      expect(await exists(root)).toBe(false);
      expect(await exists(join(home, "missing drive ✓"))).toBe(false);
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });
  },
);
