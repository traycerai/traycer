import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const stampModule = require("../../../scripts/release-target-stamp.cjs") as {
  readClientTargetStamp: (
    inputPath: string,
    expectedTarget: string,
    component: "cli" | "desktop",
  ) => Record<string, unknown>;
  targetInputFromArg: (
    argv: readonly string[],
    expectedTarget: string,
    required: boolean,
    component: "cli" | "desktop",
  ) => Record<string, unknown> | null;
  resolveReleaseRepoForTarget: (
    raw: unknown,
    releaseTarget: string,
  ) =>
    | { readonly ok: true; readonly repo: string }
    | { readonly ok: false; readonly reason: string };
};

type Stamp = Record<string, unknown>;

const roots: string[] = [];

function writeStamp(stamp: Stamp): string {
  const root = mkdtempSync(join(tmpdir(), "traycer-stamp-test-"));
  roots.push(root);
  const file = join(root, "stamp.json");
  writeFileSync(file, JSON.stringify(stamp), "utf8");
  return file;
}

function cliStamp(): Stamp {
  return {
    target: "staging",
    environment: "staging",
    cloud: {
      traycerServerBaseUrl: "https://api.staging.example",
      authnApiUrl: "https://authn.staging.example",
      cloudUiBaseUrl: "https://app.staging.example",
      relayAttachUrl: "wss://relay.staging.example/attach",
    },
    sentryEnvironment: "staging",
    cliFeedTag: "cli-manifest-staging",
    hostDiscoveryTag: "released-host-versions-staging",
    credentialEnvironmentVariable: "TRAYCER_STAGING_RELEASE_TOKEN",
    credentialSources: ["environment", "github-cli"],
    authorizedOrigins: ["https://github.com", "https://api.github.com"],
    cliInstallRoot: "~/.traycer/cli/staging",
    hostInstallRoot: "~/.traycer/host/staging",
    serviceLabelId: "ai.traycer.host.staging",
    windowsTaskName: "\\Traycer\\Host-Staging",
  };
}

function desktopStamp(): Stamp {
  return {
    ...cliStamp(),
    appId: "ai.traycer.desktop.staging",
    productName: "Traycer Staging",
    protocolScheme: "traycer-staging",
    releaseChannel: "staging",
    mac: {
      bundleName: "Traycer Staging",
      helperBundleId: "ai.traycer.desktop.staging.host",
      launchAgentLabel: "ai.traycer.host.staging.agent",
    },
    windows: {
      appUserModelId: "ai.traycer.desktop.staging",
      executableName: "Traycer-Staging",
      installerDisplayName: "Traycer Staging",
    },
    linux: {
      deb: { packageName: "traycer-staging" },
      rpm: { packageName: "traycer-staging" },
      executableName: "traycer-staging",
      desktopEntryName: "traycer-staging",
    },
    updaterPackageName: "traycer-staging-desktop",
    updaterCacheDirName: "traycer-staging-updater",
    updaterChannel: "latest",
    updaterChannelFiles: ["latest.yml"],
  };
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("readClientTargetStamp", () => {
  it("accepts valid cli and desktop payloads", () => {
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(cliStamp()),
        "staging",
        "cli",
      ),
    ).toMatchObject({ target: "staging" });
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(desktopStamp()),
        "staging",
        "desktop",
      ),
    ).toMatchObject({ target: "staging", productName: "Traycer Staging" });
  });

  it.each([
    "target",
    "environment",
    "cloud",
    "sentryEnvironment",
    "cliFeedTag",
    "hostDiscoveryTag",
    "credentialEnvironmentVariable",
    "credentialSources",
    "authorizedOrigins",
  ])("refuses a cli stamp missing common key %s", (key) => {
    const stamp = cliStamp();
    delete stamp[key];
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(key);
  });

  it.each([
    "cliInstallRoot",
    "hostInstallRoot",
    "serviceLabelId",
    "windowsTaskName",
  ])("refuses a cli stamp missing component key %s", (key) => {
    const stamp = cliStamp();
    delete stamp[key];
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(key);
  });

  it.each([
    ["production", "production"],
    ["qa", "staging"],
    ["staging", "production"],
  ] as const)(
    "refuses target %s when expected target is %s",
    (target, expected) => {
      const stamp = cliStamp();
      stamp.target = target;
      expect(() =>
        stampModule.readClientTargetStamp(writeStamp(stamp), expected, "cli"),
      ).toThrow(/target/);
    },
  );

  it("refuses an environment that differs from target", () => {
    const stamp = cliStamp();
    stamp.environment = "production";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/environment/);
  });

  it("refuses missing cloud keys", () => {
    const stamp = cliStamp();
    delete (stamp.cloud as Stamp).relayAttachUrl;
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow("relayAttachUrl");
  });

  it.each(["mac", "windows", "linux"])(
    "refuses a desktop stamp missing %s",
    (key) => {
      const stamp = desktopStamp();
      delete stamp[key];
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(stamp),
          "staging",
          "desktop",
        ),
      ).toThrow(key);
    },
  );

  it.each([
    ["mac", "bundleName"],
    ["windows", "executableName"],
    ["linux", "deb"],
    ["linux", "rpm"],
  ] as const)("refuses a desktop stamp missing %s.%s", (parent, key) => {
    const stamp = desktopStamp();
    delete (stamp[parent] as Stamp)[key];
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(key);
  });

  it("refuses a desktop stamp with a null scalar appId", () => {
    const stamp = desktopStamp();
    stamp.appId = null;
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/appId/);
  });

  it.each(["credentialSources", "authorizedOrigins"])(
    "refuses a cli stamp whose %s value is not an array",
    (key) => {
      const stamp = cliStamp();
      stamp[key] = null;
      expect(() =>
        stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
      ).toThrow(key);
    },
  );

  it("refuses a desktop stamp whose updaterChannelFiles is not an array", () => {
    const stamp = desktopStamp();
    stamp.updaterChannelFiles = null;
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow("updaterChannelFiles");
  });

  it("refuses null and empty nested scalar leaves", () => {
    for (const value of [null, ""] as const) {
      const cloudStamp = cliStamp();
      (cloudStamp.cloud as Stamp).authnApiUrl = value;
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(cloudStamp),
          "staging",
          "cli",
        ),
      ).toThrow("cloud.authnApiUrl");

      const macStamp = desktopStamp();
      (macStamp.mac as Stamp).bundleName = value;
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(macStamp),
          "staging",
          "desktop",
        ),
      ).toThrow("mac.bundleName");

      const windowsStamp = desktopStamp();
      (windowsStamp.windows as Stamp).executableName = value;
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(windowsStamp),
          "staging",
          "desktop",
        ),
      ).toThrow("windows.executableName");

      const debStamp = desktopStamp();
      ((debStamp.linux as Stamp).deb as Stamp).packageName = value;
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(debStamp),
          "staging",
          "desktop",
        ),
      ).toThrow("linux.deb.packageName");

      const linuxStamp = desktopStamp();
      (linuxStamp.linux as Stamp).executableName = value;
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(linuxStamp),
          "staging",
          "desktop",
        ),
      ).toThrow("linux.executableName");
    }
  });

  it("refuses non-string and empty structured array entries", () => {
    for (const key of ["credentialSources", "authorizedOrigins"] as const) {
      const entryStamp = cliStamp();
      entryStamp[key] = [null];
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(entryStamp),
          "staging",
          "cli",
        ),
      ).toThrow(key);

      const emptyStamp = cliStamp();
      emptyStamp[key] = [];
      expect(() =>
        stampModule.readClientTargetStamp(
          writeStamp(emptyStamp),
          "staging",
          "cli",
        ),
      ).toThrow(key);
    }

    const entryStamp = desktopStamp();
    entryStamp.updaterChannelFiles = [null];
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(entryStamp),
        "staging",
        "desktop",
      ),
    ).toThrow("updaterChannelFiles");

    const emptyStamp = desktopStamp();
    emptyStamp.updaterChannelFiles = [];
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(emptyStamp),
        "staging",
        "desktop",
      ),
    ).toThrow("updaterChannelFiles");
  });

  it("requires cliInstallRoot and windowsTaskName on desktop stamps", () => {
    const stamp = desktopStamp();
    delete stamp.cliInstallRoot;
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/cliInstallRoot/);
  });
});

describe("resolveReleaseRepoForTarget", () => {
  it("requires an explicit repository on staging and defaults production", () => {
    expect(
      stampModule.resolveReleaseRepoForTarget(undefined, "staging").ok,
    ).toBe(false);
    expect(
      stampModule.resolveReleaseRepoForTarget(undefined, "production"),
    ).toEqual({ ok: true, repo: "traycerai/traycer" });
  });

  it.each(["https://github.com/o/r", "owner/repo/extra", "owner"])(
    "rejects malformed repository %s on both targets",
    (raw) => {
      expect(stampModule.resolveReleaseRepoForTarget(raw, "staging").ok).toBe(
        false,
      );
      expect(
        stampModule.resolveReleaseRepoForTarget(raw, "production").ok,
      ).toBe(false);
    },
  );

  it("rejects the production repository on staging but accepts it on production", () => {
    expect(
      stampModule.resolveReleaseRepoForTarget("TraycerAI/Traycer", "staging")
        .ok,
    ).toBe(false);
    expect(
      stampModule.resolveReleaseRepoForTarget(
        "TraycerAI/Traycer",
        "production",
      ),
    ).toEqual({ ok: true, repo: "TraycerAI/Traycer" });
  });
});

describe("targetInputFromArg", () => {
  it("requires --target-input for a required release and returns null otherwise", () => {
    expect(() =>
      stampModule.targetInputFromArg([], "staging", true, "cli"),
    ).toThrow(/--target-input/);
    expect(
      stampModule.targetInputFromArg([], "staging", false, "cli"),
    ).toBeNull();
    expect(
      stampModule.targetInputFromArg(
        [`--target-input=${writeStamp(cliStamp())}`],
        "staging",
        true,
        "cli",
      ),
    ).toMatchObject({ target: "staging" });
  });

  it("refuses an empty --target-input path", () => {
    expect(() =>
      stampModule.targetInputFromArg(
        ["--target-input="],
        "staging",
        true,
        "cli",
      ),
    ).toThrow(/requires a path/);
  });
});
