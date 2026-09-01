import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const desktopRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const clientsRoot = resolve(desktopRoot, "..");
const roots: string[] = [];
interface Fixture {
  readonly root: string;
  readonly projectDir: string;
  readonly configPath: string;
  readonly targetInputPath: string;
  readonly stampPath: string;
}

function stamp(): Record<string, unknown> {
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

function createFixture(component: "desktop" | "cli"): Fixture {
  const root = mkdtempSync(join(tmpdir(), "traycer-set-target-test-"));
  roots.push(root);
  const projectName = component === "desktop" ? "desktop" : "traycer-cli";
  const projectDir = join(root, "clients", projectName);
  const scriptsDir = join(root, "clients", "scripts");
  mkdirSync(join(projectDir, "scripts"), { recursive: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(scriptsDir, { recursive: true });
  cpSync(
    join(clientsRoot, projectName, "scripts", "set-deploy-target.cjs"),
    join(projectDir, "scripts", "set-deploy-target.cjs"),
  );
  cpSync(
    join(clientsRoot, "scripts", "rewrite-config-target.cjs"),
    join(scriptsDir, "rewrite-config-target.cjs"),
  );
  cpSync(
    join(clientsRoot, "scripts", "release-target-stamp.cjs"),
    join(scriptsDir, "release-target-stamp.cjs"),
  );
  const configPath = join(projectDir, "src", "config.ts");
  cpSync(join(clientsRoot, projectName, "src", "config.ts"), configPath);
  // CI writes the descriptor payload beside the checkout (`client-target.json`)
  // and passes it via `--target-input`; only the desktop stamper copies it to
  // `.release-target-stamp.json` for electron-builder and the afterPack hook.
  const targetInputPath = join(root, "client-target.json");
  writeFileSync(targetInputPath, JSON.stringify(stamp()), "utf8");
  const stampPath = join(projectDir, ".release-target-stamp.json");
  return { root, projectDir, configPath, targetInputPath, stampPath };
}

function run(fixture: Fixture, args: readonly string[]) {
  return spawnSync(
    process.execPath,
    [join(fixture.projectDir, "scripts", "set-deploy-target.cjs"), ...args],
    {
      cwd: fixture.projectDir,
      encoding: "utf8",
      env: {
        ...process.env,
        TRAYCER_RELEASE_REPO: "acme/private-traycer",
        TRAYCER_DESKTOP_SENTRY_DSN: "https://sentry/staging",
        TRAYCER_DESKTOP_SENTRY_RENDERER_DSN: "https://sentry-renderer/staging",
      },
    },
  );
}

function runWithoutReleaseRepo(fixture: Fixture, args: readonly string[]) {
  const env = {
    ...process.env,
    TRAYCER_DESKTOP_SENTRY_DSN: "https://sentry/staging",
    TRAYCER_DESKTOP_SENTRY_RENDERER_DSN: "https://sentry-renderer/staging",
  };
  Reflect.deleteProperty(env, "TRAYCER_RELEASE_REPO");
  Reflect.deleteProperty(env, "RELEASE_REPO");
  return spawnSync(
    process.execPath,
    [join(fixture.projectDir, "scripts", "set-deploy-target.cjs"), ...args],
    {
      cwd: fixture.projectDir,
      encoding: "utf8",
      env,
    },
  );
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("set-deploy-target scripts", () => {
  it("requires target input for staging", () => {
    const fixture = createFixture("desktop");
    const result = run(fixture, ["--target=staging"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--target-input");
  });

  it("requires a release repository for staging desktop targets", () => {
    const fixture = createFixture("desktop");
    const result = runWithoutReleaseRepo(fixture, [
      "--target=staging",
      `--target-input=${fixture.targetInputPath}`,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TRAYCER_RELEASE_REPO");
  });

  it("requires a release repository for staging CLI targets", () => {
    const fixture = createFixture("cli");
    const result = runWithoutReleaseRepo(fixture, [
      "--target=staging",
      `--target-input=${fixture.targetInputPath}`,
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("TRAYCER_RELEASE_REPO");
  });

  it("stamps and restores the desktop config in an isolated copy", () => {
    const fixture = createFixture("desktop");
    const original = readFileSync(fixture.configPath, "utf8");
    const staged = run(fixture, [
      "--target=staging",
      `--target-input=${fixture.targetInputPath}`,
    ]);
    expect(staged.status).toBe(0);
    expect(existsSync(fixture.stampPath)).toBe(true);
    const source = readFileSync(fixture.configPath, "utf8");
    expect(source).toContain('environment: "staging"');
    expect(source).toContain('appName: "Traycer Staging"');
    expect(source).toContain('protocolScheme: "traycer-staging"');
    expect(source).toContain('appId: "ai.traycer.desktop.staging"');
    expect(source).toContain('authnBaseUrl: "https://authn.staging.example"');
    expect(source).toContain('cloudUiBaseUrl: "https://app.staging.example"');
    expect(source).toContain(
      'relayBaseUrl: "wss://relay.staging.example/attach"',
    );
    expect(source).toContain('releaseRepo: "acme/private-traycer"');
    expect(source).toContain('releaseChannel: "staging"');
    expect(source).toContain('sentryDsn: "https://sentry/staging"');
    expect(source).toContain(
      'sentryRendererDsn: "https://sentry-renderer/staging"',
    );

    const generated = join(
      fixture.projectDir,
      "resources",
      "bundle",
      ".release-target-uninstall-host-autostart.nsh",
    );
    mkdirSync(dirname(generated), { recursive: true });
    writeFileSync(generated, "fixture", "utf8");
    const restored = run(fixture, ["--restore"]);
    expect(restored.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
    expect(existsSync(fixture.stampPath)).toBe(false);
    expect(existsSync(generated)).toBe(false);
  });

  it("stamps and restores the CLI registry coordinates and host version", () => {
    const fixture = createFixture("cli");
    const original = readFileSync(fixture.configPath, "utf8");
    const staged = run(fixture, [
      "--target=staging",
      `--target-input=${fixture.targetInputPath}`,
      "--supported-host-version=2.3.4",
    ]);
    expect(staged.status).toBe(0);
    const source = readFileSync(fixture.configPath, "utf8");
    expect(source).toContain('environment: "staging"');
    expect(source).toContain('authnBaseUrl: "https://authn.staging.example"');
    expect(source).toContain('cloudUiBaseUrl: "https://app.staging.example"');
    expect(source).toContain('releaseRepo: "acme/private-traycer"');
    expect(source).toContain(
      'hostDiscoveryTag: "released-host-versions-staging"',
    );
    expect(source).toContain('cliFeedTag: "cli-manifest-staging"');
    expect(source).toContain('supportedHostVersion: "2.3.4"');
    // The CLI has no packaging step that reads a stamp, so its stamper never
    // writes one; the input file is the caller's to keep.
    expect(existsSync(fixture.stampPath)).toBe(false);
    const restored = run(fixture, ["--restore"]);
    expect(restored.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
    expect(existsSync(fixture.targetInputPath)).toBe(true);
  });
});
