import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { log } from "./logger";
import { createJsonFileStore } from "./json-file-store";

const STORE_FILE_NAME = "gpu-acceleration.json";

interface GpuPreference {
  readonly hardwareAccelerationEnabled: boolean;
}

const DEFAULT_PREFERENCE: GpuPreference = { hardwareAccelerationEnabled: true };

function parsePreference(value: unknown): GpuPreference {
  if (value !== null && typeof value === "object") {
    const obj = value as Partial<GpuPreference>;
    return {
      hardwareAccelerationEnabled: obj.hardwareAccelerationEnabled !== false,
    };
  }
  return DEFAULT_PREFERENCE;
}

function storePath(): string {
  return join(app.getPath("userData"), STORE_FILE_NAME);
}

// The async store is created lazily - `app.getPath("userData")` is not
// available until the app module has booted, which happens before
// `applyHardwareAccelerationPreference` runs but uses sync I/O on that
// path.
function getAsyncStore() {
  return createJsonFileStore<GpuPreference>(
    storePath(),
    DEFAULT_PREFERENCE,
    parsePreference,
  );
}

/**
 * Must run pre-`whenReady` - `app.disableHardwareAcceleration` is rejected
 * after. Reads sync because there's no event loop pumping yet.
 */
export function applyHardwareAccelerationPreference(): void {
  let enabled = true;
  try {
    const raw = readFileSync(storePath(), "utf8");
    enabled = parsePreference(JSON.parse(raw)).hardwareAccelerationEnabled;
  } catch {
    // First-run or unreadable file - keep the default (enabled).
  }
  if (!enabled) {
    app.disableHardwareAcceleration();
    log.info("[gpu] hardware acceleration disabled via persisted preference");
  }
}

export async function setHardwareAccelerationPreference(
  enabled: boolean,
): Promise<boolean> {
  await getAsyncStore().save({ hardwareAccelerationEnabled: enabled });
  log.info("[gpu] preference saved", { enabled });
  return enabled;
}

export async function getHardwareAccelerationPreference(): Promise<boolean> {
  return (await getAsyncStore().load()).hardwareAccelerationEnabled;
}
