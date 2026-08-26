import { v4 as uuidv4 } from "uuid";
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_BROWSER_SESSION } from "../tile-kinds";
import type { BrowserSessionTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const DEFAULT_BROWSER_TILE_URL = "about:blank";
export const DEFAULT_BROWSER_VIEWPORT_PRESET = "responsive";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function makeBrowserSessionTileRef(args: {
  readonly hostId: string;
  readonly sessionId: string;
  readonly tabId: string;
}): BrowserSessionTileRef {
  return {
    id: `browser-session:${args.sessionId}:${args.tabId}`,
    instanceId: uuidv4(),
    type: TILE_KIND_BROWSER_SESSION,
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
    typeof value.viewportPreset !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_BROWSER_SESSION,
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
