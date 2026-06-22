import {
  BrowserWindow,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { log } from "./logger";

export interface FindOptions {
  readonly forward: boolean;
  readonly findNext: boolean;
  readonly matchCase: boolean;
}

export interface FindResultSnapshot {
  readonly requestId: number;
  readonly activeMatchOrdinal: number;
  readonly matches: number;
  readonly finalUpdate: boolean;
}

/**
 * Initiates / advances a find-in-page search on the sender's webContents.
 * Returns the requestId Chromium assigns; the matching `found-in-page`
 * event is forwarded to the renderer via `installFindResultForwarder` so
 * the renderer can show match counts in its search UI.
 */
export function handleFindInPage(
  event: IpcMainInvokeEvent,
  text: unknown,
  options: unknown,
): number | null {
  if (typeof text !== "string" || text.length === 0) return null;
  const opts = parseFindOptions(options);
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return null;
  return window.webContents.findInPage(text, opts);
}

const STOP_ACTIONS = [
  "clearSelection",
  "keepSelection",
  "activateSelection",
] as const;
type StopAction = (typeof STOP_ACTIONS)[number];
const STOP_ACTIONS_SET: ReadonlySet<StopAction> = new Set(STOP_ACTIONS);

export function handleStopFindInPage(
  event: IpcMainInvokeEvent,
  action: unknown,
): void {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window === null || window.isDestroyed()) return;
  const stopAction: StopAction =
    typeof action === "string" && STOP_ACTIONS_SET.has(action as StopAction)
      ? (action as StopAction)
      : "clearSelection";
  window.webContents.stopFindInPage(stopAction);
}

function parseFindOptions(options: unknown): {
  forward: boolean;
  findNext: boolean;
  matchCase: boolean;
} {
  if (options === null || typeof options !== "object") {
    return { forward: true, findNext: false, matchCase: false };
  }
  const o = options as Record<string, unknown>;
  return {
    forward: o.forward !== false,
    findNext: o.findNext === true,
    matchCase: o.matchCase === true,
  };
}

/**
 * Forwards Chromium's `found-in-page` event to the renderer so its search
 * UI can display "n of N matches" and current-match position. Wired once
 * per BrowserWindow at create-time.
 */
export function installFindResultForwarder(
  webContents: WebContents,
  emit: (snapshot: FindResultSnapshot) => void,
): void {
  webContents.on("found-in-page", (_event, result) => {
    const snapshot: FindResultSnapshot = {
      requestId: result.requestId,
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
      finalUpdate: result.finalUpdate,
    };
    emit(snapshot);
    log.debug("[find-in-page] result", snapshot);
  });
}
