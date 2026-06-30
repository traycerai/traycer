"use strict";

// Production SEA build for the Traycer CLI. Produces a single, native
// executable per host platform/arch with no `node` / `bun` runtime
// dependency. Output: `dist-sea/traycer[.exe]`.
//
// The CLI has no native addons, so the bundle is fully self-contained -
// we deliberately do NOT externalise anything (commander, undici, etc.
// all bake into the SEA blob). This is what lets the host directory
// stay a directory while the CLI ships as a true single file.

const path = require("node:path");
const fs = require("node:fs");
const {
  assertRunningUnderNode,
  bundleCjs,
  buildSingleSeaExecutable,
  ensureDir,
  exeName,
  logBuildSummary,
  rimraf,
  currentPlatformArch,
} = require("../../../scripts/native-packaging/sea-toolchain.cjs");
const { sentryEsbuildPlugin } = require("@sentry/esbuild-plugin");

assertRunningUnderNode();

const workspaceRoot = path.resolve(__dirname, "..");
const distDir = path.join(workspaceRoot, "dist-sea");
const bundleFile = path.join(distDir, "cli-bundle.cjs");
const configFile = path.join(distDir, "sea-config.json");
const blobFile = path.join(distDir, "sea-prep.blob");
const outputBinary = path.join(distDir, exeName("traycer"));
const cliEntry = path.join(workspaceRoot, "src", "index.ts");
const cliTsconfig = path.join(workspaceRoot, "tsconfig.json");

async function main() {
  rimraf(distDir);
  ensureDir(distDir);

  // Inject the released CLI version into the bundle so `traycer --version`
  // reports the artifact's actual version rather than the source-tree
  // placeholder. CI release workflows set `TRAYCER_CLI_VERSION` to the
  // value derived from the `cli-v<version>` tag; local builds leave it
  // unset and the runtime falls back to `0.0.0-local`.
  //
  // The runtime-side consumer is `resolveCliVersion(...)` in
  // clients/traycer-cli/src/index.ts - its `LOCAL_CLI_VERSION`
  // sentinel must match this fallback literal so a build-without-env reports
  // the same value.
  //
  // IMPORTANT: `resolveCliVersion` reads the version through `readonlyEnv()`
  // (an aliased `process.env`), NOT a literal `process.env.TRAYCER_CLI_VERSION`
  // member access, so the esbuild `define` below does NOT actually substitute
  // it. The real injection is the runtime version shim prepended to the bundle
  // after `bundleCjs` (see below), mirroring build-cli-npm.cjs. Without the
  // shim every SEA binary - brew/scoop/winget/curl - reports `0.0.0-local`. The
  // `define` is kept as belt-and-suspenders for any direct
  // `process.env.TRAYCER_CLI_VERSION` access elsewhere in the bundle.
  const cliVersion =
    typeof process.env.TRAYCER_CLI_VERSION === "string" &&
    process.env.TRAYCER_CLI_VERSION.length > 0
      ? process.env.TRAYCER_CLI_VERSION
      : "0.0.0-local";

  const cliSentryDsn =
    typeof process.env.TRAYCER_CLI_SENTRY_DSN === "string"
      ? process.env.TRAYCER_CLI_SENTRY_DSN
      : "";

  // The host trusted pubkeys (the registry signature trust root) are baked
  // into `src/config.ts` by the deploy step
  // (scripts/set-deploy-target.cjs, from TRAYCER_EMBEDDED_HOST_PUBKEYS)
  // BEFORE this build runs, so esbuild bundles them as part of the config -
  // no separate esbuild define is needed. `trusted-keys.ts` reads
  // `config.hostTrustedPubkeys` + the disk overlay; it never reads env.
  const defines = {
    "process.env.TRAYCER_CLI_VERSION": JSON.stringify(cliVersion),
    "process.env.TRAYCER_CLI_SENTRY_DSN": JSON.stringify(cliSentryDsn),
  };

  const sentryPlugins = (() => {
    if (!process.env.SENTRY_AUTH_TOKEN) return [];
    if (!process.env.SENTRY_ORG) {
      throw new Error("SENTRY_AUTH_TOKEN is set but SENTRY_ORG is missing");
    }
    return [
      sentryEsbuildPlugin({
        authToken: process.env.SENTRY_AUTH_TOKEN,
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT || "traycer-cli",
      }),
    ];
  })();

  // No externals - the CLI bundle is intentionally self-contained so the
  // SEA blob can ship as a single file with no companion directory.
  await bundleCjs({
    entry: cliEntry,
    outfile: bundleFile,
    tsconfig: cliTsconfig,
    externals: [],
    bannerJs: "",
    cwd: workspaceRoot,
    defines,
    sourcemap: sentryPlugins.length > 0,
    plugins: sentryPlugins,
  });

  // Runtime version shim (see the cliVersion comment above for why the esbuild
  // `define` is dead through the `readonlyEnv()` indirection). Strip any
  // hashbang esbuild preserved from the entry and prepend the baked build
  // version before any CLI logic runs, so ambient shell state cannot make a
  // released binary report a local/dev version. Mirrors build-cli-npm.cjs.
  let seaBundle = fs.readFileSync(bundleFile, "utf8");
  seaBundle = seaBundle.replace(/^#![^\n]*\n/, "");
  const versionShim = `process.env.TRAYCER_CLI_VERSION=${JSON.stringify(cliVersion)};`;
  seaBundle = `"use strict";${versionShim}\n${seaBundle}`;
  fs.writeFileSync(bundleFile, seaBundle);

  buildSingleSeaExecutable({
    workDir: workspaceRoot,
    bundleFile,
    configFile,
    blobFile,
    outputBinary,
    assets: null,
  });

  const { platform, arch } = currentPlatformArch();
  const bundleSize = fs.statSync(bundleFile).size;
  const binarySize = fs.statSync(outputBinary).size;
  logBuildSummary("CLI", {
    platform,
    arch,
    version: cliVersion,
    bundle: `${bundleFile} (${bundleSize} bytes)`,
    binary: `${outputBinary} (${binarySize} bytes)`,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
