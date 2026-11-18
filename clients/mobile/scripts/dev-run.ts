/**
 * Shared plumbing for the native dev launchers (`dev-ios.ts`, `dev-android.ts`).
 *
 * Both loops do the same four things - resolve the slot, read that slot's
 * `run.json`, wait for the GUI App dev server, and hand Capacitor a
 * live-reload target - and differ only in how a device is named and what has
 * to happen before the WebView can reach loopback. Keeping the common part
 * here means the Android loop cannot drift away from the iOS one it mirrors.
 *
 * This module never starts a stack: `make dev-gui-app` (or `make dev-desktop`)
 * in the internal repository owns that, and the launchers only consume it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizeDevDesktopSlot } from "@traycer-clients/shared/platform/dev-desktop-slot";

export interface DevRunUrls {
  readonly authnBaseUrl: string;
  readonly cloudUiBaseUrl: string;
  readonly guiAppBaseUrl: URL;
}

export interface DevRun {
  readonly urls: DevRunUrls;
  /**
   * The loopback TCP ports recorded in `run.json`. The iOS Simulator shares
   * the Mac's loopback and ignores this; the Android emulator does not, and
   * tunnels each one back with `adb reverse`.
   *
   * NOT the live host RPC port - `run.json` only records the one that was
   * current when the stack came up. `readHostRpcPort` is the live source, and
   * has an ordering requirement this does not.
   */
  readonly ports: readonly number[];
}

export const mobileRoot = resolve(
  fileURLToPath(new URL("..", import.meta.url)),
);

export function readFlag(args: readonly string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (typeof value !== "string" || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function requiredValue(
  args: readonly string[],
  flag: string,
  envName: string,
): string {
  const value = readFlag(args, flag) ?? process.env[envName];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} or ${envName} is required`);
  }
  return value.trim();
}

/** `--slot`/`DEV_DESKTOP_SLOT`, sanitized the same way the orchestrator does. */
export function requireSlot(args: readonly string[]): string {
  const slot = sanitizeDevDesktopSlot(
    requiredValue(args, "--slot", "DEV_DESKTOP_SLOT"),
  );
  if (slot.length === 0) {
    throw new Error("DEV_DESKTOP_SLOT must contain a usable slot name");
  }
  return slot;
}

function devRunDir(slot: string): string {
  return join(homedir(), ".traycer", "host", "dev-runs", slot);
}

function portOf(rawUrl: string): number | null {
  if (!URL.canParse(rawUrl)) return null;
  const port = Number.parseInt(new URL(rawUrl).port, 10);
  return Number.isInteger(port) ? port : null;
}

/**
 * The host's LIVE RPC port, read from `pid.json` rather than `run.json`: the
 * host reallocates it on every restart, and `run.json` records only the port
 * of the run that was current when the stack came up.
 *
 * CALL THIS AFTER `waitForGuiApp`, never before. `vite.config.ts` awaits
 * `pid.json` for up to 30s before its server starts listening, so a GUI App
 * that answers is proof the file exists - whereas at launcher startup it
 * routinely does not yet, and this would return `null` for a stack that is
 * merely still coming up.
 *
 * Best-effort by design: a missing or half-written file costs one tunnel, not
 * the whole loop. Callers must SAY SO when this returns `null`, because the
 * symptom otherwise is an app that paints and then silently never reaches a
 * host.
 */
export function readHostRpcPort(slot: string): number | null {
  const pidPath = join(devRunDir(slot), "pid.json");
  if (!existsSync(pidPath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(pidPath, "utf8"));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const websocketUrl = (parsed as Record<string, unknown>).websocketUrl;
  if (typeof websocketUrl !== "string") return null;
  return portOf(websocketUrl);
}

export function readDevRun(slot: string): DevRun {
  const runMetadataPath = join(devRunDir(slot), "run.json");
  if (!existsSync(runMetadataPath)) {
    throw new Error(
      `No active GUI App dev run found for ${slot}; start make dev-gui-app in the internal repository`,
    );
  }
  const parsed: unknown = JSON.parse(readFileSync(runMetadataPath, "utf8"));
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`Invalid dev run metadata at ${runMetadataPath}`);
  }
  const metadata = parsed as Record<string, unknown>;
  const urls = metadata.urls;
  if (urls === null || typeof urls !== "object") {
    throw new Error(
      `Dev run ${slot} does not publish a GUI App URL; restart make dev-gui-app`,
    );
  }
  const urlRecord = urls as Record<string, unknown>;
  const authnBaseUrl = urlRecord.authnBaseUrl;
  const cloudUiBaseUrl = urlRecord.cloudUiBaseUrl;
  const guiAppBaseUrl = urlRecord.guiAppBaseUrl;
  if (
    typeof authnBaseUrl !== "string" ||
    typeof cloudUiBaseUrl !== "string" ||
    typeof guiAppBaseUrl !== "string"
  ) {
    throw new Error(
      `Dev run ${slot} does not publish GUI App development URLs; restart make dev-gui-app`,
    );
  }
  const url = new URL(guiAppBaseUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.port.length === 0 ||
    url.pathname !== "/" ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new Error(`Invalid GUI App URL in ${runMetadataPath}`);
  }

  const ports = new Set<number>();
  const publishedPorts = metadata.ports;
  if (publishedPorts !== null && typeof publishedPorts === "object") {
    for (const value of Object.values(
      publishedPorts as Record<string, unknown>,
    )) {
      if (typeof value === "number" && Number.isInteger(value)) {
        ports.add(value);
      }
    }
  }
  for (const rawUrl of [authnBaseUrl, cloudUiBaseUrl, guiAppBaseUrl]) {
    const port = portOf(rawUrl);
    if (port !== null) ports.add(port);
  }

  return {
    urls: { authnBaseUrl, cloudUiBaseUrl, guiAppBaseUrl: url },
    ports: [...ports].sort((left, right) => left - right),
  };
}

export async function waitForGuiApp(url: URL): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const ready = await fetch(url, {
      signal: AbortSignal.timeout(1_000),
    })
      .then((response) => response.ok)
      .catch(() => false);
    if (ready) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`GUI App dev server did not become ready at ${url.origin}`);
}

export function ensureWebAssets(slot: string, urls: DevRunUrls): void {
  if (existsSync(join(mobileRoot, "dist", "web", "index.html"))) return;
  console.log("[gui-app] building initial local web assets for Capacitor");
  const build = spawnSync("bun", ["run", "build:web"], {
    cwd: mobileRoot,
    env: {
      ...process.env,
      DEV_DESKTOP_SLOT: slot,
      PORT: urls.guiAppBaseUrl.port,
      TRAYCER_DEV_AUTHN_BASE_URL: urls.authnBaseUrl,
      TRAYCER_DEV_CLOUD_UI_BASE_URL: urls.cloudUiBaseUrl,
    },
    stdio: "inherit",
  });
  if (build.error !== undefined) throw build.error;
  if (build.status !== 0) {
    throw new Error(`GUI App web build failed with exit ${build.status}`);
  }
}

/**
 * Hands the platform to Capacitor with live reload pointed at the shared Vite
 * server, and resolves with its exit code once it stops.
 */
export async function runCapacitorLiveReload(
  platform: "ios" | "android",
  target: string,
  guiAppBaseUrl: URL,
): Promise<number> {
  const capacitor = spawn(
    "bun",
    [
      "x",
      "cap",
      "run",
      platform,
      "--target",
      target,
      "--live-reload",
      "--host",
      guiAppBaseUrl.hostname,
      "--port",
      guiAppBaseUrl.port,
    ],
    {
      cwd: mobileRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  return new Promise<number>((resolveExit, rejectExit) => {
    capacitor.once("error", rejectExit);
    capacitor.once("exit", (code) => resolveExit(code ?? 1));
  });
}
