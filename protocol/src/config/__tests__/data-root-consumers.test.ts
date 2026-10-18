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
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DATA_BOOTSTRAP_DIRNAME,
  DATA_LOCATION_RECORD_FILENAME,
  DataRootError,
} from "../data-root";
import {
  cliInstallHomeDir,
  cliManifestPath,
  hostHeldVersionRecordPath,
  hostInstallDir,
  hostInstallHomeDir,
  hostStagedDir,
} from "../installation";
import { cliConfigDir, cliConfigPath, cliCredentialsPath } from "../paths";

const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "TRAYCER_DATA_DIR",
  "DEV_DESKTOP_SLOT",
];
const FIXTURE_ROOT_NAME = "Traycer Data ✓ データ";

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
    await mkdtemp(join(tmpdir(), "traycer-data-root-consumers-test-")),
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

/** A fresh home (cache is keyed by homedir, so it re-resolves). */
async function freshHome(): Promise<string> {
  const home = await fixtureDir();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
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

function captureError(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

/** Every path this suite covers, for one environment. */
function pathsFor(environment: string): Record<string, string> {
  return {
    cliInstallHomeDir: cliInstallHomeDir(environment),
    cliManifestPath: cliManifestPath(environment),
    hostInstallHomeDir: hostInstallHomeDir(environment),
    hostInstallDir: hostInstallDir(environment),
    hostStagedDir: hostStagedDir(environment),
    hostHeldVersionRecordPath: hostHeldVersionRecordPath(environment),
    cliCredentialsPath: cliCredentialsPath(environment),
  };
}

/** The layout relative to a data root. `slot` applies to the dev environment only. */
function expectedFor(
  base: string,
  environment: string,
  slot: string | null,
): Record<string, string> {
  const sub =
    slot !== null
      ? join("dev-runs", slot)
      : environment === "production"
        ? ""
        : environment;
  const cli = join(base, "cli", sub);
  const host = join(base, "host", sub);
  const credentialsDir =
    environment === "production"
      ? join(base, "cli")
      : join(base, "cli", environment);
  return {
    cliInstallHomeDir: cli,
    cliManifestPath: join(cli, "manifest.json"),
    hostInstallHomeDir: host,
    hostInstallDir: join(host, "install"),
    hostStagedDir: join(host, "staged"),
    hostHeldVersionRecordPath: join(host, "held-host-version.json"),
    cliCredentialsPath: join(credentialsDir, "credentials"),
  };
}

describe.skipIf(process.platform === "win32")(
  "protocol config path consumers",
  () => {
    it("derives the historical default paths when no record exists", async () => {
      const home = await freshHome();
      const base = join(home, ".traycer");
      expect(cliConfigDir()).toBe(join(base, "cli"));
      expect(cliConfigPath()).toBe(join(base, "cli", "config.json"));
      expect(cliCredentialsPath("production")).toBe(
        join(base, "cli", "credentials"),
      );
      expect(cliCredentialsPath("staging")).toBe(
        join(base, "cli", "staging", "credentials"),
      );
      for (const environment of ["production", "staging", "dev"]) {
        expect(pathsFor(environment)).toEqual(
          expectedFor(base, environment, null),
        );
      }
      expect(await exists(base)).toBe(false);
    });

    it("derives the same layout under a configured root", async () => {
      const { root } = await configuredHome();
      expect(cliConfigDir()).toBe(join(root, "cli"));
      expect(cliConfigPath()).toBe(join(root, "cli", "config.json"));
      expect(cliCredentialsPath("production")).toBe(
        join(root, "cli", "credentials"),
      );
      expect(cliCredentialsPath("staging")).toBe(
        join(root, "cli", "staging", "credentials"),
      );
      for (const environment of ["production", "staging", "dev"]) {
        expect(pathsFor(environment)).toEqual(
          expectedFor(root, environment, null),
        );
      }
    });

    it("nests a dev slot under dev-runs, under the configured root", async () => {
      const { root } = await configuredHome();
      process.env.DEV_DESKTOP_SLOT = "my-slot";
      expect(pathsFor("dev")).toEqual(expectedFor(root, "dev", "my-slot"));
      expect(cliInstallHomeDir("dev")).toBe(
        join(root, "cli", "dev-runs", "my-slot"),
      );
      // The slot applies to the dev environment only.
      expect(pathsFor("production")).toEqual(
        expectedFor(root, "production", null),
      );
      expect(pathsFor("staging")).toEqual(expectedFor(root, "staging", null));
    });

    it("nests a dev slot under dev-runs by default", async () => {
      const home = await freshHome();
      process.env.DEV_DESKTOP_SLOT = "my-slot";
      expect(hostInstallHomeDir("dev")).toBe(
        join(home, ".traycer", "host", "dev-runs", "my-slot"),
      );
    });

    it("ignores TRAYCER_DATA_DIR with and without a record", async () => {
      const home = await freshHome();
      const stale = await fixtureDir();
      process.env.TRAYCER_DATA_DIR = stale;
      expect(cliConfigDir()).toBe(join(home, ".traycer", "cli"));
      expect(hostInstallHomeDir("production")).toBe(
        join(home, ".traycer", "host"),
      );

      const configured = await configuredHome();
      process.env.TRAYCER_DATA_DIR = stale;
      expect(cliConfigDir()).toBe(join(configured.root, "cli"));
      expect(hostInstallHomeDir("production")).toBe(
        join(configured.root, "host"),
      );
    });

    it("throws root-unavailable and creates nothing when the recorded root is missing", async () => {
      const home = await freshHome();
      const root = join(home, "missing drive ✓", "データ");
      await writeRecord(home, root);
      const calls: [string, () => unknown][] = [
        ["cliConfigDir", () => cliConfigDir()],
        ["cliConfigPath", () => cliConfigPath()],
        ["cliCredentialsPath", () => cliCredentialsPath("production")],
        ["cliInstallHomeDir", () => cliInstallHomeDir("production")],
        ["cliManifestPath", () => cliManifestPath("staging")],
        ["hostInstallHomeDir", () => hostInstallHomeDir("production")],
        ["hostInstallDir", () => hostInstallDir("production")],
        ["hostStagedDir", () => hostStagedDir("production")],
        [
          "hostHeldVersionRecordPath",
          () => hostHeldVersionRecordPath("production"),
        ],
      ];
      for (const [, run] of calls) {
        const error = captureError(run);
        if (!(error instanceof DataRootError)) {
          throw new Error("expected a DataRootError");
        }
        expect(error.code).toBe("root-unavailable");
      }
      expect(await exists(root)).toBe(false);
      expect(await exists(join(home, "missing drive ✓"))).toBe(false);
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });
  },
);
