"use strict";
// Builds the shell's first-party native addons and drops them beside the main
// bundle (`dist/main/native/`). Today that is one macOS-only addon, the
// trackpad scroll-phase monitor; every other platform has nothing to build.
//
// The addon is pure Node-API, so the binary built against this Node's headers
// loads unchanged inside Electron (Node-API is ABI-stable across both); no
// Electron-header download or `@electron/rebuild` step is needed. The two
// arches are built separately and lipo'd into one universal file so the same
// `dist/` serves electron-builder's arm64 and x64 targets.
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const desktopRoot = path.resolve(__dirname, "..");
const addonDir = path.join(desktopRoot, "native", "trackpad-scroll-phase");
const addonName = "trackpad_scroll_phase";
const outputDir = path.join(desktopRoot, "dist", "main", "native");

function main() {
  if (process.platform !== "darwin") {
    console.log("[build-native-addons] nothing to build off macOS");
    return;
  }
  const nodeGypEntry = require.resolve("node-gyp/bin/node-gyp.js");
  // `rebuild` wipes the addon's build/ each time, so per-arch slices are
  // parked outside it until lipo has both.
  const sliceDir = fs.mkdtempSync(path.join(os.tmpdir(), "traycer-native-"));
  const slices = [];
  for (const arch of ["arm64", "x64"]) {
    execFileSync(
      process.execPath,
      [nodeGypEntry, "rebuild", "--directory", addonDir, `--arch=${arch}`],
      { cwd: desktopRoot, stdio: "inherit" },
    );
    const built = path.join(addonDir, "build", "Release", `${addonName}.node`);
    const slice = path.join(sliceDir, `${addonName}-${arch}.node`);
    fs.copyFileSync(built, slice);
    slices.push(slice);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const universal = path.join(outputDir, `${addonName}.node`);
  execFileSync("lipo", ["-create", ...slices, "-output", universal], {
    stdio: "inherit",
  });
  fs.rmSync(sliceDir, { recursive: true, force: true });
  console.log(`[build-native-addons] wrote ${path.relative(desktopRoot, universal)}`);
}

main();
