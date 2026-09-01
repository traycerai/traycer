#!/usr/bin/env bun
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * electron-builder `afterPack` hook (wired via `build.afterPack` in
 * package.json, resolved by named export - see electron-builder's
 * `resolveFunction`) that injects a macOS LaunchAgent + helper .app into the
 * packaged bundle, so `app.setLoginItemSettings({ type: "agentService" })` in
 * `src/electron-main/app/host-login-item.ts` has something to register.
 *
 * This mirrors (and must stay in lockstep with) the internal repo's
 * `scripts/desktop-install-cloud.js` (`installHostHelperApp` /
 * `buildInAppLaunchAgentPlist` / `prepareInAppHostLaunchAgent`) - duplicated
 * here, not shared, because the two repos are separate git checkouts. The
 * internal script only wires this into the internal cloud/local-install
 * path; `.github/workflows/release-desktop.yml` (the workflow that produces
 * the actually-shipped DMG/ZIP release artifacts) runs `electron-builder`
 * directly against THIS package.json and never touches that script, so
 * without this file the real release build ships without the fix.
 *
 * ONE DELIBERATE DIVERGENCE from that script, so a future reader does not
 * "restore lockstep" by mistake: the compatibility launcher written here
 * passes `--service-label` unconditionally, while the internal script's copy
 * first probes `host capabilities --has service-label`. Both stage the CLI as
 * a sibling of the launcher, but only here are the launcher and that CLI
 * built from a single repo at a single commit. The internal script is
 * internal-repo HEAD staging a CLI built from the `traycer/` submodule at the
 * gitlink pin, so it can legitimately meet an N-1 CLI and must keep probing.
 * See `writeHostStartCompatibilityLauncher` in both files.
 *
 * afterPack runs BEFORE electron-builder signs anything, so it stages the
 * helper .app + writes the LaunchAgent plist and ad-hoc-signs the helper only
 * as a baseline (so the bundle is structurally valid if this is an unsigned
 * local build). electron-builder's own signing step, which runs right after
 * afterPack, recursively deep-signs the ENTIRE bundle - including this
 * injected helper - with whatever identity/hardened-runtime/entitlements the
 * real build is configured with; that's the one and only signature that
 * matters for a notarized Developer ID release. There is deliberately no
 * afterSign hook here: re-signing the helper again after electron-builder's
 * own pass would strip the hardened-runtime flag and run after
 * notarization, invalidating the already-sealed bundle.
 *
 * Path relocatability: `BundleProgram` (and the helper path passed to the
 * compatibility launcher) are written as a path RELATIVE to the .app bundle root, never the absolute
 * `context.appOutDir` temp path electron-builder hands afterPack (that
 * directory is deleted once packaging finishes). Per Apple's guidance for
 * SMAppService-registered bundled helpers
 * (https://developer.apple.com/documentation/servicemanagement/updating-helper-executables-from-earlier-versions-of-macos),
 * `BundleProgram` is resolved against the CALLING app's bundle location at
 * registration time, so the same baked plist resolves correctly wherever
 * the .app ends up. The plist also never bakes a HOME - unlike the internal
 * script's cloud/local-install flow (which runs on the same machine as the
 * install target), this build runs on a CI runner shipped to arbitrary end
 * users, so there is no correct HOME to bake in; launchd populates HOME for
 * the owning user of a per-user LaunchAgent job on its own.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { Arch } = require("electron-builder");

const pkg = require("../../package.json");
const PRODUCT_NAME = pkg.build.productName;
const APP_ID = pkg.build.appId;
const CONFIG_PATH = path.resolve(__dirname, "..", "..", "src", "config.ts");
const CLI_BINARY_NAME = "traycer";
// The launcher's BASENAME is what the user reads in System Settings → Login
// Items, so it is a product name, not a filename.
//
// BTM records `Name` as the verbatim basename of the plist's `BundleProgram`
// and is NOT bundle-aware — live-probed 2026-07-29 on macOS 26.5 with a
// signed throwaway app registering four variants through the real
// `SMAppService.agent(plistName:)` and read back with `sfltool dumpbtm`:
//
//   BundleProgram basename        BTM Name
//   probe-host-start          →   probe-host-start
//   probeexec (CFBundleExecutable) →  probeexec
//   Probe Launcher Named      →   Probe Launcher Named
//   Probe Host (RunAtLoad)    →   Probe Host          (exit code 0)
//
// The helper bundle's `CFBundleDisplayName`, `CFBundleName` and even its own
// `.app` directory name were all ignored — including in the variant whose
// `BundleProgram` pointed at that bundle's `CFBundleExecutable`. So the
// obvious-looking fix (retarget `BundleProgram` at `CFBundleExecutable`) does
// NOT surface a product name; it would have shipped `Name: traycer`. Renaming
// the launcher file is the only lever, which is the same conclusion the CLI
// path reached for `/bin/sh` (see `HOST_START_LAUNCHER_BASENAME`).
//
// Spaces are load-bearing-safe: the probe's space-named variant both
// registered AND was exec'd by launchd with `$0` intact.
//
// This name is NOT the CLI's `HOST_START_LAUNCHER_BASENAME`, and must not be
// unified with it. That constant is the one
// `attestTraycerRegistration`/`isHostStartInvocation` matches on for the
// CLI's `~/.traycer/service/<label-id>/…` launcher form, where a rename is a
// field-compatibility and eviction-attestation change. The bundled agent
// below never matches that arm (its launcher's parent directory is `MacOS`,
// not the label id) — it attests through its label signal — so this basename
// is free to be chosen for the human reading it.
const HOST_START_COMPAT_LAUNCHER = `${PRODUCT_NAME} Host`;
const HOST_NODE_OPTIONS = "--max-semi-space-size=16";
const HOST_SOFT_FILE_DESCRIPTOR_LIMIT = 8_192;
// Matches `PRODUCTION_LABEL.id` in `src/electron-main/host/host-paths.ts`.
// Production-only: `scripts/set-deploy-target.cjs --target=production` (run
// by release-desktop.yml before packaging) is the only stamp this label is
// valid for - see `isProductionStamped` below.
//
// Since the label split (`host-paths.ts:smAppServiceAgentLabelId`), the
// desktop registers the AGENT label below - `<cli-label>.agent` - and
// resolves the plist to register by that exact filename. The CLI label's
// plist still ships, but INERT: never registered, present only so the
// desktop's transition cleanup (`unregister` of the old serviceName in
// `host-login-item.ts`) can resolve it and drop the old app-scoped BTM
// record on machines that upgraded from a pre-split SMAppService install.
// Time-boxed: remove the inert plist once the fleet has cycled through a
// few post-split releases. The `.agent` derivation must stay in lockstep
// with `host-paths.ts:smAppServiceAgentLabelId`, the CLI's
// `service/label.ts:smAppServiceAgentLabelId`, and the internal repo's
// `desktop-install-cloud.js:hostAgentLabel` (none can import this file).
const PRODUCTION_LABEL = "ai.traycer.host";
const PRODUCTION_AGENT_LABEL = `${PRODUCTION_LABEL}.agent`;

// `set-deploy-target.cjs` rewrites `environment: "dev"` to
// `environment: "production"` in place before packaging for release; an
// unstamped local `bun run package[:dir]` build stays on `"dev"` and would
// register under a different, dev-scoped label, so injecting the production
// plist for it would just be dead weight the app never looks at.
function isProductionStamped() {
  const source = fs.readFileSync(CONFIG_PATH, "utf8");
  return /environment:\s*"production"/.test(source);
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function appPathFor(context) {
  return path.join(context.appOutDir, `${PRODUCT_NAME}.app`);
}

function helperAppPathFor(appPath) {
  return path.join(
    appPath,
    "Contents",
    "Library",
    "LaunchAgents",
    `${PRODUCT_NAME} Host.app`,
  );
}

// Stays in lockstep with `buildPlist` in
// clients/traycer-cli/src/service/platforms/macos.ts, including
// `ProcessType: Interactive` - the only launchd band that runs with app-
// equivalent (i.e. no) resource limits. `Standard` is defined as "equivalent
// to no ProcessType being set", which means launchd throttles CPU and I/O;
// see the rationale comment on `installService` in that file.
function buildLaunchAgentPlist(label, launcherRelativePath) {
  const hostPath = [
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].join(":");
  // BundleProgram is the executable launchd actually execs. It is a real
  // bundle-relative compatibility launcher, rather than a shell-shaped argv
  // for the Traycer CLI: launchd does not interpret ProgramArguments[0] as
  // the executable when BundleProgram is present.
  const programArgs = [launcherRelativePath, label];
  const programArgsXml = programArgs
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>BundleProgram</key>
  <string>${escapeXml(launcherRelativePath)}</string>
  <key>ProgramArguments</key>
  <array>
${programArgsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
    <key>Crashed</key>
    <true/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>SoftResourceLimits</key>
  <dict>
    <key>NumberOfFiles</key>
    <integer>${HOST_SOFT_FILE_DESCRIPTOR_LIMIT}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(hostPath)}</string>
    <key>NODE_OPTIONS</key>
    <string>${escapeXml(HOST_NODE_OPTIONS)}</string>
  </dict>
</dict>
</plist>
`;
}

function writeHostStartCompatibilityLauncher(helperMacOSDir) {
  const launcher = path.join(helperMacOSDir, HOST_START_COMPAT_LAUNCHER);
  // `$0` is the executable path launchd resolved from BundleProgram, so this
  // survives moving the outer .app after packaging.  The supplied label is
  // data, never shell code; the launcher never evaluates it.
  //
  // `--service-label` is passed UNCONDITIONALLY, with no capability probe.
  // The CLI this shim execs is not the user's slot symlink: `installHelperApp`
  // copies it out of `Contents/Resources/cli/darwin-<arch>/` into this very
  // directory moments before this file is written, in the same `afterPack`
  // run of the same build, and both ship inside the same signed bundle. There
  // is no mixed-version case here to probe for, so probing could only ever
  // answer wrongly - which is exactly what it did: the previous
  // `--help | grep` form silently dropped the label the moment the option was
  // hidden from help output.
  //
  // The CLI's own emitters (service/platforms/*.ts) DO still probe, via
  // `host capabilities --has service-label`, because their target genuinely
  // can be an N-1 build.
  fs.writeFileSync(
    launcher,
    `#!/bin/sh
set -eu
launcher_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
cli="$launcher_dir/${CLI_BINARY_NAME}"
label="$1"
# No outstanding parent grant is the ordinary boot path. The nonce command
# reserves exit status 1 for that absence; any other failure is an actual
# launcher/CLI failure and must not be silently reclassified as no proof.
nonce=""
if nonce="$("$cli" host adoption-nonce --service-label "$label" 2>/dev/null)"; then
  :
else
  status="$?"
  if [ "$status" -ne 1 ]; then
    exit "$status"
  fi
  nonce=""
fi
if [ -n "$nonce" ]; then
  exec "$cli" host start --service-label "$label" --adoption-nonce "$nonce"
fi
exec "$cli" host start --service-label "$label"
`,
    "utf8",
  );
  fs.chmodSync(launcher, 0o755);
  return launcher;
}

function installHelperApp(appPath, archName) {
  const helperAppPath = helperAppPathFor(appPath);
  const helperMacOSDir = path.join(helperAppPath, "Contents", "MacOS");
  const helperResourcesDir = path.join(helperAppPath, "Contents", "Resources");
  const helperBinary = path.join(helperMacOSDir, CLI_BINARY_NAME);
  const sourceCli = path.join(
    appPath,
    "Contents",
    "Resources",
    "cli",
    `darwin-${archName}`,
    CLI_BINARY_NAME,
  );
  const sourceIcon = path.join(appPath, "Contents", "Resources", "icon.icns");
  if (!fs.existsSync(sourceCli)) {
    throw new Error(`host helper: source CLI missing at ${sourceCli}`);
  }
  if (!fs.existsSync(sourceIcon)) {
    throw new Error(`host helper: app icon missing at ${sourceIcon}`);
  }
  fs.rmSync(helperAppPath, { recursive: true, force: true });
  fs.mkdirSync(helperMacOSDir, { recursive: true });
  fs.mkdirSync(helperResourcesDir, { recursive: true });
  fs.copyFileSync(sourceCli, helperBinary);
  fs.chmodSync(helperBinary, 0o755);
  const compatibilityLauncher =
    writeHostStartCompatibilityLauncher(helperMacOSDir);
  fs.copyFileSync(sourceIcon, path.join(helperResourcesDir, "icon.icns"));

  const helperName = `${PRODUCT_NAME} Host`;
  const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${helperName}</string>
  <key>CFBundleExecutable</key>
  <string>${CLI_BINARY_NAME}</string>
  <key>CFBundleIconFile</key>
  <string>icon</string>
  <key>CFBundleIdentifier</key>
  <string>${APP_ID}.host</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${helperName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0</string>
  <key>CFBundleVersion</key>
  <string>0.0.0</string>
  <key>LSBackgroundOnly</key>
  <true/>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`;
  fs.writeFileSync(
    path.join(helperAppPath, "Contents", "Info.plist"),
    infoPlist,
    "utf8",
  );
  return { helperAppPath, helperBinary, compatibilityLauncher };
}

function codesign(identity, targetPath) {
  const result = spawnSync(
    "codesign",
    ["--force", "--deep", "--sign", identity, targetPath],
    { stdio: "inherit" },
  );
  return result.status === 0;
}

exports.afterPack = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (!isProductionStamped()) return;
  const appPath = appPathFor(context);
  const archName = Arch[context.arch];
  const { helperAppPath, helperBinary, compatibilityLauncher } =
    installHelperApp(appPath, archName);
  // Ad-hoc baseline so the bundle is structurally valid even before
  // electron-builder's own signing step runs. That step (which fires right
  // after afterPack) recursively deep-signs the whole bundle - including this
  // helper - with the real configured identity, superseding this signature.
  // Fail the pack when even the ad-hoc sign refuses: on release builds the
  // real signing pass would sign it anyway, but on local stamped builds
  // (CSC_IDENTITY_AUTO_DISCOVERY=false) this baseline IS the final helper
  // signature, and letting it silently not hold ships an unloadable agent.
  if (!codesign("-", helperAppPath)) {
    throw new Error(
      `inject-host-launch-agent: ad-hoc codesign failed for ${helperAppPath}`,
    );
  }

  const relativeCompatibilityLauncher = path.relative(
    appPath,
    compatibilityLauncher,
  );
  const launchAgentsDir = path.join(
    appPath,
    "Contents",
    "Library",
    "LaunchAgents",
  );
  fs.mkdirSync(launchAgentsDir, { recursive: true });
  // The registered agent plist plus the inert old-label plist (see the
  // label-split rationale above the label constants). Identical bodies
  // apart from the Label; the old one is never loaded by anything - the
  // desktop only ever `unregister`s its serviceName.
  for (const label of [PRODUCTION_AGENT_LABEL, PRODUCTION_LABEL]) {
    fs.writeFileSync(
      path.join(launchAgentsDir, `${label}.plist`),
      buildLaunchAgentPlist(label, relativeCompatibilityLauncher),
      "utf8",
    );
  }
};
