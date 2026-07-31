/**
 * Schema for artifact-backed (`EpicArtifactRef`) and renderer-local
 * terminal (`EpicTerminalRef`) / file-preview (`WorkspaceFileRef`) tiles -
 * together `EpicNodeRef`. The schema objects differ only in
 * `isRecordBacked`: chat / agents / collab docs are Y.Doc-backed;
 * terminal / workspace-file are not.
 */
import type { DesktopJsonValue } from "@/lib/windows/types";
import { providerIdSchema } from "@traycer/protocol/host/provider-schemas";
import { DEFAULT_TERMINAL_TITLE } from "@/lib/terminals/terminal-title";
import {
  WORKSPACE_FILE_TAB_KIND,
  isRecordBackedEpicNodeKind,
  type EpicArtifactRef,
  type EpicNodeRef,
  type EpicTerminalRef,
  type WorkspaceFileRef,
} from "../types";
import type { TileSchema } from "./index";
import { readTileInstanceId } from "./instance-id";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// `undefined` for every ref written before this field existed, and for every
// ordinary shell tile - both read as "the tile owns this session". Only the
// exact `"provider-login"` marker suppresses the tile's own `terminal.create`,
// so an unrecognized future value degrades to the safe, existing behaviour.
function parseTerminalOrigin(value: unknown): EpicTerminalRef["origin"] {
  if (value === "shell" || value === "provider-login") return value;
  return undefined;
}

// Only meaningful alongside `origin: "provider-login"`; an id the current
// build does not recognize reads as absent, which degrades to "cannot offer a
// retry" rather than calling the RPC with a provider that does not exist.
function parseTerminalOriginProviderId(
  value: unknown,
): EpicTerminalRef["originProviderId"] {
  const parsed = providerIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

function parseTerminalTitleSource(
  value: unknown,
  name: string,
): EpicTerminalRef["titleSource"] {
  if (value === "manual" || value === "default") return value;
  return name === DEFAULT_TERMINAL_TITLE ? "default" : "manual";
}

export function parseEpicNodeRef(value: unknown): EpicNodeRef | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (typeof value.hostId !== "string") {
    return null;
  }
  const instanceId = readTileInstanceId(value.instanceId);
  if (value.type === WORKSPACE_FILE_TAB_KIND) {
    if (
      typeof value.workspacePath !== "string" ||
      value.workspacePath.length === 0 ||
      typeof value.filePath !== "string" ||
      value.filePath.length === 0
    ) {
      return null;
    }
    return {
      id: value.id,
      instanceId,
      type: WORKSPACE_FILE_TAB_KIND,
      name: value.name,
      hostId: value.hostId,
      workspacePath: value.workspacePath,
      filePath: value.filePath,
    };
  }
  if (value.type === "terminal") {
    if (typeof value.cwd !== "string" || value.cwd.length === 0) {
      return null;
    }
    return {
      id: value.id,
      instanceId,
      type: "terminal",
      name: value.name,
      titleSource: parseTerminalTitleSource(value.titleSource, value.name),
      hostId: value.hostId,
      cwd: value.cwd,
      origin: parseTerminalOrigin(value.origin),
      originProviderId: parseTerminalOriginProviderId(value.originProviderId),
    };
  }
  if (!isRecordBackedEpicNodeKind(value.type)) {
    return null;
  }
  return {
    id: value.id,
    instanceId,
    type: value.type,
    name: value.name,
    hostId: value.hostId,
  };
}

function serializeEpicNodeRef(node: EpicNodeRef): DesktopJsonValue {
  if (node.type === WORKSPACE_FILE_TAB_KIND) {
    return {
      id: node.id,
      instanceId: node.instanceId,
      type: node.type,
      name: node.name,
      hostId: node.hostId,
      workspacePath: node.workspacePath,
      filePath: node.filePath,
    };
  }
  if (node.type === "terminal") {
    return {
      id: node.id,
      instanceId: node.instanceId,
      type: node.type,
      name: node.name,
      titleSource: node.titleSource,
      hostId: node.hostId,
      cwd: node.cwd,
      // Persistence reconstructs a ref field by field and drops anything the
      // serializer does not name, so omitting this here would silently turn
      // every sign-in tile back into a plain shell tile across a reload - the
      // exact failure the marker exists to prevent.
      origin: node.origin ?? null,
      originProviderId: node.originProviderId ?? null,
    };
  }
  return {
    id: node.id,
    instanceId: node.instanceId,
    type: node.type,
    name: node.name,
    hostId: node.hostId,
  };
}

function parseEpicArtifactRef(value: unknown): EpicArtifactRef | null {
  const ref = parseEpicNodeRef(value);
  return ref !== null &&
    ref.type !== WORKSPACE_FILE_TAB_KIND &&
    ref.type !== "terminal"
    ? ref
    : null;
}

function parseEpicTerminalRef(value: unknown): EpicTerminalRef | null {
  const ref = parseEpicNodeRef(value);
  return ref !== null && ref.type === "terminal" ? ref : null;
}

function parseWorkspaceFileRef(value: unknown): WorkspaceFileRef | null {
  const ref = parseEpicNodeRef(value);
  return ref !== null && ref.type === WORKSPACE_FILE_TAB_KIND ? ref : null;
}

export const recordBackedArtifactTileSchema: TileSchema<EpicArtifactRef> = {
  parse: parseEpicArtifactRef,
  serialize: serializeEpicNodeRef,
  isRecordBacked: true,
};

export const terminalTileSchema: TileSchema<EpicTerminalRef> = {
  parse: parseEpicTerminalRef,
  serialize: serializeEpicNodeRef,
  isRecordBacked: false,
};

export const workspaceFileTileSchema: TileSchema<WorkspaceFileRef> = {
  parse: parseWorkspaceFileRef,
  serialize: serializeEpicNodeRef,
  isRecordBacked: false,
};
