import { app } from "electron";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../browser-view/guards";
import { createJsonFileStore } from "./json-file-store";
import { log } from "./logger";

const STORE_FILE_NAME = "browser-labs-state.json";

export interface BrowserLabsState {
  readonly inAppBrowserBetaEnabled: boolean;
}

const DEFAULT_STATE: BrowserLabsState = {
  inAppBrowserBetaEnabled: false,
};

function parseState(value: unknown): BrowserLabsState {
  if (!isRecord(value)) return DEFAULT_STATE;
  return {
    inAppBrowserBetaEnabled: value.inAppBrowserBetaEnabled === true,
  };
}

function storePath(): string {
  return join(app.getPath("userData"), STORE_FILE_NAME);
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
): Promise<void> {
  await createJsonFileStore<BrowserLabsState>(
    storePath(),
    DEFAULT_STATE,
    parseState,
  ).save({ inAppBrowserBetaEnabled: enabled });
  log.info("[browser-labs] marker saved", {
    inAppBrowserBetaEnabled: enabled,
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}
