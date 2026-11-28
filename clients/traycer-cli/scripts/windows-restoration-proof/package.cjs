"use strict";

const { execFileSync } = require("node:child_process");
const { copyFileSync, mkdirSync } = require("node:fs");
const { join, resolve } = require("node:path");
const {
  buildSingleSeaExecutable,
  bundleCjs,
} = require("../../../../scripts/native-packaging/sea-toolchain.cjs");

async function main() {
  execFileSync("bun", [join(__dirname, "__tests__", "check-commands.ts")], {
    stdio: "inherit",
  });
  const [legacyCheckout, outputDirectory, liveFixture] = process.argv.slice(2);
  if (legacyCheckout === "--check-commands") return;
  if (
    process.platform !== "win32" ||
    process.arch !== "x64" ||
    !legacyCheckout ||
    !outputDirectory ||
    !liveFixture
  ) {
    throw new Error(
      "The proof kit requires Windows x64 and the pinned legacy checkout",
    );
  }
  const cli = resolve(__dirname, "../..");
  const legacy = resolve(legacyCheckout, "clients/traycer-cli");
  const output = resolve(outputDirectory);
  const build = join(output, "build");
  mkdirSync(build, { recursive: true });
  const externals = ["bun:sqlite"];
  const proof = join(build, "restoration-proof.cjs");
  await bundleCjs({
    entry: join(__dirname, "__tests__", "restore-proof.ts"),
    outfile: proof,
    tsconfig: join(cli, "tsconfig.json"),
    cwd: cli,
    externals,
  });
  const legacyWriter = join(build, "legacy-writer.cjs");
  await bundleCjs({
    entry: join(__dirname, "legacy-pending-writer.ts"),
    outfile: legacyWriter,
    tsconfig: join(legacy, "tsconfig.json"),
    cwd: legacy,
    externals,
    plugins: [
      {
        name: "legacy-windows-restoration-manifest",
        setup(plugin) {
          plugin.onResolve(
            { filter: /^legacy-windows-restoration-manifest$/ },
            () => ({
              path: join(legacy, "src/manifest/cli-manifest.ts"),
            }),
          );
        },
      },
    ],
  });
  for (const [bundleFile, name] of [
    [proof, "traycer-win-restore-proof"],
    [join(__dirname, "proof-host.cjs"), "traycer-win-restore-test-host"],
    [legacyWriter, "traycer-win-restore-legacy-writer"],
  ]) {
    buildSingleSeaExecutable({
      workDir: build,
      bundleFile,
      configFile: join(build, `${name}.json`),
      blobFile: join(build, `${name}.blob`),
      outputBinary: join(output, `${name}.exe`),
      assets: null,
    });
  }
  copyFileSync(join(cli, "dist-sea/traycer.exe"), join(output, "traycer.exe"));
  copyFileSync(resolve(liveFixture), join(output, "traycer-live.exe"));
  for (const script of [
    "Invoke-Proof.ps1",
    "Proof-Process.ps1",
    "Run-RestartCase.ps1",
    "Set-ProofTask.ps1",
  ]) {
    copyFileSync(join(__dirname, script), join(output, script));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
