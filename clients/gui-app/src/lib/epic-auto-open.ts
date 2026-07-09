import { buildEpicNodeTree } from "@/lib/artifacts/node-display";
import type { EpicNodeKind } from "@/lib/artifacts/node-display";
import type { TreeNodeNested } from "@/lib/tree-types";
import { isOpenableEpicNodeKind } from "@/stores/epics/canvas/types";

export interface AutoOpenRecord {
  readonly id: string;
  readonly parentId: string | null;
  readonly name: string;
  readonly type: EpicNodeKind;
  readonly hostId: string;
}

interface AutoOpenTarget {
  readonly id: string;
  readonly type:
    "chat" | "terminal-agent" | "spec" | "ticket" | "story" | "review";
  readonly name: string;
  readonly hostId: string;
}

// Plain terminals are renderer-only and never live in the cloud-backed records
// auto-open consumes, so they stay excluded. Terminal-agents (TUI agents) ARE
// record-backed and openable, so focusing one - e.g. from the resource monitor -
// must resolve to that agent rather than falling back to an arbitrary chat.
function isAutoOpenableKind(
  type: EpicNodeKind,
): type is AutoOpenTarget["type"] {
  return (
    type === "chat" ||
    type === "terminal-agent" ||
    type === "spec" ||
    type === "ticket" ||
    type === "story" ||
    type === "review"
  );
}

export function resolveAutoOpenTarget(
  records: ReadonlyArray<AutoOpenRecord>,
  focusArtifactId: string | null,
  persistedFocus: string | null,
): AutoOpenTarget | null {
  const focusMatch = findOpenableRecord(records, focusArtifactId);
  if (focusMatch !== null) return focusMatch;

  const persistedMatch = findOpenableRecord(records, persistedFocus);
  if (persistedMatch !== null) return persistedMatch;

  return findFirstOpenableInTree(records);
}

function findOpenableRecord(
  records: ReadonlyArray<AutoOpenRecord>,
  artifactId: string | null,
): AutoOpenTarget | null {
  if (artifactId === null) return null;
  const match = records.find((record) => record.id === artifactId);
  if (match === undefined) return null;
  if (!isOpenableEpicNodeKind(match.type)) return null;
  if (!isAutoOpenableKind(match.type)) return null;
  return {
    id: match.id,
    type: match.type,
    name: match.name,
    hostId: match.hostId,
  };
}

function findFirstOpenableInTree(
  records: ReadonlyArray<AutoOpenRecord>,
): AutoOpenTarget | null {
  const tree = buildEpicNodeTree(records);
  return walkTree(tree);
}

function walkTree(
  nodes: ReadonlyArray<
    TreeNodeNested<{
      readonly name: string;
      readonly type: AutoOpenRecord["type"];
      readonly hostId: string;
    }>
  >,
): AutoOpenTarget | null {
  for (const node of nodes) {
    const nodeType = node.data.type;
    if (isOpenableEpicNodeKind(nodeType) && isAutoOpenableKind(nodeType)) {
      return {
        id: node.id,
        type: nodeType,
        name: node.data.name,
        hostId: node.data.hostId,
      };
    }
    const nested = node.children ?? [];
    if (nested.length === 0) continue;
    const childMatch = walkTree(nested);
    if (childMatch !== null) return childMatch;
  }
  return null;
}
