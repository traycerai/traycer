import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  expect,
  test as base,
  type Browser,
  type BrowserType,
  type Page,
} from "@playwright/test";

import { fixture } from "./support/fixtures.ts";

// The Pierre file tree's truncation ellipsis under Electron's page zoom.
//
// Pierre decides a name is middle-truncated by asking whether a hidden
// measurement container is taller than one line. At a fractional zoom that
// container can exceed `1lh` by a subpixel even when the name fits, and the
// tree then paints both ellipsis markers over otherwise roomy rows
// (`PIERRE_FILE_TREE_TRUNCATION_TOLERANCE_CSS` is the workaround). The claim is
// about ELECTRON's zoom - `webContents.setZoomFactor` scales the page the way
// Ctrl-plus does in the desktop app, which Chrome's device-metrics emulation
// does not reproduce - so this runs in a small real Electron app
// (`src/__tests__/browser/pierre-tree-zoom-electron-app/`), started with the
// desktop package's own Electron binary. The test process writes a zoom factor
// to the app's stdin, the app applies it and answers on stdout once two frames
// have painted, and Playwright drives the app's window over its DevTools port.
//
// At every zoom from 0.8x to 1.25x a name that fits gets no ellipsis and a name
// that genuinely overflows keeps its own. Each is its own test; a worker starts
// Electron once and every test in it sets the zoom it needs.
//
// No display is needed: on Linux without one the app runs under `xvfb-run`.

const GUI_APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DESKTOP_ROOT = path.resolve(GUI_APP_ROOT, "../desktop");
const ELECTRON_APP_DIR = path.join(
  GUI_APP_ROOT,
  "src/__tests__/browser/pierre-tree-zoom-electron-app",
);
const ZOOM_LEVELS = [0.8, 0.9, 1, 1.1, 1.25] as const;
// A zoom the page reports through `devicePixelRatio` is exact to this much.
const ZOOM_TOLERANCE = 0.0001;
const STARTUP_TIMEOUT_MS = 60_000;
const ACKNOWLEDGEMENT_TIMEOUT_MS = 20_000;

type PrepareElectronBinary = (
  defaultBinary: string,
  workspaceRoot: string,
  displayName: string,
) => string;

interface ElectronBinaryHelpers {
  readonly prepareElectronBinary: PrepareElectronBinary;
}

function hasPrepareElectronBinary(
  value: unknown,
): value is ElectronBinaryHelpers {
  return (
    typeof value === "object" &&
    value !== null &&
    "prepareElectronBinary" in value &&
    typeof value.prepareElectronBinary === "function"
  );
}

/**
 * The loopback port whose listener is the Electron prepare lock: one per
 * checkout, since each checkout's `node_modules` and desktop `dist/` hold
 * their own binary, and below both Linux's and macOS's ephemeral ranges, so
 * no outgoing connection is ever handed it.
 */
const PREPARE_LOCK_PORT =
  20_000 +
  (createHash("sha256").update(DESKTOP_ROOT).digest().readUInt32BE(0) % 10_000);

/** Listens on the prepare-lock port; `null` while another process holds it. */
async function tryHoldPrepareLock(): Promise<Server | null> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(null);
      else reject(error);
    });
    server.listen({ port: PREPARE_LOCK_PORT, host: "127.0.0.1" }, () => {
      resolve(server);
    });
  });
}

/**
 * Runs `work` holding an exclusive lock, so two workers never prepare the
 * Electron binary at once. Two first calls race in two places:
 * `require("electron")` downloads the binary when it is missing (every fresh
 * CI runner, since bun runs no postinstall) into the package's own `dist/`,
 * and on macOS `prepareElectronBinary` then builds a signed dev bundle in the
 * desktop package. Once both are current the lock is held for an instant.
 *
 * The lock is a listening socket, not a file: the kernel closes it when its
 * holder exits, however it exits, so a worker killed mid-preparation cannot
 * leave it held, and nothing ever has to guess whether a holder is still
 * alive.
 */
async function withPrepareLock<T>(work: () => T): Promise<T> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  for (;;) {
    const lock = await tryHoldPrepareLock();
    if (lock !== null) {
      try {
        return work();
      } finally {
        await new Promise<void>((resolve) => {
          lock.close(() => {
            resolve();
          });
        });
      }
    }
    if (Date.now() > deadline) {
      throw new Error(
        `127.0.0.1:${String(PREPARE_LOCK_PORT)}, the Electron prepare lock, was still held after ${String(STARTUP_TIMEOUT_MS)}ms: another worker is still preparing Electron, or another program listens there`,
      );
    }
    await delay(100);
  }
}

/** The desktop package's Electron binary, prepared as `make dev-desktop` does. */
async function electronBinary(): Promise<string> {
  const requireFromDesktop = createRequire(
    path.join(DESKTOP_ROOT, "package.json"),
  );
  const helpers: unknown = requireFromDesktop(
    "./scripts/dev/electron-binary.cjs",
  );
  if (!hasPrepareElectronBinary(helpers)) {
    throw new Error(
      "electron-binary.cjs does not export prepareElectronBinary",
    );
  }
  return withPrepareLock(() => {
    // Inside the lock: resolving `electron` is what downloads a missing
    // binary. Two workers doing that at once on a fresh runner left one
    // launching a half-written binary ("Electron exited before it was
    // ready"); here the second finds it complete.
    const defaultBinary: unknown = requireFromDesktop("electron");
    if (typeof defaultBinary !== "string") {
      throw new Error(
        "the desktop package's electron did not resolve to a path",
      );
    }
    return helpers.prepareElectronBinary(
      defaultBinary,
      DESKTOP_ROOT,
      "Traycer Tree Zoom Test",
    );
  });
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a debugging port"));
        return;
      }
      server.close(() => {
        resolve(address.port);
      });
    });
  });
}

type ElectronProcess = ChildProcessByStdio<Writable, Readable, Readable>;

function hasExited(child: ElectronProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** Asks the app to quit, then takes the whole process group down if it will not. */
async function terminateElectron(child: ElectronProcess): Promise<void> {
  if (hasExited(child)) return;
  child.stdin.write(`${JSON.stringify({ quit: true })}\n`);
  const deadline = Date.now() + 2_000;
  while (!hasExited(child) && Date.now() < deadline) {
    await delay(50);
  }
  if (hasExited(child) || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // The Electron process group already exited.
  }
}

interface WaitForValue<T> {
  readonly read: () => T | Promise<T>;
  readonly isReady: (value: T) => boolean;
  readonly label: string;
  /** What to print when the wait times out: the app's stderr. */
  readonly describe: () => string;
  readonly timeoutMs: number;
}

/** Polls `read` until `isReady` accepts its value, or fails with `describe()`. */
async function waitForValue<T>(wait: WaitForValue<T>): Promise<T> {
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const value = await wait.read();
    if (wait.isReady(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out waiting for ${wait.label}:\n${wait.describe()}`,
      );
    }
    await delay(50);
  }
}

interface ElectronZoomApp {
  readonly page: Page;
  /** Applies a zoom factor in the app and resolves once it has been painted. */
  setZoom(zoom: number): Promise<void>;
  close(): Promise<void>;
}

async function launchElectronZoomApp(
  chromium: BrowserType,
  pageUrl: string,
): Promise<ElectronZoomApp> {
  const executable = await electronBinary();
  const debuggingPort = await freePort();
  const profilePath = await mkdtemp(path.join(tmpdir(), "traycer-tree-zoom-"));
  const electronEnv = { ...process.env };
  delete electronEnv.ELECTRON_RUN_AS_NODE;
  const electronArgs = [
    "--headless",
    "--no-sandbox",
    `--remote-debugging-port=${String(debuggingPort)}`,
    "--remote-allow-origins=*",
    `--user-data-dir=${profilePath}`,
    ELECTRON_APP_DIR,
    // The app reads its page from the last argument.
    pageUrl,
  ];
  const needsVirtualDisplay =
    process.platform === "linux" && electronEnv.DISPLAY === undefined;
  const child = spawn(
    needsVirtualDisplay ? "xvfb-run" : executable,
    needsVirtualDisplay
      ? [
          "--auto-servernum",
          "--server-args=-screen 0 1280x1024x24",
          executable,
          ...electronArgs,
        ]
      : electronArgs,
    {
      cwd: GUI_APP_ROOT,
      env: electronEnv,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  let browser: Browser | null = null;
  const close = async (): Promise<void> => {
    await browser?.close();
    await terminateElectron(child);
    await rm(profilePath, { recursive: true, force: true, maxRetries: 3 });
  };

  try {
    const devtoolsUrl = `http://127.0.0.1:${String(debuggingPort)}`;
    await waitForValue({
      read: async () => {
        if (hasExited(child)) {
          throw new Error(`Electron exited before it was ready:\n${stderr}`);
        }
        try {
          return (await fetch(`${devtoolsUrl}/json/version`)).ok;
        } catch {
          // The DevTools port has not bound yet.
          return false;
        }
      },
      isReady: (ready) => ready,
      label: "Electron DevTools",
      describe: () => stderr,
      timeoutMs: STARTUP_TIMEOUT_MS,
    });
    browser = await chromium.connectOverCDP(devtoolsUrl);
    const connected = browser;
    const page = await waitForValue({
      read: () =>
        connected
          .contexts()
          .flatMap((context) => context.pages())
          .find((candidate) => candidate.url() === pageUrl),
      isReady: (candidate) => candidate !== undefined,
      label: "the Electron fixture page",
      describe: () => stderr,
      timeoutMs: STARTUP_TIMEOUT_MS,
    });
    if (page === undefined)
      throw new Error("the Electron fixture page is gone");
    await page.waitForFunction(() => {
      const trees = document.querySelectorAll("file-tree-container");
      return (
        trees.length === 2 &&
        [...trees].every((tree) =>
          tree.shadowRoot?.querySelector("[data-truncate-marker]"),
        )
      );
    });

    let requests = 0;
    return {
      page,
      close,
      setZoom: async (zoom) => {
        requests += 1;
        const id = `zoom-${String(requests)}`;
        child.stdin.write(`${JSON.stringify({ id, zoom })}\n`);
        await waitForValue({
          read: () => stdout,
          isReady: (output) => output.includes(`"id":"${id}"`),
          label: `Electron zoom acknowledgement for ${String(zoom)}`,
          describe: () => stderr,
          timeoutMs: ACKNOWLEDGEMENT_TIMEOUT_MS,
        });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

const test = base.extend<
  Record<never, never>,
  { electronApp: ElectronZoomApp }
>({
  electronApp: [
    async ({ playwright }, use, workerInfo) => {
      const baseURL = workerInfo.project.use.baseURL;
      if (baseURL === undefined) {
        throw new Error("playwright.config.ts sets no baseURL");
      }
      const app = await launchElectronZoomApp(
        playwright.chromium,
        new URL(fixture("pierre-tree-zoom"), baseURL).href,
      );
      await use(app);
      await app.close();
    },
    { scope: "worker", timeout: STARTUP_TIMEOUT_MS * 2 },
  ],
});

interface TreeReading {
  readonly rows: number;
  readonly markerOpacities: string[];
}

interface ZoomReading {
  readonly devicePixelRatio: number;
  readonly roomy: TreeReading;
  readonly overflow: TreeReading;
}

/** Zooms the app and reads both trees at that zoom. */
async function readAt(
  app: ElectronZoomApp,
  zoom: number,
): Promise<ZoomReading> {
  await app.setZoom(zoom);
  const reading = await app.page.evaluate((): ZoomReading => {
    const inspect = (name: string): TreeReading => {
      const root = document
        .querySelector(`[data-tree-case="${name}"]`)
        ?.querySelector("file-tree-container")?.shadowRoot;
      const markers = [
        ...(root?.querySelectorAll("[data-truncate-marker]") ?? []),
      ];
      return {
        rows: root?.querySelectorAll('button[data-type="item"]').length ?? 0,
        markerOpacities: markers.map(
          (marker) => getComputedStyle(marker).opacity,
        ),
      };
    };
    return {
      devicePixelRatio: window.devicePixelRatio,
      roomy: inspect("roomy"),
      overflow: inspect("overflow"),
    };
  });
  expect(
    Math.abs(reading.devicePixelRatio - zoom),
    `Electron did not apply zoom ${String(zoom)}: ${String(reading.devicePixelRatio)}`,
  ).toBeLessThan(ZOOM_TOLERANCE);
  return reading;
}

for (const zoom of ZOOM_LEVELS) {
  test(`at ${String(zoom)}x a name that fits gets no ellipsis`, async ({
    electronApp,
  }) => {
    const { roomy } = await readAt(electronApp, zoom);
    expect(
      roomy.rows,
      `roomy tree has no rows at zoom ${String(zoom)}`,
    ).toBeGreaterThan(0);
    expect(
      roomy.markerOpacities.length,
      `roomy tree has no truncation markers at zoom ${String(zoom)}`,
    ).toBeGreaterThan(0);
    expect(
      roomy.markerOpacities.every((opacity) => opacity === "0"),
      `roomy names gained an ellipsis at zoom ${String(zoom)}: ${roomy.markerOpacities.join(", ")}`,
    ).toBe(true);
  });

  test(`at ${String(zoom)}x a name that genuinely overflows keeps its ellipsis`, async ({
    electronApp,
  }) => {
    const { overflow } = await readAt(electronApp, zoom);
    expect(
      overflow.markerOpacities.some((opacity) => opacity === "1"),
      `genuine overflow lost its ellipsis at zoom ${String(zoom)}`,
    ).toBe(true);
  });
}
