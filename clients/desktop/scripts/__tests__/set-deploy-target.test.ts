import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
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
  /** Every `unreleased-features.ts` this stamper selects per target. */
  readonly flagPaths: readonly string[];
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
  cpSync(
    join(clientsRoot, "scripts", "set-unreleased-features.cjs"),
    join(scriptsDir, "set-unreleased-features.cjs"),
  );
  // The literals each stamper selects per target: the shared client
  // library's for both; the desktop's own and the gui-app's it bundles; the
  // CLI's in its own tree.
  const flagRelativePaths =
    component === "desktop"
      ? [
          join("gui-app", "src", "unreleased-features.ts"),
          join("desktop", "src", "unreleased-features.ts"),
          join("shared", "unreleased-features.ts"),
        ]
      : [
          join(projectName, "src", "unreleased-features.ts"),
          join("shared", "unreleased-features.ts"),
        ];
  const flagPaths = flagRelativePaths.map((relative) => {
    const flagPath = join(root, "clients", relative);
    mkdirSync(dirname(flagPath), { recursive: true });
    cpSync(join(clientsRoot, relative), flagPath);
    return flagPath;
  });
  const configPath = join(projectDir, "src", "config.ts");
  cpSync(join(clientsRoot, projectName, "src", "config.ts"), configPath);
  // CI writes the descriptor payload beside the checkout (`client-target.json`)
  // and passes it via `--target-input`; only the desktop stamper copies it to
  // `.release-target-stamp.json` for electron-builder and the afterPack hook.
  const targetInputPath = join(root, "client-target.json");
  writeFileSync(targetInputPath, JSON.stringify(stamp()), "utf8");
  const stampPath = join(projectDir, ".release-target-stamp.json");
  return {
    root,
    projectDir,
    configPath,
    targetInputPath,
    stampPath,
    flagPaths,
  };
}

/** The literal each of the fixture's `unreleased-features.ts` files holds. */
function flagLiterals(fixture: Fixture): string[] {
  return fixture.flagPaths.map((flagPath) => {
    const match = /UNRELEASED_FEATURES_ENABLED: boolean = (true|false);/.exec(
      readFileSync(flagPath, "utf8"),
    );
    return match === null ? "missing" : match[1];
  });
}

const IAP_AUDIENCE = "audience-fixture.apps.googleusercontent.example";
/** Service-account-shaped, but a fixture: it signs nothing. */
const IAP_KEY_FIXTURE = JSON.stringify({
  client_email: "signer@fixture.iam.example",
  private_key:
    "-----BEGIN FIXTURE-----\nnot-a-real-key\n-----END FIXTURE-----\n",
});

function iapKeyPath(fixture: Fixture): string {
  return join(
    fixture.projectDir,
    "resources",
    "keys",
    "iap-service-account.json",
  );
}

function withIapAudience(fixture: Fixture): void {
  const input = stamp() as { cloud: Record<string, unknown> };
  input.cloud.iapAudience = IAP_AUDIENCE;
  writeFileSync(fixture.targetInputPath, JSON.stringify(input), "utf8");
}

/** `run`, with the IAP key set to `key`, or removed from the environment. */
function runWithIapKey(
  fixture: Fixture,
  args: readonly string[],
  key: string | undefined,
) {
  return withIapKeyEnv(key, () => run(fixture, args));
}

function withIapKeyEnv<T>(key: string | undefined, body: () => T): T {
  const saved = process.env.TRAYCER_IAP_SA_KEY;
  if (key === undefined) {
    Reflect.deleteProperty(process.env, "TRAYCER_IAP_SA_KEY");
  } else {
    process.env.TRAYCER_IAP_SA_KEY = key;
  }
  try {
    return body();
  } finally {
    if (saved === undefined) {
      Reflect.deleteProperty(process.env, "TRAYCER_IAP_SA_KEY");
    } else {
      process.env.TRAYCER_IAP_SA_KEY = saved;
    }
  }
}

function run(fixture: Fixture, args: readonly string[]) {
  return spawnStamper(fixture, args, null);
}

/** The stamper as CI runs it, under `umask` when one is given. */
function spawnStamper(
  fixture: Fixture,
  args: readonly string[],
  umask: string | null,
) {
  const command = [
    process.execPath,
    join(fixture.projectDir, "scripts", "set-deploy-target.cjs"),
    ...args,
  ];
  const [file, ...argv] =
    umask === null
      ? command
      : ["/bin/sh", "-c", 'umask "$0"; exec "$@"', umask, ...command];
  return spawnSync(file, argv, {
    cwd: fixture.projectDir,
    encoding: "utf8",
    env: {
      ...process.env,
      TRAYCER_RELEASE_REPO: "acme/private-traycer",
      TRAYCER_DESKTOP_SENTRY_DSN: "https://sentry/staging",
      TRAYCER_DESKTOP_SENTRY_RENDERER_DSN: "https://sentry-renderer/staging",
    },
  });
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
    // A staging desktop ships the features the next release does not; the
    // literals live in the gui-app it bundles, in the shared client library
    // and in its own tree.
    expect(flagLiterals(fixture)).toEqual(["true", "true", "true"]);
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
    const restored = runWithoutReleaseRepo(fixture, ["--restore"]);
    expect(restored.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
    // The committed literal: development and staging run with the features.
    expect(flagLiterals(fixture)).toEqual(["true", "true", "true"]);
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
    // The CLI's own literal and the shared client library's.
    expect(flagLiterals(fixture)).toEqual(["true", "true"]);
    // The CLI has no packaging step that reads a stamp, so its stamper never
    // writes one; the input file is the caller's to keep.
    expect(existsSync(fixture.stampPath)).toBe(false);
    const restored = runWithoutReleaseRepo(fixture, ["--restore"]);
    expect(restored.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toBe(original);
    expect(flagLiterals(fixture)).toEqual(["true", "true"]);
    expect(existsSync(fixture.targetInputPath)).toBe(true);
  });
});

describe("set-deploy-target IAP service-account key", () => {
  const stagingArgs = (fixture: Fixture) => [
    "--target=staging",
    `--target-input=${fixture.targetInputPath}`,
  ];

  it("stamps the audience and writes the key, readable by the installed app's user, for a staging target behind IAP", () => {
    const fixture = createFixture("desktop");
    withIapAudience(fixture);

    const result = runWithIapKey(
      fixture,
      stagingArgs(fixture),
      IAP_KEY_FIXTURE,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toContain(
      `iapAudience: "${IAP_AUDIENCE}"`,
    );
    expect(readFileSync(iapKeyPath(fixture), "utf8")).toBe(IAP_KEY_FIXTURE);
    expect(statSync(iapKeyPath(fixture)).mode & 0o777).toBe(0o644);
  });

  it("writes the key readable under a restrictive umask, which masks a creation mode", () => {
    const fixture = createFixture("desktop");
    withIapAudience(fixture);

    const result = withIapKeyEnv(IAP_KEY_FIXTURE, () =>
      spawnStamper(fixture, stagingArgs(fixture), "077"),
    );

    expect(result.status).toBe(0);
    expect(statSync(iapKeyPath(fixture)).mode & 0o777).toBe(0o644);
  });

  it("exits 2 without echoing the key when it is absent or not a service-account key", () => {
    const fixture = createFixture("desktop");
    withIapAudience(fixture);
    const secret = "secret-marker-fixture";

    const absent = runWithIapKey(fixture, stagingArgs(fixture), undefined);
    const notJson = runWithIapKey(fixture, stagingArgs(fixture), secret);
    const wrongShape = runWithIapKey(
      fixture,
      stagingArgs(fixture),
      JSON.stringify({ note: secret }),
    );

    expect(absent.status).toBe(2);
    expect(absent.stderr).toContain("TRAYCER_IAP_SA_KEY");
    expect(notJson.status).toBe(2);
    expect(wrongShape.status).toBe(2);
    expect(notJson.stderr + wrongShape.stderr).not.toContain(secret);
    expect(existsSync(iapKeyPath(fixture))).toBe(false);
  });

  it("leaves a staging target without an audience unstamped and keyless", () => {
    const fixture = createFixture("desktop");

    const result = runWithIapKey(
      fixture,
      stagingArgs(fixture),
      IAP_KEY_FIXTURE,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toContain(
      'iapAudience: ""',
    );
    expect(existsSync(iapKeyPath(fixture))).toBe(false);
  });

  it("writes no key for production even when the variable is set, and removes a stale one", () => {
    const fixture = createFixture("desktop");
    mkdirSync(dirname(iapKeyPath(fixture)), { recursive: true });
    writeFileSync(iapKeyPath(fixture), "stale-fixture", "utf8");

    const result = runWithIapKey(
      fixture,
      ["--target=production"],
      IAP_KEY_FIXTURE,
    );

    expect(result.status).toBe(0);
    expect(readFileSync(fixture.configPath, "utf8")).toContain(
      'iapAudience: ""',
    );
    expect(existsSync(iapKeyPath(fixture))).toBe(false);
    // The one build without the unreleased features.
    expect(flagLiterals(fixture)).toEqual(["false", "false", "false"]);
  });

  it("removes the key on --restore", () => {
    const fixture = createFixture("desktop");
    withIapAudience(fixture);
    runWithIapKey(fixture, stagingArgs(fixture), IAP_KEY_FIXTURE);
    expect(existsSync(iapKeyPath(fixture))).toBe(true);

    const restored = runWithIapKey(fixture, ["--restore"], undefined);

    expect(restored.status).toBe(0);
    expect(existsSync(iapKeyPath(fixture))).toBe(false);
  });
});
