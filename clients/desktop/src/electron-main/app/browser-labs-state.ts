import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createJsonFileStore } from "./json-file-store";
import { log } from "./logger";

const STORE_FILE_NAME = "browser-labs-state.json";

export interface BrowserLabsState {
  readonly inAppBrowserBetaEnabled: boolean;
}

const DEFAULT_STATE: BrowserLabsState = {
  inAppBrowserBetaEnabled: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseState(value: unknown): BrowserLabsState {
  if (!isRecord(value)) return DEFAULT_STATE;
  return {
    inAppBrowserBetaEnabled: value.inAppBrowserBetaEnabled === true,
  };
}

function storePath(): string {
  return join(app.getPath("userData"), STORE_FILE_NAME);
}

function getStore() {
  return createJsonFileStore<BrowserLabsState>(
    storePath(),
    DEFAULT_STATE,
    parseState,
  );
}

export function readInAppBrowserBetaEnabledSync(): boolean {
  try {
    const raw = readFileSync(storePath(), "utf8");
    return parseState(JSON.parse(raw)).inAppBrowserBetaEnabled;
  } catch (err) {
    if (!hasErrorCode(err, "ENOENT")) {
      log.warn("[browser-labs] marker load failed", {
        filePath: storePath(),
        err,
      });
    }
    return DEFAULT_STATE.inAppBrowserBetaEnabled;
  }
}

export async function setInAppBrowserBetaEnabledMarker(
  enabled: boolean,
): Promise<boolean> {
  await getStore().save({ inAppBrowserBetaEnabled: enabled });
  log.info("[browser-labs] marker saved", {
    inAppBrowserBetaEnabled: enabled,
  });
  return enabled;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
