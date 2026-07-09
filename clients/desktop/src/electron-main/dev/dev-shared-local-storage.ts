import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ipcMain, session, type WebFrameMain } from "electron";
import type { Environment } from "../../config";
import { devRendererOriginFromEnv } from "../../ipc-contracts/dev-renderer-origin";
import { devDesktopSlotForEnvironment } from "../host/dev-desktop-slot";
import { log } from "../app/logger";
import {
  DEV_SHARED_LOCAL_STORAGE_ENVELOPE_VERSION,
  DEV_SHARED_LOCAL_STORAGE_SEEDED_MARKER_KEY,
  DEV_SHARED_LOCAL_STORAGE_SYNC_CHANNEL,
} from "./dev-shared-local-storage-protocol";

// Every `make dev-desktop` worktree gets its own Electron `userData` dir and
// its own dynamically-allocated renderer port, so its localStorage origin is
// fresh on first launch - blank sign-in, blank settings. This module makes
// that origin inherit from a machine-wide snapshot instead: seed a fresh
// slot profile from it once, and keep it updated from every running slot.
// Deliberately a whole-store mirror, not an allowlist - see the tech plan
// (`dev-shared-local-storage-plan`) for why that's the evolution-safe choice.

const EXPORT_POLL_INTERVAL_MS = 20_000;

// The only two `WebContents` members this module needs. Narrower than
// importing `type WebContents` from `electron`: callers can hand this a
// real `WebContents`, and tests can hand it a plain object literal, with
// no assertion needed either way.
export interface LocalStorageSource {
  isDestroyed(): boolean;
  executeJavaScript(code: string): Promise<unknown>;
}

export interface DevSharedLocalStorageHandle {
  startPolling(getWebContents: () => LocalStorageSource | null): void;
  stopPolling(): void;
  flush(getWebContents: () => LocalStorageSource | null): Promise<void>;
}

interface DevSharedLocalStorageEnvelope {
  readonly version: number;
  readonly exportedBySlot: string;
  readonly exportedAt: string;
  readonly entries: Readonly<Record<string, string>>;
}

export function resolveDevSharedLocalStorageFilePath(): string {
  return join(homedir(), ".traycer", "desktop", "dev", "local-storage.json");
}

export function resolveDevSharedLocalStorageSeedPreloadPath(): string {
  // Bundled as its own esbuild entry (see scripts/build-main-bundle.cjs),
  // co-located with the main + product-preload bundles under dist/:
  // dist/main/index.js -> dist/preload-dev-shared-storage/index.js.
  return join(__dirname, "..", "preload-dev-shared-storage", "index.js");
}

export function parseDevSharedLocalStorageEntries(
  value: unknown,
): Readonly<Record<string, string>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (obj.version !== DEV_SHARED_LOCAL_STORAGE_ENVELOPE_VERSION) {
    return null;
  }
  if (typeof obj.entries !== "object" || obj.entries === null) {
    return null;
  }
  const rawEntries = obj.entries as Record<string, unknown>;
  const entries: Record<string, string> = {};
  for (const [key, entryValue] of Object.entries(rawEntries)) {
    if (typeof entryValue !== "string") {
      return null;
    }
    entries[key] = entryValue;
  }
  return entries;
}

// Read once, at registration time, before any window exists. Later runs'
// exports race each other over the file, not over this read - see the tech
// plan's concurrency note (last-write-wins is bounded to "which sibling a
// future fresh slot inherits from").
export function readDevSharedLocalStorageSnapshotSync(
  filePath: string,
): Readonly<Record<string, string>> | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn("[dev-shared-local-storage] snapshot JSON parse failed", { err });
    return null;
  }
  return parseDevSharedLocalStorageEntries(parsed);
}

export async function writeDevSharedLocalStorageSnapshot(
  filePath: string,
  slot: string,
  entries: Readonly<Record<string, string>>,
): Promise<void> {
  const envelope: DevSharedLocalStorageEnvelope = {
    version: DEV_SHARED_LOCAL_STORAGE_ENVELOPE_VERSION,
    exportedBySlot: slot,
    exportedAt: new Date().toISOString(),
    entries,
  };
  await mkdir(dirname(filePath), { recursive: true });
  // A per-write random suffix (rather than `Date.now()`) so a poll-triggered
  // export and a concurrent quit-time flush never pick the same temp path -
  // millisecond timestamps can collide when both fire in the same tick.
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(envelope, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tmp, filePath);
}

async function dumpLocalStorage(
  webContents: LocalStorageSource,
): Promise<Readonly<Record<string, string>> | null> {
  try {
    const dump: unknown = await webContents.executeJavaScript(
      "({ ...window.localStorage })",
    );
    if (dump === null || typeof dump !== "object") {
      return null;
    }
    return dump as Readonly<Record<string, string>>;
  } catch (err) {
    log.warn("[dev-shared-local-storage] localStorage dump failed", { err });
    return null;
  }
}

// The IPC channel and the extra preload only ever need to serve the same
// dev-slot renderer this main process itself launched. Restricting requests
// to that renderer's own top frame and origin keeps the whole-store snapshot
// (auth ciphertext included) from being handed to an unrelated frame that
// happens to share the default session - e.g. a future script-capable
// embedded preview, or an unexpected navigation that still picks up the
// session-level preload. `senderFrame` is null once its frame has been
// disposed by the time the handler runs; treat that as untrusted too.
function isTrustedDevRendererSender(
  senderFrame: WebFrameMain | null,
  expectedOrigin: string,
): boolean {
  if (senderFrame === null) return false;
  if (senderFrame !== senderFrame.top) return false;
  try {
    return new URL(senderFrame.url).origin === expectedOrigin;
  } catch {
    return false;
  }
}

// Registration is the only slot-gated entry point: with no active
// `DEV_DESKTOP_SLOT`, this never touches the filesystem, never opens the IPC
// channel, and never registers the extra preload - packaged builds and the
// OSS no-slot `make dev-desktop` flow (whose profile is already stable) are
// entirely unaffected. `filePath` is caller-supplied (the caller resolves it
// via `resolveDevSharedLocalStorageFilePath()`) rather than resolved here, so
// this function - and the handle it returns - can be exercised in tests
// against a temp path instead of the real `homedir()`, mirroring how
// `DesktopStateStore` takes its file path as a constructor option.
export function registerDevSharedLocalStorage(options: {
  readonly environment: Environment;
  readonly env: NodeJS.ProcessEnv;
  readonly filePath: string;
}): DevSharedLocalStorageHandle | null {
  const slot = devDesktopSlotForEnvironment(options.environment, options.env);
  if (slot === null) {
    return null;
  }

  const filePath = options.filePath;
  const cachedSnapshot = readDevSharedLocalStorageSnapshotSync(filePath);
  const expectedOrigin = devRendererOriginFromEnv(options.env);

  ipcMain.on(DEV_SHARED_LOCAL_STORAGE_SYNC_CHANNEL, (event) => {
    event.returnValue = isTrustedDevRendererSender(
      event.senderFrame,
      expectedOrigin,
    )
      ? cachedSnapshot
      : null;
  });

  session.defaultSession.registerPreloadScript({
    type: "frame",
    id: "traycer-dev-shared-local-storage-seed",
    filePath: resolveDevSharedLocalStorageSeedPreloadPath(),
  });

  let lastWrittenJson: string | null = null;
  let intervalHandle: NodeJS.Timeout | null = null;

  const exportOnce = async (
    getWebContents: () => LocalStorageSource | null,
  ): Promise<void> => {
    const webContents = getWebContents();
    if (webContents === null || webContents.isDestroyed()) {
      return;
    }
    const dump = await dumpLocalStorage(webContents);
    if (dump === null) {
      return;
    }
    const entries = { ...dump };
    delete entries[DEV_SHARED_LOCAL_STORAGE_SEEDED_MARKER_KEY];
    const nextJson = JSON.stringify(entries);
    if (nextJson === lastWrittenJson) {
      return;
    }
    await writeDevSharedLocalStorageSnapshot(filePath, slot, entries);
    lastWrittenJson = nextJson;
  };

  return {
    startPolling(getWebContents) {
      if (intervalHandle !== null) {
        return;
      }
      intervalHandle = setInterval(() => {
        exportOnce(getWebContents).catch((err: unknown) => {
          log.warn("[dev-shared-local-storage] periodic export failed", {
            err,
          });
        });
      }, EXPORT_POLL_INTERVAL_MS);
    },
    stopPolling() {
      if (intervalHandle !== null) {
        clearInterval(intervalHandle);
        intervalHandle = null;
      }
    },
    flush(getWebContents) {
      return exportOnce(getWebContents);
    },
  };
}
