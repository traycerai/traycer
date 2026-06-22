/**
 * Test shims that re-expose private slice projectors from
 * `projection-helpers.ts` so tests can call them without coupling to
 * the live `projectFullState` (which projects every slice at once).
 */
import * as Y from "yjs";
import {
  getArtifactsMap,
  getChatsMap,
  getTerminalAgentsMap,
  isChatVisibleToUser,
  isTerminalAgentVisibleToUser,
  projectArtifact,
  projectChat,
  projectTerminalAgent,
} from "@/stores/epics/open-epic/projection-helpers";
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
