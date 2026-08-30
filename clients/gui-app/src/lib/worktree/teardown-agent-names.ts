import { useMemo, useSyncExternalStore } from "react";
import type { WorktreeBusyHolder } from "@traycer/protocol/framework/worktree-busy-holders";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";

const EMPTY_NAMES: ReadonlyMap<string, string> = new Map();

/**
 * Resolves holder `ownerRef`s to the live chat / terminal-agent titles the
 * GUI already shows in the tab strip. Open epic sessions are the source;
 * unnamed owners stay absent so the formatter falls back to "This agent"
 * instead of a hold-kind label.
 *
 * Subscribes to the registry AND each open epic's session store so a rename
 * under an open dialog updates the actor row. `registry.size()` alone misses
 * title changes in an already-open epic.
 */
export function useTeardownAgentNames(
  holders: readonly WorktreeBusyHolder[],
): ReadonlyMap<string, string> {
  const titlesRevision = useSyncExternalStore(
    (listener) => subscribeTeardownAgentNames(holders, listener),
    () => teardownAgentNamesSnapshot(holders),
  );
  return useMemo(() => {
    void titlesRevision;
    return collectTeardownAgentNames(holders);
  }, [holders, titlesRevision]);
}

function subscribeTeardownAgentNames(
  holders: readonly WorktreeBusyHolder[],
  listener: () => void,
): () => void {
  const registry = getOpenEpicRegistry();
  const unsubs: Array<() => void> = [registry.subscribe(listener)];
  const seen = new Set<string>();
  for (const holder of holders) {
    const epicId = holder.ownerRef.epicId;
    if (seen.has(epicId)) continue;
    seen.add(epicId);
    const handle = registry.peek(epicId);
    if (handle === null) continue;
    const subscribe = handle.store.subscribe;
    if (typeof subscribe === "function") {
      unsubs.push(subscribe.call(handle.store, listener));
    }
  }
  return () => {
    for (const unsub of unsubs) unsub();
  };
}

function teardownAgentNamesSnapshot(
  holders: readonly WorktreeBusyHolder[],
): string {
  const names = collectTeardownAgentNames(holders);
  return [...names.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, title]) => `${key}\u0000${title}`)
    .join("\u0001");
}

export function collectTeardownAgentNames(
  holders: readonly WorktreeBusyHolder[],
): ReadonlyMap<string, string> {
  if (holders.length === 0) return EMPTY_NAMES;
  const names = new Map<string, string>();
  const registry = getOpenEpicRegistry();
  const seenEpics = new Set<string>();
  for (const holder of holders) {
    const epicId = holder.ownerRef.epicId;
    if (seenEpics.has(epicId)) continue;
    seenEpics.add(epicId);
    const handle = registry.peek(epicId);
    if (handle === null) continue;
    const state = handle.store.getState();
    for (const chatId of state.chats.allIds) {
      const chat = Object.hasOwn(state.chats.byId, chatId)
        ? state.chats.byId[chatId]
        : undefined;
      if (chat === undefined || chat.title.length === 0) continue;
      names.set(`chat:${chat.id}`, chat.title);
    }
    for (const agentId of state.tuiAgents.allIds) {
      const agent = Object.hasOwn(state.tuiAgents.byId, agentId)
        ? state.tuiAgents.byId[agentId]
        : undefined;
      if (agent === undefined || agent.title.length === 0) continue;
      names.set(`terminal-agent:${agent.id}`, agent.title);
    }
  }
  return names.size === 0 ? EMPTY_NAMES : names;
}
