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
