#!/usr/bin/env bun
"use strict";

const { spawn } = require("node:child_process");
const { createServer } = require("node:net");
const { existsSync } = require("node:fs");
const { mkdtemp, mkdir, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { prepareElectronBinary } = require("../dev/electron-binary.cjs");
const {
  applyResolutionViewport,
  captureScreenshot,
  connectCdp,
  evaluateCurrentZoom,
  measureFirstTabWidth,
  readZoomPreference,
  waitForInspectablePage,
  waitForRendererReady,
} = require("./helpers.cjs");

const workspaceRoot = path.resolve(__dirname, "..", "..");
// Keep in sync with the header tab Tailwind sizing in
// clients/gui-app/src/components/layout/tabs/tab-strip-item.tsx (`w-56 max-w-56`).
const TAB_WIDTH_CAP_PX = 224;
const ZOOM_TOLERANCE = 0.05;

const matrix = [
  {
    name: "baseline-1366x768@1x",
    width: 1366,
    height: 768,
    scaleFactor: 1,
    seedZoomPercent: 100,
    expectedZoomPercent: 100,
    expectedEstimatedZoomFactor: 1,
    assertTabCapWhenPresent: true,
    launches: 1,
  },
  {
    name: "baseline-1920x1080@1x",
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    seedZoomPercent: 100,
    expectedZoomPercent: 100,
    expectedEstimatedZoomFactor: 1,
    assertTabCapWhenPresent: true,
    launches: 1,
  },
  {
    name: "heuristic-2560x1440@1x",
    width: 2560,
    height: 1440,
    scaleFactor: 1,
    seedZoomPercent: null,
    expectedZoomPercent: 125,
    expectedEstimatedZoomFactor: 1.25,
    assertTabCapWhenPresent: true,
    launches: 1,
  },
  {
    name: "scaled-os-2560x1440@1.5x",
    width: 2560,
    height: 1440,
    scaleFactor: 1.5,
    seedZoomPercent: null,
    expectedZoomPercent: 100,
    expectedEstimatedZoomFactor: 1,
    assertTabCapWhenPresent: true,
    launches: 1,
  },
  {
    name: "heuristic-3840x2160@1x",
    width: 3840,
    height: 2160,
    scaleFactor: 1,
    seedZoomPercent: null,
    expectedZoomPercent: 150,
    expectedEstimatedZoomFactor: 1.5,
    assertTabCapWhenPresent: true,
    launches: 1,
  },
  {
    name: "persisted-150-relaunch-1920x1080@1x",
    width: 1920,
    height: 1080,
    scaleFactor: 1,
    seedZoomPercent: 150,
    expectedZoomPercent: 150,
    expectedEstimatedZoomFactor: 1.5,
    assertTabCapWhenPresent: true,
    launches: 2,
  },
];

async function main() {
  ensureBuiltDesktop();
  const outputDir = path.resolve(
    workspaceRoot,
    "dist",
    "resolution-snapshots",
    timestamp(),
  );
  await mkdir(outputDir, { recursive: true });

  const results = [];
  const errors = [];
  for (const scenario of matrix) {
    console.log(`[resolution] running ${scenario.name}`);
    try {
      results.push(await runScenario(scenario, outputDir));
    } catch (err) {
      errors.push({
        scenario: scenario.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const manifestPath = path.join(outputDir, "manifest.json");
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        scenarios: results,
        errors,
      },
      null,
      2,
    ),
  );
  console.log(`[resolution] wrote ${manifestPath}`);
  if (errors.length > 0) {
    throw new Error(`${errors.length} resolution scenario(s) failed`);
  }
}

async function runScenario(scenario, outputDir) {
  const profileDir = await mkdtemp(
    path.join(os.tmpdir(), `traycer-resolution-${slug(scenario.name)}-`),
  );
  const homeDir = path.join(profileDir, "home");
  await mkdir(homeDir, { recursive: true });
  if (scenario.seedZoomPercent !== null) {
    await writeInitialZoomPreference(profileDir, scenario.seedZoomPercent);
  }

  const passes = [];
  try {
    for (
      let launchIndex = 0;
      launchIndex < scenario.launches;
      launchIndex += 1
    ) {
      passes.push(
        await runElectronPass(
          scenario,
          outputDir,
          profileDir,
          homeDir,
          launchIndex,
        ),
      );
    }
    const assertions = assertScenario(scenario, passes);
    return {
      ...scenario,
      profileDir:
        process.env.TRAYCER_RESOLUTION_KEEP_PROFILES === "1"
          ? profileDir
          : null,
      assertions,
      passes,
    };
  } finally {
    if (process.env.TRAYCER_RESOLUTION_KEEP_PROFILES !== "1") {
      await rm(profileDir, { recursive: true, force: true });
    }
  }
}

async function runElectronPass(
  scenario,
  outputDir,
  profileDir,
  homeDir,
  launchIndex,
) {
  const port = await getFreePort();
  const electronBin = prepareElectronBinary(
    require("electron"),
    workspaceRoot,
    null,
  );
  const args = [
    `--remote-debugging-port=${port}`,
    "--remote-allow-origins=*",
    `--force-device-scale-factor=${scenario.scaleFactor}`,
    `--window-size=${scenario.width},${scenario.height}`,
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    workspaceRoot,
  ];
  const childEnv = {
    ...createResolutionChildEnv(process.env),
    HOME: homeDir,
    TRAYCER_DESKTOP_DEV_APP_PATH: workspaceRoot,
    TRAYCER_RESOLUTION_TEST_DISABLE_MAXIMIZE: "1",
    TRAYCER_RESOLUTION_TEST_USE_BUILT_RENDERER: "1",
    TRAYCER_RESOLUTION_TEST_USER_DATA_DIR: profileDir,
    TRAYCER_RESOLUTION_TEST_DISPLAY_BOUNDS: `${scenario.width}x${scenario.height}`,
    TRAYCER_RESOLUTION_TEST_DISPLAY_SCALE_FACTOR: String(scenario.scaleFactor),
    TRAYCER_RESOLUTION_TEST_WINDOW_BOUNDS: `${scenario.width}x${scenario.height}`,
  };
  delete childEnv.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronBin, args, {
    cwd: workspaceRoot,
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr = [];
  child.stderr.on("data", (chunk) => {
    stderr.push(chunk.toString());
  });
  const spawnFailure = new Promise((_, reject) => {
    child.once("error", reject);
  });

  let client = null;
  try {
    const target = await Promise.race([
      waitForInspectablePage(port, 30_000),
      spawnFailure,
    ]);
    client = await connectCdp(target.webSocketDebuggerUrl);
    await waitForRendererReady(client, 30_000);
    await applyResolutionViewport(client, scenario);
    await settle();

    const screenshotPath = path.join(
      outputDir,
      `${slug(scenario.name)}-launch-${launchIndex + 1}.png`,
    );
    await captureScreenshot(client, screenshotPath);
    const zoom = await evaluateCurrentZoom(client, scenario.scaleFactor);
    const tab = await measureFirstTabWidth(client);
    const zoomPreference = await readZoomPreference(profileDir);

    return {
      launchIndex: launchIndex + 1,
      screenshotPath,
      zoom,
      tab,
      zoomPreference:
        zoomPreference === null
          ? null
          : {
              path: zoomPreference.path,
              relativePath: path.relative(profileDir, zoomPreference.path),
              value: zoomPreference.value,
            },
      stderrTail: tail(stderr.join(""), 4000),
    };
  } finally {
    if (client !== null) client.close();
    child.kill("SIGTERM");
    await waitForExit(child, 5_000);
  }
}

function createResolutionChildEnv(env) {
  const childEnv = { ...env };
  delete childEnv.DEV_DESKTOP_SLOT;
  delete childEnv.TRAYCER_DESKTOP_DEV_DISPLAY_NAME;
  return childEnv;
}

function ensureBuiltDesktop() {
  const mainPath = path.join(workspaceRoot, "dist", "main", "index.js");
  const preloadPath = path.join(workspaceRoot, "dist", "preload", "index.js");
  const rendererPath = path.join(
    workspaceRoot,
    "dist",
    "renderer",
    "index.html",
  );
  const missing = [mainPath, preloadPath, rendererPath].filter(
    (filePath) => !existsSync(filePath),
  );
  if (missing.length > 0) {
    throw new Error(
      `Desktop build output is missing. Run 'bun run build:app' first.\n${missing.join(
        "\n",
      )}`,
    );
  }
}

async function writeInitialZoomPreference(profileDir, zoomPercent) {
  await mkdir(profileDir, { recursive: true });
  await writeFile(
    path.join(profileDir, "window-zoom.json"),
    JSON.stringify({ zoomPercent }, null, 2),
  );
}

function assertScenario(scenario, passes) {
  const assertions = [];
  passes.forEach((pass) => {
    const zoomPercent = readZoomPercentFromPass(pass);
    assertEqual(
      zoomPercent,
      scenario.expectedZoomPercent,
      `${scenario.name} launch ${pass.launchIndex} zoom preference`,
    );
    assertions.push({
      launchIndex: pass.launchIndex,
      kind: "zoomPreference",
      expected: scenario.expectedZoomPercent,
      actual: zoomPercent,
    });

    assertClose(
      pass.zoom.estimatedZoomFactor,
      scenario.expectedEstimatedZoomFactor,
      ZOOM_TOLERANCE,
      `${scenario.name} launch ${pass.launchIndex} estimated zoom factor`,
    );
    assertions.push({
      launchIndex: pass.launchIndex,
      kind: "estimatedZoomFactor",
      expected: scenario.expectedEstimatedZoomFactor,
      actual: pass.zoom.estimatedZoomFactor,
    });

    if (scenario.assertTabCapWhenPresent && pass.tab !== null) {
      assertLessThanOrEqual(
        pass.tab.width,
        TAB_WIDTH_CAP_PX,
        `${scenario.name} launch ${pass.launchIndex} tab width cap`,
      );
      assertions.push({
        launchIndex: pass.launchIndex,
        kind: "tabWidthCap",
        expectedMax: TAB_WIDTH_CAP_PX,
        actual: pass.tab.width,
      });
    } else if (scenario.assertTabCapWhenPresent) {
      assertions.push({
        launchIndex: pass.launchIndex,
        kind: "tabWidthCap",
        skipped: "no rendered header tab in this profile",
      });
    }
  });
  return assertions;
}

function readZoomPercentFromPass(pass) {
  const value = pass.zoomPreference === null ? null : pass.zoomPreference.value;
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof value.zoomPercent === "number"
  ) {
    return value.zoomPercent;
  }
  return null;
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function assertClose(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(
      `${label}: expected ${expected} +/- ${tolerance}, got ${actual}`,
    );
  }
}

function assertLessThanOrEqual(actual, expectedMax, label) {
  if (actual > expectedMax) {
    throw new Error(`${label}: expected <= ${expectedMax}, got ${actual}`);
  }
}

async function getFreePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((err) => (err === undefined ? resolve() : reject(err)));
  });
  if (address === null || typeof address === "string") {
    throw new Error("Unable to reserve a local debugging port");
  }
  return address.port;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 1_500));
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function slug(value) {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
}

function tail(value, maxLength) {
  if (value.length <= maxLength) return value;
  return value.slice(value.length - maxLength);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[resolution] failed");
    console.error(err);
    process.exit(1);
  });
}

module.exports = { createResolutionChildEnv };
