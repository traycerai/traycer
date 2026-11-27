import type { CloudChatSummary } from "@traycer/protocol/host/epic/cloud-chat";
import type { TreeNode } from "@/stores/epics/open-epic/types";
import type { EpicTreeIndex } from "@/lib/epic-selectors";
import {
  cloudChatRowKey,
  localChatRowKey,
  type UnifiedChatEntry,
  type UnifiedCloudChatEntry,
  type UnifiedLocalChatEntry,
} from "@/lib/chats/unified-chat-list";
import type { FlattenChatTreeRowsInput } from "@/components/epic-canvas/sidebar/chat-tree-rows";

/** Pure fixtures for the row model: a tree index, list entries and flatten input. */

const TASK = "task-1";
const OWNER = "user-1";

export interface NodeSpec {
  readonly id: string;
  readonly parentId: string | null;
  /** Newer sorts first under the default sort. */
  readonly updatedAt: number;
  readonly type: TreeNode["type"];
}

export function chatNode(
  id: string,
  parentId: string | null,
  updatedAt: number,
): NodeSpec {
  return { id, parentId, updatedAt, type: "chat" };
}

export function treeOf(specs: readonly NodeSpec[]): EpicTreeIndex {
  const nodeById: Record<string, TreeNode> = {};
  const childrenByParent: Record<string, string[]> = {};
  const rootIds: string[] = [];
  for (const spec of specs) {
    nodeById[spec.id] = {
      id: spec.id,
      parentId: spec.parentId,
      title: `Title ${spec.id}`,
      type: spec.type,
      status: null,
      createdAt: 1,
      updatedAt: spec.updatedAt,
    };
    if (spec.parentId === null) rootIds.push(spec.id);
    else (childrenByParent[spec.parentId] ??= []).push(spec.id);
  }
  return { rootIds, childrenByParent, nodeById };
}

export function localEntry(nodeId: string): UnifiedLocalChatEntry {
  return { kind: "local", key: localChatRowKey(nodeId), nodeId };
}

export function cloudSummary(
  chatId: string,
  parentChatId: string | null,
  title: string,
): CloudChatSummary {
  return {
    identity: { taskId: TASK, chatId, ownerUserId: OWNER },
    ownerHostId: "host-b",
    createdAt: 100,
    visibility: "task",
    title,
    isTitleEditedByUser: false,
    parentChatId,
    isArchived: false,
    runSettingsSummary: null,
    metadataUpdatedAt: 300,
    headSha256: null,
    publishedAt: 300,
    throughRecordSeq: null,
    isOwnedByViewer: true,
  };
}

export function cloudEntry(
  chat: CloudChatSummary,
  children: readonly UnifiedCloudChatEntry[],
): UnifiedCloudChatEntry {
  return {
    kind: "cloud",
    key: cloudChatRowKey(chat.identity),
    chat,
    children,
  };
}

const NO_NODES: EpicTreeIndex = {
  rootIds: [],
  childrenByParent: {},
  nodeById: {},
};

export function flattenInput(
  overrides: Partial<FlattenChatTreeRowsInput>,
): FlattenChatTreeRowsInput {
  return {
    listEntries: [] as readonly UnifiedChatEntry[],
    pendingRoots: [],
    tree: NO_NODES,
    expandedIds: new Set<string>(),
    visibleIds: null,
    treeFilter: () => true,
    comparator: null,
    clock: null,
    ...overrides,
  };
}
