import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  DATA_BOOTSTRAP_DIRNAME,
  DATA_LOCATION_RECORD_FILENAME,
  DataRootError,
} from "@traycer/protocol/config/data-root";
import {
  cliInstallHomeDir as protocolCliInstallHomeDir,
  hostInstallHomeDir as protocolHostInstallHomeDir,
} from "@traycer/protocol/config/installation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadTrustedKeys } from "../../registry/trusted-keys";
import {
  serviceLabelFor,
  serviceLauncherScriptPath,
} from "../../service/label";
import {
  cliChatPartCacheDir,
  cliHomeDir,
  cliInstallHomeDir,
  cliLockPath,
  cliSharedHomeDir,
  ensureCliHomeDir,
  ensureHostHomeDir,
  ensureTraycerHomeDir,
  hostDevHomeDir,
  hostDevIdentityPoolRoot,
  hostDevRunsRoot,
  hostDownloadCacheDir,
  hostHomeDir,
  hostInstallDir,
  hostPidMetadataPath,
  hostStagingRoot,
  traycerHomeDir,
} from "../paths";

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
    await mkdtemp(join(tmpdir(), "traycer-cli-data-root-test-")),
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
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  return home;
}

async function writeRecordText(home: string, text: string): Promise<void> {
  await mkdir(join(home, DATA_BOOTSTRAP_DIRNAME), { recursive: true });
  await writeFile(
    join(home, DATA_BOOTSTRAP_DIRNAME, DATA_LOCATION_RECORD_FILENAME),
    text,
    "utf8",
  );
}

async function writeRecord(home: string, root: string): Promise<void> {
  await writeRecordText(
    home,
    JSON.stringify({ version: 1, generation: 1, root, migrationId: null }),
  );
}

async function configuredHome(): Promise<{ home: string; root: string }> {
  const home = await freshHome();
  const root = join(home, FIXTURE_ROOT_NAME);
  await mkdir(root);
  await writeRecord(home, root);
  return { home, root };
}

/** [actual path, layout relative to the data root]. */
function layout(): [string, string][] {
  return [
    [traycerHomeDir(), ""],
    [cliSharedHomeDir(), "cli"],
    [cliHomeDir(undefined), "cli"],
    [cliHomeDir("production"), "cli"],
    [cliHomeDir("dev"), join("cli", "dev")],
    [cliInstallHomeDir("production"), "cli"],
    [cliInstallHomeDir("dev"), join("cli", "dev")],
    [cliChatPartCacheDir(), join("cli", "chat-parts")],
    [cliLockPath("production"), join("cli", ".lock")],
    [cliLockPath("staging"), join("cli", "staging", ".lock")],
    [hostHomeDir(undefined), "host"],
    [hostHomeDir("production"), "host"],
    [hostHomeDir("staging"), join("host", "staging")],
    [hostHomeDir("dev"), join("host", "dev")],
    [hostPidMetadataPath(undefined), join("host", "pid.json")],
    [hostDevHomeDir(), join("host", "dev")],
    [hostDevIdentityPoolRoot(), join("host", "dev", "identities")],
    [hostDevRunsRoot(), join("host", "dev-runs")],
    [hostDownloadCacheDir("production"), join("host", "download-cache")],
    [hostStagingRoot("production"), join("host", "install-staging")],
    [hostInstallDir("production"), join("host", "install")],
  ];
}

function expectLayoutUnder(base: string): void {
  for (const [actual, relative] of layout()) {
    expect(actual).toBe(relative === "" ? base : join(base, relative));
  }
  const launcher = serviceLauncherScriptPath(serviceLabelFor("production"));
  expect(launcher.startsWith(join(base, "service") + sep)).toBe(true);
}

function minisignKey(seed: number): { raw: string; keyId: string } {
  const keyId = Buffer.alloc(8, seed);
  const payload = Buffer.concat([
    Buffer.from("Ed", "ascii"),
    keyId,
    Buffer.alloc(32, seed + 1),
  ]);
  return { raw: payload.toString("base64"), keyId: keyId.toString("hex") };
}

describe.skipIf(process.platform === "win32")(
  "CLI store paths follow the data root",
  () => {
    it("uses the historical default paths when no record exists", async () => {
      const home = await freshHome();
      expectLayoutUnder(join(home, ".traycer"));
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });

    it("keeps the same layout under a configured root", async () => {
      const { home, root } = await configuredHome();
      expectLayoutUnder(root);
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });

    it("nests a dev slot under dev-runs in the configured root", async () => {
      const { root } = await configuredHome();
      process.env.DEV_DESKTOP_SLOT = "my-slot";
      expect(hostHomeDir("dev")).toBe(
        join(root, "host", "dev-runs", "my-slot"),
      );
      // The unslotted dev paths do not follow the slot.
      expect(hostDevHomeDir()).toBe(join(root, "host", "dev"));
      expect(hostDevIdentityPoolRoot()).toBe(
        join(root, "host", "dev", "identities"),
      );
      expect(hostDevRunsRoot()).toBe(join(root, "host", "dev-runs"));
      expect(cliInstallHomeDir("dev")).toBe(
        join(root, "cli", "dev-runs", "my-slot"),
      );
      expect(cliLockPath("dev")).toBe(
        join(root, "cli", "dev-runs", "my-slot", ".lock"),
      );
      expect(hostStagingRoot("dev")).toBe(
        join(root, "host", "dev-runs", "my-slot", "install-staging"),
      );
    });

    it("nests a dev slot under dev-runs in the default root", async () => {
      const home = await freshHome();
      process.env.DEV_DESKTOP_SLOT = "my-slot";
      expect(hostHomeDir("dev")).toBe(
        join(home, ".traycer", "host", "dev-runs", "my-slot"),
      );
    });

    it("ignores TRAYCER_DATA_DIR", async () => {
      const stale = await fixtureDir();
      const home = await freshHome();
      process.env.TRAYCER_DATA_DIR = stale;
      expectLayoutUnder(join(home, ".traycer"));

      const configured = await configuredHome();
      process.env.TRAYCER_DATA_DIR = stale;
      expectLayoutUnder(configured.root);
    });

    it("matches the protocol install helpers for every environment", async () => {
      await configuredHome();
      for (const environment of ENVIRONMENTS) {
        expect(cliInstallHomeDir(environment)).toBe(
          protocolCliInstallHomeDir(environment),
        );
        expect(hostHomeDir(environment)).toBe(
          protocolHostInstallHomeDir(environment),
        );
      }
      process.env.DEV_DESKTOP_SLOT = "my-slot";
      expect(cliInstallHomeDir("dev")).toBe(protocolCliInstallHomeDir("dev"));
      expect(hostHomeDir("dev")).toBe(protocolHostInstallHomeDir("dev"));
    });

    it("matches the protocol install helpers under the default root", async () => {
      await freshHome();
      for (const environment of ENVIRONMENTS) {
        expect(cliInstallHomeDir(environment)).toBe(
          protocolCliInstallHomeDir(environment),
        );
        expect(hostHomeDir(environment)).toBe(
          protocolHostInstallHomeDir(environment),
        );
      }
    });

    it("creates directories only inside the configured root", async () => {
      const { home, root } = await configuredHome();
      await ensureTraycerHomeDir();
      await ensureCliHomeDir(undefined);
      await ensureHostHomeDir("production");
      expect(await exists(join(root, "cli"))).toBe(true);
      expect(await exists(join(root, "host"))).toBe(true);
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });

    it("creates the default root on ensureTraycerHomeDir when no record exists", async () => {
      const home = await freshHome();
      await ensureTraycerHomeDir();
      expect(await exists(join(home, ".traycer"))).toBe(true);
    });

    it("throws root-unavailable and creates nothing when the recorded root is missing", async () => {
      const home = await freshHome();
      const root = join(home, "missing drive ✓", "データ");
      await writeRecord(home, root);
      const calls: [string, () => unknown][] = [
        ["traycerHomeDir", () => traycerHomeDir()],
        ["cliSharedHomeDir", () => cliSharedHomeDir()],
        ["cliHomeDir", () => cliHomeDir("production")],
        ["cliInstallHomeDir", () => cliInstallHomeDir("production")],
        ["cliChatPartCacheDir", () => cliChatPartCacheDir()],
        ["cliLockPath", () => cliLockPath("production")],
        ["hostHomeDir", () => hostHomeDir("production")],
        ["hostDevIdentityPoolRoot", () => hostDevIdentityPoolRoot()],
        ["hostDownloadCacheDir", () => hostDownloadCacheDir("production")],
        [
          "serviceLauncherScriptPath",
          () => serviceLauncherScriptPath(serviceLabelFor("production")),
        ],
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
      await expect(ensureTraycerHomeDir()).rejects.toBeInstanceOf(
        DataRootError,
      );
      await expect(ensureCliHomeDir(undefined)).rejects.toBeInstanceOf(
        DataRootError,
      );
      expect(await exists(root)).toBe(false);
      expect(await exists(join(home, "missing drive ✓"))).toBe(false);
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });

    it("imports without throwing on a malformed record; the first path call throws", async () => {
      const home = await freshHome();
      await writeRecordText(home, "{not json");
      vi.resetModules();
      const fresh = await import("../paths");
      const freshDataRoot = await import("@traycer/protocol/config/data-root");
      let caught: unknown = null;
      try {
        fresh.traycerHomeDir();
      } catch (error) {
        caught = error;
      }
      if (!(caught instanceof freshDataRoot.DataRootError)) {
        throw new Error("expected a DataRootError");
      }
      expect(caught.code).toBe("record-malformed");
      expect(() => fresh.cliSharedHomeDir()).toThrow(
        freshDataRoot.DataRootError,
      );
      expect(await exists(join(home, ".traycer"))).toBe(false);
    });
  },
);

describe.skipIf(process.platform === "win32")("service launcher path", () => {
  it("lives under <root>/service/<label id>", async () => {
    const { root } = await configuredHome();
    const label = serviceLabelFor("production");
    const launcher = serviceLauncherScriptPath(label);
    expect(launcher.startsWith(join(root, "service", label.id) + sep)).toBe(
      true,
    );
  });

  it("lives under the default root without a record", async () => {
    const home = await freshHome();
    const label = serviceLabelFor("production");
    expect(
      serviceLauncherScriptPath(label).startsWith(
        join(home, ".traycer", "service", label.id) + sep,
      ),
    ).toBe(true);
  });
});

describe.skipIf(process.platform === "win32")(
  "trusted-key overlay path",
  () => {
    it("reads <root>/cli/host-trusted-pubkeys under a configured root", async () => {
      const { root } = await configuredHome();
      const overlay = join(root, "cli", "host-trusted-pubkeys");
      await mkdir(join(root, "cli"));
      const key = minisignKey(7);
      await writeFile(overlay, `# operator key\n${key.raw}\n`, "utf8");
      const loaded = await loadTrustedKeys();
      expect(loaded.sources).toContain(`file:${overlay}`);
      expect(loaded.keys.map((entry) => entry.keyId)).toContain(key.keyId);
    });

    it("reads ~/.traycer/cli/host-trusted-pubkeys without a record", async () => {
      const home = await freshHome();
      const overlay = join(home, ".traycer", "cli", "host-trusted-pubkeys");
      await mkdir(join(home, ".traycer", "cli"), { recursive: true });
      const key = minisignKey(9);
      await writeFile(overlay, `${key.raw}\n`, "utf8");
      const loaded = await loadTrustedKeys();
      expect(loaded.sources).toContain(`file:${overlay}`);
      expect(loaded.keys.map((entry) => entry.keyId)).toContain(key.keyId);
    });

    it("does not read an overlay left in the old default location when a root is configured", async () => {
      const { home } = await configuredHome();
      const oldOverlay = join(home, ".traycer", "cli", "host-trusted-pubkeys");
      await mkdir(join(home, ".traycer", "cli"), { recursive: true });
      await writeFile(oldOverlay, `${minisignKey(11).raw}\n`, "utf8");
      const loaded = await loadTrustedKeys();
      expect(loaded.sources).not.toContain(`file:${oldOverlay}`);
    });
  },
);
