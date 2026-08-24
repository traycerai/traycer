/**
 * Schema + factory for the agent's own browser tile. Mirrors `browser-tile.ts`
 * including `viewportPreset` so the shared toolbar can persist device chrome.
 */
import type { DesktopJsonValue } from "@/lib/windows/types";
import { TILE_KIND_AGENT_BROWSER } from "../tile-kinds";
import type { AgentBrowserTileRef } from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

export const DEFAULT_AGENT_BROWSER_VIEWPORT_PRESET = "responsive";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseAgentBrowserTileRef(value: unknown): AgentBrowserTileRef | null {
  if (!isRecord(value)) return null;
  if (
    value.type !== TILE_KIND_AGENT_BROWSER ||
    typeof value.id !== "string" ||
    typeof value.name !== "string" ||
    typeof value.hostId !== "string" ||
    typeof value.url !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : value.id,
    instanceId: readTileInstanceId(value.instanceId),
    type: TILE_KIND_AGENT_BROWSER,
    name: value.name,
    hostId: value.hostId,
    url: value.url,
    viewportPreset:
      typeof value.viewportPreset === "string"
        ? value.viewportPreset
        : DEFAULT_AGENT_BROWSER_VIEWPORT_PRESET,
    runtime: value.runtime === "primary" ? "primary" : "isolated",
  };
}

function serializeAgentBrowserTileRef(
  ref: AgentBrowserTileRef,
): DesktopJsonValue {
  return {
    id: ref.id,
    sessionId: ref.sessionId,
    instanceId: ref.instanceId,
    type: ref.type,
    name: ref.name,
    hostId: ref.hostId,
    url: ref.url,
    viewportPreset: ref.viewportPreset,
    runtime: ref.runtime,
  };
}

export const agentBrowserTileSchema: TileSchema<AgentBrowserTileRef> = {
  parse: parseAgentBrowserTileRef,
  serialize: serializeAgentBrowserTileRef,
  isRecordBacked: false,
};
