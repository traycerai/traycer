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
      desktopEntryName: "traycer-staging.desktop",
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

  it("refuses a desktop stamp missing windowsTaskName", () => {
    // Only the cli component's missing-key sweep above exercises
    // windowsTaskName; a desktop stamp is a separate COMPONENT_KEYS entry and
    // was never itself driven through this deletion.
    const stamp = desktopStamp();
    delete stamp.windowsTaskName;
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/windowsTaskName/);
  });
});

describe("cliInstallRoot and hostInstallRoot must be home-relative", () => {
  // `windowsLauncherPath` in release-target-electron-builder.cjs does
  // `cliInstallRoot.slice(2)` to drop a leading `~/`. An absolute value such
  // as "/opt/traycer/cli" survived every other check here before this guard
  // and then lost its first two characters instead of the `~/` prefix.

  it("rejects an absolute cliInstallRoot on the cli stamp", () => {
    const stamp = cliStamp();
    stamp.cliInstallRoot = "/opt/traycer/cli";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/cliInstallRoot must be home-relative/);
  });

  // The accepted value is the TARGET's own root, not merely any home-relative
  // one: the shape guard runs first and the identity pin second, so a
  // well-formed path for the wrong target is caught by the pin rather than
  // here. Using the production root under a `staging` validation would now be
  // asserting that two different installs may share a directory.
  it("accepts a home-relative cliInstallRoot on the cli stamp", () => {
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.traycer/cli/staging";
    expect(
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toMatchObject({ cliInstallRoot: "~/.traycer/cli/staging" });
  });

  it("rejects an absolute cliInstallRoot on the desktop stamp", () => {
    const stamp = desktopStamp();
    stamp.cliInstallRoot = "/opt/traycer/cli";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/cliInstallRoot must be home-relative/);
  });

  it("accepts a home-relative cliInstallRoot on the desktop stamp", () => {
    const stamp = desktopStamp();
    stamp.cliInstallRoot = "~/.traycer/cli/staging";
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toMatchObject({ cliInstallRoot: "~/.traycer/cli/staging" });
  });

  it("rejects an absolute hostInstallRoot on the cli stamp", () => {
    const stamp = cliStamp();
    stamp.hostInstallRoot = "/opt/traycer/host";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/hostInstallRoot must be home-relative/);
  });

  it("accepts a home-relative hostInstallRoot on the cli stamp", () => {
    const stamp = cliStamp();
    stamp.hostInstallRoot = "~/.traycer/host/staging";
    expect(
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toMatchObject({ hostInstallRoot: "~/.traycer/host/staging" });
  });

  it("rejects a hostInstallRoot that escapes the home directory via ..", () => {
    const stamp = cliStamp();
    stamp.hostInstallRoot = "~/../shared";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/must stay inside the home directory/);
  });

  it("rejects a bare ~/ cliInstallRoot that names the home directory itself", () => {
    const stamp = desktopStamp();
    stamp.cliInstallRoot = "~/";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/must name a directory under the home directory/);
  });

  it('rejects a "." segment that names the home directory itself', () => {
    // The sibling of the bare `~/` case above. `.` is a legal character in a
    // plain name (`.traycer`), so the `[A-Za-z0-9._-]` allowlist accepts a
    // segment that is nothing but a dot, and the `..` check does not fire.
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/names no directory/);
  });

  it('rejects an interior "." navigation segment', () => {
    // Not an escape - it resolves to the same directory. It is refused because
    // these values are joined and compared as STRINGS by consumers that never
    // normalize, so a second spelling of one directory is a value that
    // resolves equal and compares unequal.
    const stamp = cliStamp();
    stamp.hostInstallRoot = "~/.traycer/./host";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/names no directory/);
  });

  it('rejects a "..." run that Windows would silently trim', () => {
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.../cli";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/names no directory/);
  });

  it("still accepts a leading dot in a real directory name", () => {
    // The negative control for the three above: `.traycer` must survive, or
    // the rule would have been "no dots" and every shipped root would fail.
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.traycer/cli/staging";
    expect(
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toMatchObject({ cliInstallRoot: "~/.traycer/cli/staging" });
  });

  it('rejects a backslash escape that survives split("/") as one segment', () => {
    // `windowsLauncherPath` converts "/" to "\\", so a literal backslash in
    // the value is already a separator on the Windows side even though
    // split("/") sees it as part of one segment and the ".." check never
    // fires.
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/..\\shared";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/is not a plain name/);
  });

  it("rejects a quote that would close the NSIS !define string early", () => {
    const stamp = cliStamp();
    stamp.cliInstallRoot = '~/.traycer/cli" ; nsExec::Exec `evil`';
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/is not a plain name/);
  });

  it("still accepts a real multi-segment home-relative value", () => {
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.traycer/cli/staging";
    expect(
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toMatchObject({ cliInstallRoot: "~/.traycer/cli/staging" });
  });
});

/**
 * Production's credential policy: it reaches a PUBLIC repository anonymously.
 *
 * This is the field group that made the production fixture a fiction. Every
 * `production*Stamp()` here is built by taking the STAGING fixture and flipping
 * the handful of fields an assertion happened to read, so the credential block
 * stayed staging's - a token variable, two sources, two origins. The real
 * generator emits `null` and two empty arrays for production, which the
 * validator rejected outright. Every test passed and no production desktop
 * stamp could be read.
 *
 * So: flip it HERE, with the install identity, rather than per-assertion.
 */
function toProductionCredentialPolicy(stamp: Stamp): Stamp {
  stamp.credentialEnvironmentVariable = null;
  stamp.credentialSources = [];
  stamp.authorizedOrigins = [];
  return stamp;
}

function productionDesktopStamp(): Stamp {
  const stamp = desktopStamp();
  stamp.target = "production";
  stamp.environment = "production";
  stamp.releaseChannel = "stable";
  return toProductionCredentialPolicy(toProductionInstallIdentity(stamp));
}

/**
 * Flips the install-identity keys to their production values.
 *
 * Shared by the two production fixtures rather than spelled out in each,
 * because the identity is a SET: `productionDesktopStamp` previously flipped
 * only `target`/`environment`/`releaseChannel` and kept the staging identity
 * below - a production stamp naming the staging Scheduled Task, which is
 * precisely the defect the identity check exists to refuse. Splitting the flip
 * across call sites is how that happens; one helper is how it stops.
 *
 * `desktopStamp()` spreads `cliStamp()`, so a desktop stamp carries
 * `serviceLabelId` even though `COMPONENT_KEYS.desktop` does not require it -
 * and the check reads every identity key that is PRESENT, not only the
 * required ones. Both are set here for that reason.
 */
// EVERY install-identity field, not the ones a given assertion happens to
// read. This helper exists because `productionDesktopStamp()` used to flip only
// target/environment/releaseChannel and keep the STAGING identity underneath -
// a fixture that asserts "production" while carrying staging coordinates makes
// any pin added later look like a regression. Each field pinned in
// `REQUIRED_INSTALL_IDENTITY` (plus the derived agent label) has to appear
// here, so adding a pin there and forgetting this one reddens loudly rather
// than quietly re-teaching the bug.
function toProductionInstallIdentity(stamp: Stamp): Stamp {
  stamp.cliInstallRoot = "~/.traycer/cli";
  stamp.hostInstallRoot = "~/.traycer/host";
  stamp.serviceLabelId = "ai.traycer.host";
  stamp.windowsTaskName = "\\Traycer\\Host";
  if (stamp.mac !== undefined) {
    (stamp.mac as Stamp).launchAgentLabel = "ai.traycer.host.agent";
  }
  return stamp;
}

describe("desktop releaseChannel enforcement", () => {
  it("rejects a staging stamp that claims the stable channel", () => {
    const stamp = desktopStamp();
    stamp.releaseChannel = "stable";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/releaseChannel/);
  });

  it("rejects a wrong-case releaseChannel value", () => {
    const stamp = desktopStamp();
    stamp.releaseChannel = "Staging";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/releaseChannel/);
  });

  it("accepts the staging pair releaseChannel=staging", () => {
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(desktopStamp()),
        "staging",
        "desktop",
      ),
    ).toMatchObject({ target: "staging", releaseChannel: "staging" });
  });

  it("accepts the production pair releaseChannel=stable", () => {
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(productionDesktopStamp()),
        "production",
        "desktop",
      ),
    ).toMatchObject({ target: "production", releaseChannel: "stable" });
  });

  it("rejects a production stamp that claims the staging channel", () => {
    const stamp = productionDesktopStamp();
    stamp.releaseChannel = "staging";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "production",
        "desktop",
      ),
    ).toThrow(/releaseChannel/);
  });
});

// `serviceLabelId` and `windowsTaskName` are the only stamped values a second
// process DERIVES instead of reading: the CLI computes both from
// `config.environment` and never consults the stamp. The stamp's copies exist
// so the NSIS uninstaller can name the CLI's Scheduled Task without importing
// the CLI - so a value that is merely a non-empty string points the uninstaller
// at a task that was never registered, and the real host keeps restarting after
// the app is removed.
//
// `clients/traycer-cli/src/service/__tests__/label.test.ts` holds the other
// half: that the pinned table equals what `serviceLabelFor`/`windowsTaskName`
// actually produce. These cases only check that the stamp is held to the table.
describe("install identity must match the target", () => {
  function productionCliStamp(): Stamp {
    const stamp = cliStamp();
    stamp.target = "production";
    stamp.environment = "production";
    return toProductionCredentialPolicy(toProductionInstallIdentity(stamp));
  }

  it("rejects a one-character windowsTaskName typo on a desktop stamp", () => {
    // Syntactically perfect, passes `windowsTaskFolder`'s one-folder shape
    // check in `release-target-electron-builder.cjs`, and stops nothing.
    const stamp = desktopStamp();
    stamp.windowsTaskName = "\\Traycer\\Host-Stagin";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/windowsTaskName/);
  });

  it("rejects a serviceLabelId typo on a cli stamp", () => {
    const stamp = cliStamp();
    stamp.serviceLabelId = "ai.traycer.host.stagin";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/serviceLabelId/);
  });

  it("rejects the PRODUCTION identity on a staging stamp", () => {
    // The consequential direction: a staging build whose uninstaller stops
    // `\Traycer\Host` takes down the developer's production host.
    const stamp = cliStamp();
    stamp.serviceLabelId = "ai.traycer.host";
    stamp.windowsTaskName = "\\Traycer\\Host";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/serviceLabelId/);
  });

  it("rejects the STAGING identity on a production stamp", () => {
    const stamp = productionCliStamp();
    stamp.windowsTaskName = "\\Traycer\\Host-Staging";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "production", "cli"),
    ).toThrow(/windowsTaskName/);
  });

  it("rejects an install root that is well-formed but names the wrong slot", () => {
    // The point of this pair: the home-relative guard CANNOT catch these.
    // `~/.traycer/cli/stagng` is home-relative, has no `..`, no dots-only
    // segment and a real-looking directory name - it passes every shape check
    // and then names a directory the CLI, which derives its own root from the
    // environment, never reads or writes. Only an exact pin sees it.
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.traycer/cli/stagng";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/cliInstallRoot/);

    const hostStamp = cliStamp();
    hostStamp.hostInstallRoot = "~/.traycer/host/stagng";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(hostStamp),
        "staging",
        "cli",
      ),
    ).toThrow(/hostInstallRoot/);
  });

  it("rejects the PRODUCTION install root on a staging stamp", () => {
    // The consequential direction again: a staging CLI stamped with the
    // production root installs itself over the production CLI instead of
    // beside it, which is the whole point of the side-by-side slot.
    const stamp = cliStamp();
    stamp.cliInstallRoot = "~/.traycer/cli";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/cliInstallRoot/);
  });

  it("rejects a launchAgentLabel that ends in .agent but names another service", () => {
    // `inject-host-launch-agent.cjs` asks only that the label END IN `.agent`,
    // so this passes the injector and is written as the in-bundle plist's
    // filename. SMAppService then resolves the plist by exact filename, and the
    // desktop asks for `<serviceLabelId>.agent` derived from its environment -
    // so the packaged app can never register its host login item, and nothing
    // before runtime says so.
    const stamp = desktopStamp();
    (stamp.mac as Stamp).launchAgentLabel = "ai.traycer.host.stagin.agent";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/launchAgentLabel/);
  });

  it("rejects the PRODUCTION launchAgentLabel on a staging stamp", () => {
    const stamp = desktopStamp();
    (stamp.mac as Stamp).launchAgentLabel = "ai.traycer.host.agent";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/launchAgentLabel/);
  });

  it("accepts each target's own identity", () => {
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(cliStamp()),
        "staging",
        "cli",
      ),
    ).toMatchObject({
      serviceLabelId: "ai.traycer.host.staging",
      windowsTaskName: "\\Traycer\\Host-Staging",
      cliInstallRoot: "~/.traycer/cli/staging",
      hostInstallRoot: "~/.traycer/host/staging",
    });
    // Positive control for the agent-label pin: the staging desktop stamp's
    // own label must be ACCEPTED, or the four rejections above would all pass
    // against a check that refuses everything.
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(desktopStamp()),
        "staging",
        "desktop",
      ),
    ).toMatchObject({
      mac: { launchAgentLabel: "ai.traycer.host.staging.agent" },
    });
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(productionCliStamp()),
        "production",
        "cli",
      ),
    ).toMatchObject({
      serviceLabelId: "ai.traycer.host",
      windowsTaskName: "\\Traycer\\Host",
      cliInstallRoot: "~/.traycer/cli",
      hostInstallRoot: "~/.traycer/host",
    });
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

describe("the credential policy must match how the target authenticates", () => {
  // THE REGRESSION THIS GROUP EXISTS FOR. Production reaches a public
  // repository anonymously, so the generator emits `credentialEnvironmentVariable:
  // null` with two empty arrays. The validator required a non-empty string and
  // two non-empty arrays, so it rejected EVERY real production stamp - and
  // `release-desktop.yml` passes `--target-input` unconditionally, so a
  // production desktop release would have failed at its stamp step. It went
  // unseen because these fixtures were staging stamps with a few fields
  // flipped, so no test ever presented production's actual shape.
  it("accepts an anonymous production stamp: no variable, no sources, no origins", () => {
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(productionDesktopStamp()),
        "production",
        "desktop",
      ),
    ).toMatchObject({
      credentialEnvironmentVariable: null,
      credentialSources: [],
      authorizedOrigins: [],
    });
  });

  it("rejects a renamed credential variable on a target that authenticates", () => {
    // No stamper consumes this field - the shared resolver reads the hard-coded
    // TRAYCER_STAGING_RELEASE_TOKEN - so a rename builds a release that cannot
    // authenticate while every shape check passes.
    const stamp = cliStamp();
    stamp.credentialEnvironmentVariable = "TRAYCER_STAGING_TOKEN";
    expect(() =>
      stampModule.readClientTargetStamp(writeStamp(stamp), "staging", "cli"),
    ).toThrow(/credentialEnvironmentVariable/);
  });

  it("rejects a credential variable on a target that declares no sources", () => {
    const stamp = productionDesktopStamp();
    stamp.credentialEnvironmentVariable = "TRAYCER_STAGING_RELEASE_TOKEN";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "production",
        "desktop",
      ),
    ).toThrow(/credentialEnvironmentVariable/);
  });

  it("rejects origins without sources, and sources without origins", () => {
    // Both directions, because either alone is a half-stated rule: origins
    // bound where a credential may be SENT, so they are meaningless without
    // one and unbounded without them.
    const originsNoSources = productionDesktopStamp();
    originsNoSources.authorizedOrigins = ["https://github.com"];
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(originsNoSources),
        "production",
        "desktop",
      ),
    ).toThrow(/authorizedOrigins/);

    const sourcesNoOrigins = cliStamp();
    sourcesNoOrigins.authorizedOrigins = [];
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(sourcesNoOrigins),
        "staging",
        "cli",
      ),
    ).toThrow(/authorizedOrigins/);
  });
});

describe("stamped values that duplicate a neighbour are pinned to it", () => {
  // Each of these is validated but read by NOTHING; the value that actually
  // reaches the build comes from the field it mirrors. That makes a divergence
  // worse than a wrong value - the descriptor reads like configuration that
  // works, and editing it changes nothing.
  it("rejects a windows.appUserModelId that does not equal appId", () => {
    // Windows attributes toasts by AUMID and drops what it cannot match, and
    // the runtime calls setAppUserModelId with config.appId.
    const stamp = desktopStamp();
    (stamp.windows as Stamp).appUserModelId = "ai.traycer.desktop.stagin";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/appUserModelId/);
  });

  it("rejects a windows.installerDisplayName that does not equal productName", () => {
    const stamp = desktopStamp();
    (stamp.windows as Stamp).installerDisplayName = "Traycer";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/installerDisplayName/);
  });

  it("rejects an updaterChannel discovery can never request", () => {
    // Publishing under `staging` would put manifests where
    // `platformChannelFile()` never looks; the app then reports itself up to
    // date forever instead of failing, which is the worst of both.
    const stamp = desktopStamp();
    stamp.updaterChannel = "staging";
    expect(() =>
      stampModule.readClientTargetStamp(
        writeStamp(stamp),
        "staging",
        "desktop",
      ),
    ).toThrow(/updaterChannel/);
  });

  it("accepts the mirrored values the generator actually emits", () => {
    // Positive control for all three: a check that refused everything would
    // satisfy every rejection above.
    expect(
      stampModule.readClientTargetStamp(
        writeStamp(desktopStamp()),
        "staging",
        "desktop",
      ),
    ).toMatchObject({
      appId: "ai.traycer.desktop.staging",
      productName: "Traycer Staging",
      updaterChannel: "latest",
      windows: {
        appUserModelId: "ai.traycer.desktop.staging",
        installerDisplayName: "Traycer Staging",
      },
    });
  });
});
