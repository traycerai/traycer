import { v4 as uuidv4 } from "uuid";
import {
  BROWSER_VIEW_VIEWPORT_PRESET_IDS,
  type BrowserViewViewportPresetId,
} from "@traycer-clients/shared/platform/browser-view";
import { DEFAULT_BROWSER_VIEWPORT_PRESET } from "@/lib/browser-view/browser-tile-defaults";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_BROWSER_SESSION } from "../tile-kinds";
import type { BrowserSessionTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

/**
 * Re-exported, not defined here: they are browser facts and now live in
 * `@/lib/browser-view/browser-tile-defaults`, which the shared tab-tile body
 * can import without reaching into the canvas store. This module keeps naming
 * them so its own callers do not have to learn a second import site.
 */
export {
  DEFAULT_BROWSER_TILE_URL,
  DEFAULT_BROWSER_VIEWPORT_PRESET,
} from "@/lib/browser-view/browser-tile-defaults";

/** Constant label, like the blank tile's - a browser tab is never renamed. */
export const BROWSER_TILE_NAME = "Browser";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBrowserViewportPreset(
  value: unknown,
): value is BrowserViewViewportPresetId {
  return (
    typeof value === "string" &&
    BROWSER_VIEW_VIEWPORT_PRESET_IDS.some((preset) => preset === value)
  );
}

/** The tile's canvas node id, derived from the session/tab it shows. Shared so
 * a lookup by id (notification deep-links) cannot drift from what open does. */
export function browserSessionTileId(args: {
  readonly sessionId: string;
  readonly tabId: string;
}): string {
  return `${TILE_KIND_BROWSER_SESSION}:${args.sessionId}:${args.tabId}`;
}

export function makeBrowserSessionTileRef(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): BrowserSessionTileRef {
  return {
    id: browserSessionTileId(args),
    instanceId: uuidv4(),
    type: TILE_KIND_BROWSER_SESSION,
    name: BROWSER_TILE_NAME,
    hostId: args.hostId,
    sessionId: args.sessionId,
    tabId: args.tabId,
    viewportPreset: DEFAULT_BROWSER_VIEWPORT_PRESET,
  };
}

function parseBrowserSessionTileRef(
  value: unknown,
): BrowserSessionTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_BROWSER_SESSION ||
    typeof value.id !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.sessionId !== "string" ||
    typeof value.tabId !== "string" ||
    !isBrowserViewportPreset(value.viewportPreset)
  ) {
    return null;
  }
  return {
    id: value.id,
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_BROWSER_SESSION,
    name: BROWSER_TILE_NAME,
    hostId: value.hostId,
    sessionId: value.sessionId,
    tabId: value.tabId,
    viewportPreset: value.viewportPreset,
  };
}

function serializeBrowserSessionTileRef(
  ref: BrowserSessionTileRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    sessionId: ref.sessionId,
    tabId: ref.tabId,
    viewportPreset: ref.viewportPreset,
  };
}

export const browserSessionTileSchema: TileSchema<BrowserSessionTileRef> = {
  parse: parseBrowserSessionTileRef,
  serialize: serializeBrowserSessionTileRef,
  isRecordBacked: false,
};
