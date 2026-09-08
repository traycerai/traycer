import { useMemo, useSyncExternalStore } from "react";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import type { OpenEpicSessionRegistry } from "@/stores/epics/open-epic/session-registry";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import { liveEpicTitleFromHandle } from "@/lib/epic-selectors";
import {
  focusAgentKey,
  type FocusAgentIdentity,
} from "@/lib/home-focus/focus-tasks";

export interface MountedEpicRef {
  readonly epicId: string;
  /** The working agent ids to resolve in that epic. Ids the epic's projection
   * does not know are simply unresolved. */
  readonly agentIds: ReadonlyArray<string>;
}

export interface MountedEpicProjection {
  /** Epics with a live Y.Doc projection in THIS window. */
  readonly mountedEpicIds: ReadonlySet<string>;
  /** Epic id → live title, for mounted epics that have one. */
  readonly liveTitles: ReadonlyMap<string, string>;
  /** {@link focusAgentKey} → identity, for mounted epics only. */
  readonly agentIdentities: ReadonlyMap<string, FocusAgentIdentity>;
}

const EMPTY_PROJECTION: MountedEpicProjection = {
  mountedEpicIds: new Set<string>(),
  liveTitles: new Map<string, string>(),
  agentIdentities: new Map<string, FocusAgentIdentity>(),
};

/**
 * Names, parentage and mounted-ness for a DYNAMIC set of epics and agents,
 * read from this window's open-epic projections.
 *
 * ONE subscription for the whole set, not a hook per epic, and that is a
 * correctness requirement rather than an optimization: Home's epic list is the
 * activity union, whose size changes as agents start and stop, so a loop of
 * per-epic hooks would change React's hook count between renders. The shape is
 * the one `useRegisteredEpicLiveAgents` already uses for the same reason -
 * subscribe once to the registry and to every currently referenced handle, and
 * publish an ENCODED snapshot so `useSyncExternalStore` compares by value. The
 * registry and every epic store notify on changes that touch none of these
 * fields; a fresh object per notification would re-render the whole page each
 * time.
 *
 * A mounted epic's title is its live Y.Doc title, which is why it is kept apart
 * from the cloud-indexed titles the caller merges it into: a rename shows here
 * immediately, while the cloud index is a cache.
 */
export function useMountedEpicProjection(
  refs: ReadonlyArray<MountedEpicRef>,
): MountedEpicProjection {
  const registry = getOpenEpicRegistry();
  const encoded = useSyncExternalStore(
    (listener) => {
      const unsubscribeByHandle = new Map<OpenEpicStoreHandle, () => void>();
      const reconcileHandleSubscriptions = (): void => {
        const currentHandles = new Set<OpenEpicStoreHandle>();
        for (const ref of refs) {
          const handle = registry.peek(ref.epicId);
          if (handle === null || currentHandles.has(handle)) continue;
          currentHandles.add(handle);
          if (!unsubscribeByHandle.has(handle)) {
            unsubscribeByHandle.set(handle, handle.store.subscribe(listener));
          }
        }
        for (const [handle, unsubscribe] of unsubscribeByHandle) {
          if (currentHandles.has(handle)) continue;
          unsubscribe();
          unsubscribeByHandle.delete(handle);
        }
      };
      reconcileHandleSubscriptions();
      const unsubscribeRegistry = registry.subscribe(() => {
        reconcileHandleSubscriptions();
        listener();
      });
      return () => {
        unsubscribeRegistry();
        for (const unsubscribe of unsubscribeByHandle.values()) unsubscribe();
      };
    },
    () => projectionSnapshot(registry, refs),
    () => EMPTY_SNAPSHOT,
  );
  return useMemo(() => decodeProjection(encoded, refs), [encoded, refs]);
}

const EMPTY_SNAPSHOT = "[]";

/**
 * Per-ref tuples of `[title, [[kind, title, parentId, hostId] | null, ...]]`,
 * or `null`
 * for an epic this window has not mounted. JSON rather than a structural
 * comparator because `useSyncExternalStore` compares snapshots with `===` and
 * this is the cheapest value identity that survives it.
 */
function projectionSnapshot(
  registry: OpenEpicSessionRegistry,
  refs: ReadonlyArray<MountedEpicRef>,
): string {
  return JSON.stringify(
    refs.map((ref) => {
      const handle = registry.peek(ref.epicId);
      if (handle === null) return null;
      return [
        liveEpicTitleFromHandle(handle),
        ref.agentIds.map((agentId) => liveAgentIdentity(handle, agentId)),
      ];
    }),
  );
}

function liveAgentIdentity(
  handle: OpenEpicStoreHandle,
  agentId: string,
): readonly [string, string, string | null, string | null] | null {
  const state = handle.store.getState();
  if (Object.hasOwn(state.chats.byId, agentId)) {
    const chat = state.chats.byId[agentId];
    return ["chat", chat.title, chat.parentId, chat.hostId];
  }
  if (Object.hasOwn(state.tuiAgents.byId, agentId)) {
    const agent = state.tuiAgents.byId[agentId];
    return ["terminal-agent", agent.title, agent.parentId, agent.hostId];
  }
  return null;
}

function decodeProjection(
  encoded: string,
  refs: ReadonlyArray<MountedEpicRef>,
): MountedEpicProjection {
  const decoded: unknown = JSON.parse(encoded);
  if (!Array.isArray(decoded)) return EMPTY_PROJECTION;
  const mountedEpicIds = new Set<string>();
  const liveTitles = new Map<string, string>();
  const agentIdentities = new Map<string, FocusAgentIdentity>();
  refs.forEach((ref, index) => {
    const entry: unknown = decoded[index];
    if (!Array.isArray(entry)) return;
    mountedEpicIds.add(ref.epicId);
    const title: unknown = entry[0];
    if (typeof title === "string" && title.length > 0) {
      liveTitles.set(ref.epicId, title);
    }
    const agents: unknown = entry[1];
    if (!Array.isArray(agents)) return;
    ref.agentIds.forEach((agentId, agentIndex) => {
      const identity = decodeAgentIdentity(agents[agentIndex]);
      if (identity === null) return;
      agentIdentities.set(focusAgentKey(ref.epicId, agentId), identity);
    });
  });
  return { mountedEpicIds, liveTitles, agentIdentities };
}

function decodeAgentIdentity(entry: unknown): FocusAgentIdentity | null {
  if (!Array.isArray(entry)) return null;
  const surface: unknown = entry[0];
  const title: unknown = entry[1];
  const parentId: unknown = entry[2];
  const hostId: unknown = entry[3];
  if (surface !== "chat" && surface !== "terminal-agent") return null;
  return {
    surface,
    title: typeof title === "string" && title.length > 0 ? title : null,
    parentId: typeof parentId === "string" ? parentId : null,
    hostId: typeof hostId === "string" && hostId.length > 0 ? hostId : null,
  };
}
