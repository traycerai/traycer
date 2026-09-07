import * as Y from "yjs";
import { v4 as uuidv4 } from "uuid";
import {
  ensureMap,
  getArtifactsMap,
  getChatsMap,
  getEpicMap,
  getTerminalAgentsMap,
  isChatVisibleToUser,
  isTerminalAgentVisibleToUser,
  NEW_ARTIFACT_TITLES,
  projectArtifact,
  projectChat,
  projectTerminalAgent,
  type AddableArtifactType,
} from "@/stores/epics/open-epic/projection-helpers";
import { LOCAL_ORIGIN } from "@/stores/epics/open-epic/store";
import type {
  ArtifactProjection,
  ArtifactsSlice,
  ChatProjection,
  ChatsSlice,
  TuiAgentProjection,
  TerminalAgentsSlice,
} from "@/stores/epics/open-epic/types";
import { EMPTY_ARRAY } from "@/stores/epics/open-epic/types";

export function projectArtifactsSliceForTests(doc: Y.Doc): ArtifactsSlice {
  const map = getArtifactsMap(doc);
  if (map === null) return { byId: {}, allIds: EMPTY_ARRAY };
  const byId: Record<string, ArtifactProjection> = {};
  const allIds: string[] = [];
  for (const [id, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const projected = projectArtifact(id, entry as Y.Map<unknown>);
    if (projected === null) continue;
    byId[id] = projected;
    allIds.push(id);
  }
  return { byId, allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds };
}

export function projectChatsSliceForTests(
  doc: Y.Doc,
  currentUserId: string | null,
): ChatsSlice {
  const map = getChatsMap(doc);
  if (map === null) return { byId: {}, allIds: EMPTY_ARRAY };
  const byId: Record<string, ChatProjection> = {};
  const allIds: string[] = [];
  for (const [id, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const projected = projectChat(id, entry as Y.Map<unknown>);
    if (!isChatVisibleToUser(projected.userId, currentUserId)) continue;
    byId[id] = projected;
    allIds.push(id);
  }
  return { byId, allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds };
}

/**
 * Seeds a metadata-only artifact or chat entry directly into the doc, standing in for the
 * host-side `epic.createArtifact` / `epic.createChat` writes.
 */
export function createArtifactInDocForTests(
  doc: Y.Doc,
  type: AddableArtifactType,
  parentId: string | null,
): string {
  const id = uuidv4();
  const now = Date.now();
  const title = NEW_ARTIFACT_TITLES[type];
  doc.transact(() => {
    const epic = getEpicMap(doc);
    if (type === "chat") {
      const chats = ensureMap(epic, "chats");
      const entry = new Y.Map<unknown>();
      entry.set("id", id);
      entry.set("title", title);
      entry.set("parentId", parentId);
      entry.set("createdAt", now);
      entry.set("updatedAt", now);
      entry.set("messages", new Y.Array());
      chats.set(id, entry);
      return;
    }
    const artifacts = ensureMap(epic, "artifacts");
    const entry = new Y.Map<unknown>();
    entry.set("id", id);
    entry.set("kind", type);
    entry.set("title", title);
    entry.set("parentId", parentId);
    entry.set("createdAt", now);
    entry.set("updatedAt", now);
    artifacts.set(id, entry);
  }, LOCAL_ORIGIN);
  return id;
}

export function projectTerminalAgentsSliceForTests(
  doc: Y.Doc,
  currentUserId: string | null,
): TerminalAgentsSlice {
  const map = getTerminalAgentsMap(doc);
  if (map === null) return { byId: {}, allIds: EMPTY_ARRAY };
  const byId: Record<string, TuiAgentProjection> = {};
  const allIds: string[] = [];
  for (const [id, entry] of map.entries()) {
    if (!(entry instanceof Y.Map)) continue;
    const projected = projectTerminalAgent(id, entry as Y.Map<unknown>);
    if (projected === null) continue;
    if (!isTerminalAgentVisibleToUser(projected.userId, currentUserId)) {
      continue;
    }
    byId[id] = projected;
    allIds.push(id);
  }
  return { byId, allIds: allIds.length === 0 ? EMPTY_ARRAY : allIds };
}
