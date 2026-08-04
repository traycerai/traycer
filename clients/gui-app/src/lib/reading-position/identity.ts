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
    hostId: args.node.hostId,
    durability: "durable",
  };
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

function identityForTile(
  epicId: string,
  node: EpicCanvasTileRef,
): ReadingPositionIdentity | null {
  switch (node.type) {
    case "chat":
      return durableIdentity({
        node,
        epicId,
        contentParts: ["chat", node.hostId, node.id],
      });
    case "spec":
    case "ticket":
    case "story":
    case "review":
      return durableIdentity({
        node,
        epicId,
        contentParts: [node.type, node.hostId, node.id],
      });
    case "workspace-file":
      return durableIdentity({
        node,
        epicId,
        contentParts: [
          node.type,
          node.hostId,
          node.workspacePath,
          node.filePath,
        ],
      });
    case "git-diff":
    case "snapshot-diff":
      return durableIdentity({
        node,
        epicId,
        contentParts: [node.type, node.hostId, node.id],
      });
    case "pr-diff":
      return durableIdentity({
        node,
        epicId,
        contentParts: [
          node.type,
          node.hostId,
          node.githubHost,
          node.owner,
          node.repo,
          String(node.prNumber),
        ],
      });
    case "terminal":
    case "terminal-agent":
    case "managed-command-output":
      return liveIdentity(node, epicId);
    case "blank":
    case "comm-graph":
    case "pr-detail":
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
  // Keep their old renderer-local behavior without ever writing anonymous
  // durable state.
  return {
    viewKey: instanceId,
    contentKey: null,
    deletionKey: null,
    epicId: null,
    hostId: null,
    durability: "renderer-live",
  };
}
