import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const scriptSource = join(
  process.cwd(),
  "scripts",
  "release-target-electron-builder.cjs",
);
const stampSource = join(
  process.cwd(),
  "..",
  "scripts",
  "release-target-stamp.cjs",
);
const roots: string[] = [];
const require = createRequire(import.meta.url);

function desktopStamp(
  target: "production" | "staging",
): Record<string, unknown> {
  const staging = target === "staging";
  return {
    target,
    environment: target,
    cloud: {
      traycerServerBaseUrl: `https://api.${target}.example`,
      authnApiUrl: `https://authn.${target}.example`,
      cloudUiBaseUrl: `https://app.${target}.example`,
      relayAttachUrl: `wss://relay.${target}.example/attach`,
    },
    sentryEnvironment: target,
    cliFeedTag: staging ? "cli-manifest-staging" : "cli-manifest",
    hostDiscoveryTag: staging
      ? "released-host-versions-staging"
      : "released-host-versions",
    credentialEnvironmentVariable: staging
      ? "TRAYCER_STAGING_RELEASE_TOKEN"
      : "",
    credentialSources: ["environment"],
    authorizedOrigins: ["https://github.com", "https://api.github.com"],
    appId: staging ? "ai.traycer.desktop.staging" : "ai.traycer.desktop",
    productName: staging ? "Traycer Staging" : "Traycer",
    protocolScheme: staging ? "traycer-staging" : "traycer",
    releaseChannel: target,
    mac: {
      bundleName: staging ? "Traycer Staging" : "Traycer",
      helperBundleId: `ai.traycer.${target}.host`,
      launchAgentLabel: `ai.traycer.${target}.host.agent`,
    },
    windows: {
      appUserModelId: staging
        ? "ai.traycer.desktop.staging"
        : "ai.traycer.desktop",
      executableName: staging ? "Traycer-Staging" : "Traycer",
      installerDisplayName: staging ? "Traycer Staging" : "Traycer",
    },
    linux: {
      deb: { packageName: staging ? "traycer-staging" : "traycer" },
      rpm: { packageName: staging ? "traycer-staging" : "Traycer" },
      executableName: staging ? "traycer-staging" : "traycer",
      desktopEntryName: staging ? "traycer-staging" : "traycer",
    },
    updaterPackageName: staging ? "traycer-staging-desktop" : "traycer",
    updaterCacheDirName: staging
      ? "traycer-staging-updater"
      : "traycer-updater",
    updaterChannel: "latest",
    updaterChannelFiles: ["latest.yml"],
  };
}

function createProject(target: "production" | "staging" | "unstamped"): {
  projectDir: string;
  configPath: string;
  generatedPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "traycer-electron-builder-test-"));
  roots.push(root);
  const projectDir = join(root, "clients", "desktop");
  mkdirSync(join(projectDir, "scripts"), { recursive: true });
  mkdirSync(join(projectDir, "src"), { recursive: true });
  mkdirSync(join(projectDir, "resources", "bundle"), { recursive: true });
  mkdirSync(join(root, "clients", "scripts"), { recursive: true });
  writeFileSync(
    join(projectDir, "scripts", "release-target-electron-builder.cjs"),
    readFileSync(scriptSource),
  );
  writeFileSync(
    join(root, "clients", "scripts", "release-target-stamp.cjs"),
    readFileSync(stampSource),
  );
  const configPath = join(projectDir, "src", "config.ts");
  writeFileSync(
    configPath,
    `export const config = { environment: "${target === "unstamped" ? "dev" : target}" };\n`,
  );
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify({
      build: {
        appId: "old.app",
        productName: "Old Traycer",
        mac: { executableName: "OldTraycer" },
        win: { executableName: "OldTraycer" },
        linux: { executableName: "old-traycer" },
        deb: { packageName: "old-deb" },
        rpm: { packageName: "old-rpm" },
        nsis: { include: "uninstall-host-autostart.nsh" },
      },
    }),
  );
  if (target !== "unstamped") {
    writeFileSync(
      join(projectDir, ".release-target-stamp.json"),
      JSON.stringify(desktopStamp(target)),
    );
  }
  return {
    projectDir,
    configPath,
    generatedPath: join(
      projectDir,
      "resources",
      "bundle",
      ".release-target-uninstall-host-autostart.nsh",
    ),
  };
}

function run(projectDir: string): Record<string, unknown> {
  const modulePath = join(
    projectDir,
    "scripts",
    "release-target-electron-builder.cjs",
  );
  execFileSync(process.execPath, [modulePath], {
    cwd: projectDir,
    env: { ...process.env, TRAYCER_RELEASE_REPO: "acme/private-traycer" },
    encoding: "utf8",
  });
  const previousRepo = process.env.TRAYCER_RELEASE_REPO;
  process.env.TRAYCER_RELEASE_REPO = "acme/private-traycer";
  try {
    return require(modulePath) as Record<string, unknown>;
  } finally {
    if (previousRepo === undefined) {
      Reflect.deleteProperty(process.env, "TRAYCER_RELEASE_REPO");
    } else {
      process.env.TRAYCER_RELEASE_REPO = previousRepo;
    }
  }
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe("release-target-electron-builder", () => {
  it("projects staging identity, package names, publish target, and generated NSIS include", () => {
    const fixture = createProject("staging");
    const config = run(fixture.projectDir);
    expect(config).toMatchObject({
      appId: "ai.traycer.desktop.staging",
      productName: "Traycer Staging",
      protocols: [{ name: "Traycer Staging", schemes: ["traycer-staging"] }],
      extraMetadata: { name: "traycer-staging-desktop" },
      deb: { packageName: "traycer-staging" },
      rpm: { packageName: "traycer-staging" },
      publish: [
        {
          provider: "github",
          owner: "acme",
          repo: "private-traycer",
          channel: "latest",
        },
      ],
      nsis: { include: ".release-target-uninstall-host-autostart.nsh" },
    });
    expect(config.mac).toMatchObject({ executableName: "Traycer Staging" });
    expect(config.win).toMatchObject({ executableName: "Traycer-Staging" });
    expect(config.linux).toMatchObject({ executableName: "traycer-staging" });
    const nsis = readFileSync(fixture.generatedPath, "utf8");
    expect(nsis).toContain(
      '!define TRAYCER_WINDOWS_TASK_NAME "\\Traycer\\Host-Staging"',
    );
    expect(nsis).toContain('!define TRAYCER_WINDOWS_TASK_FOLDER "Traycer"');
    expect(nsis).toContain(
      '!define TRAYCER_HOST_LAUNCHER "$PROFILE\\.traycer\\cli\\staging\\host-start-hidden.vbs"',
    );
    expect(nsis).toContain('!include "uninstall-host-autostart.nsh"');
  });

  it("keeps production deb/rpm casing and historical task identity", () => {
    const fixture = createProject("production");
    const config = run(fixture.projectDir);
    expect(config).toMatchObject({
      deb: { packageName: "traycer" },
      rpm: { packageName: "Traycer" },
    });
    expect(readFileSync(fixture.generatedPath, "utf8")).toContain(
      '!define TRAYCER_WINDOWS_TASK_NAME "\\Traycer\\Host"',
    );
  });

  it("refuses an unstamped config", () => {
    const fixture = createProject("unstamped");
    const result = spawnSync(
      process.execPath,
      [
        join(
          fixture.projectDir,
          "scripts",
          "release-target-electron-builder.cjs",
        ),
      ],
      { cwd: fixture.projectDir, encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("release-stamped config");
  });
});
