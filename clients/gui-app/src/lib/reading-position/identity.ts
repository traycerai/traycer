import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";
import type { ReadingPositionIdentity } from "@/lib/reading-position/types";

function encoded(parts: ReadonlyArray<string>): string {
  return parts.map(encodeURIComponent).join(":");
}

function durableIdentity(args: {
  readonly node: EpicCanvasTileRef;
  readonly epicId: string;
  readonly contentParts: ReadonlyArray<string>;
}): ReadingPositionIdentity {
  const contentKey = encoded(args.contentParts);
  return {
    viewKey: args.node.instanceId,
    contentKey,
    deletionKey: contentKey,
    epicId: args.epicId,
    hostId: durableHostId(args.node),
    durability: "durable",
  };
}

/**
 * The host a durable record is SCOPED to, or `null` for a kind whose content is not the reading host's to begin with.
 */
function durableHostId(node: EpicCanvasTileRef): string | null {
  return node.type === "published-chat" ? null : node.hostId;
}

function liveIdentity(
  node: EpicCanvasTileRef,
  epicId: string,
): ReadingPositionIdentity {
  return {
    viewKey: node.instanceId,
    contentKey: null,
    deletionKey: null,
    epicId,
    hostId: node.hostId,
    durability: "renderer-live",
  };
}

/**
 * The tile kinds this module does not key durably: the live ones (keyed per open instance) and the ones it does not track at all.
 */
type NonDurableTileType =
  | "browser-session"
  | "terminal"
  | "terminal-agent"
  | "managed-command-output"
  | "blank"
  | "comm-graph"
  | "pr-detail";

/**
 * Compile-time proof that {@link durableContentParts}' `default` branch really does only catch non-durable kinds.
 */
function assertNonDurableTileType(_type: NonDurableTileType): void {
  // Intentionally empty - the parameter type IS the assertion.
}

/**
 * The parts a DURABLY-keyed tile is addressed by, or `null` for a kind that is keyed per open instance (live) or not tracked at all.
 */
function durableContentParts(
  node: EpicCanvasTileRef,
): readonly string[] | null {
  switch (node.type) {
    // `node.type` rather than the "chat" literal the original spelled out: inside this branch they are the same string, and grouping the kinds that share a keying rule is what keeps this switch under the ceiling.
    case "chat":
    case "spec":
    case "ticket":
    case "story":
    case "review":
    case "git-diff":
    case "snapshot-diff":
      return [node.type, node.hostId, node.id];
    case "workspace-file":
      return [node.type, node.hostId, node.workspacePath, node.filePath];
    case "pr-diff":
      return [
        node.type,
        node.hostId,
        node.githubHost,
        node.owner,
        node.repo,
        String(node.prNumber),
      ];
    // Durable, and keyed WITHOUT the reading host - in the content key here AND in the record's own `hostId` (see `durableHostId`).
    // The content is a published copy addressed by its cloud identity triple, and which host piped the bytes down is incidental to it; keying on `hostId` like the live kinds do would drop the reader's scroll position every time another host served the reopen.
    case "published-chat":
      return [node.type, node.taskId, node.ownerUserId, node.chatId];
    default:
      assertNonDurableTileType(node.type);
      return null;
  }
}

function identityForTile(
  epicId: string,
  node: EpicCanvasTileRef,
): ReadingPositionIdentity | null {
  const contentParts = durableContentParts(node);
  if (contentParts !== null) {
    return durableIdentity({ node, epicId, contentParts });
  }
  switch (node.type) {
    case "terminal":
    case "terminal-agent":
    case "managed-command-output":
      return liveIdentity(node, epicId);
    default:
      return null;
  }
}

/** Resolve a live canvas tile centrally so surface components never assemble keys. */
export function readingPositionIdentityForTileInstance(
  instanceId: string,
): ReadingPositionIdentity {
  const state = useEpicCanvasStore.getState();
  for (const [tabId, canvas] of Object.entries(state.canvasByTabId)) {
    const node = canvas?.tilesByInstanceId[instanceId];
    if (node === undefined) continue;
    const epicId = state.tabsById[tabId]?.epicId;
    if (epicId === undefined) break;
    return identityForTile(epicId, node) ?? liveIdentity(node, epicId);
  }
  // Test harnesses and short pre-hydration gaps may not have a canvas record.
  // Keep their old renderer-local behavior without ever writing anonymous durable state.
  return {
    viewKey: instanceId,
    contentKey: null,
    deletionKey: null,
    epicId: null,
    hostId: null,
    durability: "renderer-live",
  };
}
