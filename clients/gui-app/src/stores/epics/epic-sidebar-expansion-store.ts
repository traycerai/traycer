/**
 * Per-tab, per-panel left-panel tree expansion. Hoisted out of panel body
 * local state so expansion survives panel remount (header tab switches,
 * epic navigation).
 *
 * Scope: state is keyed by `(tabId, panelId)`, NOT `tabId` alone. The chats
 * and artifacts panels render under the same tab but are independent trees;
 * keying by tab alone made "Collapse all" in one panel wipe the other's
 * expansions (it cleared the whole tab's expanded set) and let one panel's
 * overrides seed the other's effective set. Each panel now owns its own
 * scope.
 *
 * Derivation model: the store records only USER overrides - explicit
 * expansions beyond the implicit set, and explicit collapses overriding
 * the implicit set. The implicit set (root ids + ancestors of the
 * focused artifact) is computed at read time by the consumer. This
 * avoids cross-store render-time writes that would otherwise trip
 * React's "setState during render" guard whenever multiple
 * left-panel instances were mounted concurrently.
 *
 * Not persisted: transient UI state. If we ever want expansion to
 * survive app restart, wrap with `persist` middleware.
 */
import { useMemo } from "react";
import { create } from "zustand";
import {
  withMemberAdded,
  withMemberRemoved,
  withMembersAdded,
} from "@/lib/immutable-set";
import type { RootCreatePanelId } from "@/stores/epics/left-panel-store";

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

const SCOPE_SEPARATOR = "::";

// tabIds are uuids and panelIds are fixed slugs, so this separator never
// collides. `tabScopePrefix` is what `copyTabState` matches to move every
// panel scope belonging to a tab.
function scopeKey(tabId: string, panelId: RootCreatePanelId): string {
  return `${tabId}${SCOPE_SEPARATOR}${panelId}`;
}

function tabScopePrefix(tabId: string): string {
  return `${tabId}${SCOPE_SEPARATOR}`;
}

interface EpicSidebarExpansionStore {
  readonly userExpandedByScope: Readonly<Record<string, ReadonlySet<string>>>;
  readonly userCollapsedByScope: Readonly<Record<string, ReadonlySet<string>>>;

  readonly expand: (
    tabId: string,
    panelId: RootCreatePanelId,
    nodeId: string,
  ) => void;
  readonly collapse: (
    tabId: string,
    panelId: RootCreatePanelId,
    nodeId: string,
  ) => void;
  readonly collapseAll: (
    tabId: string,
    panelId: RootCreatePanelId,
    currentlyExpanded: ReadonlySet<string>,
  ) => void;
  readonly copyTabState: (sourceTabId: string, targetTabId: string) => void;
}

function patchExpanded(
  state: EpicSidebarExpansionStore,
  key: string,
  next: ReadonlySet<string>,
): Partial<EpicSidebarExpansionStore> {
  const current = state.userExpandedByScope[key] ?? EMPTY_SET;
  if (current === next) return {};
  return {
    userExpandedByScope: { ...state.userExpandedByScope, [key]: next },
  };
}

function patchCollapsed(
  state: EpicSidebarExpansionStore,
  key: string,
  next: ReadonlySet<string>,
): Partial<EpicSidebarExpansionStore> {
  const current = state.userCollapsedByScope[key] ?? EMPTY_SET;
  if (current === next) return {};
  return {
    userCollapsedByScope: { ...state.userCollapsedByScope, [key]: next },
  };
}

function copySet(set: ReadonlySet<string>): ReadonlySet<string> {
  return set.size === 0 ? EMPTY_SET : new Set(set);
}

// Remap every `${sourceTabId}::<panel>` scope onto `${targetTabId}::<panel>`,
// leaving unrelated tabs untouched. Returns the same reference when nothing
// for the source tab exists so callers can skip a no-op set.
function remapTabScopes(
  byScope: Readonly<Record<string, ReadonlySet<string>>>,
  sourceTabId: string,
  targetTabId: string,
): Readonly<Record<string, ReadonlySet<string>>> {
  const prefix = tabScopePrefix(sourceTabId);
  const sourceEntries = Object.entries(byScope).filter(([key]) =>
    key.startsWith(prefix),
  );
  if (sourceEntries.length === 0) return byScope;
  const next = { ...byScope };
  for (const [key, value] of sourceEntries) {
    const panelId = key.slice(prefix.length);
    next[`${targetTabId}${SCOPE_SEPARATOR}${panelId}`] = copySet(value);
  }
  return next;
}

export const useEpicSidebarExpansionStore = create<EpicSidebarExpansionStore>(
  (set) => ({
    userExpandedByScope: {},
    userCollapsedByScope: {},

    expand: (tabId, panelId, nodeId) => {
      set((state) => {
        const key = scopeKey(tabId, panelId);
        const expanded = state.userExpandedByScope[key] ?? EMPTY_SET;
        const collapsed = state.userCollapsedByScope[key] ?? EMPTY_SET;
        return {
          ...patchExpanded(state, key, withMemberAdded(expanded, nodeId)),
          ...patchCollapsed(state, key, withMemberRemoved(collapsed, nodeId)),
        };
      });
    },

    collapse: (tabId, panelId, nodeId) => {
      set((state) => {
        const key = scopeKey(tabId, panelId);
        const expanded = state.userExpandedByScope[key] ?? EMPTY_SET;
        const collapsed = state.userCollapsedByScope[key] ?? EMPTY_SET;
        return {
          ...patchExpanded(state, key, withMemberRemoved(expanded, nodeId)),
          ...patchCollapsed(state, key, withMemberAdded(collapsed, nodeId)),
        };
      });
    },

    collapseAll: (tabId, panelId, currentlyExpanded) => {
      set((state) => {
        const key = scopeKey(tabId, panelId);
        const collapsed = state.userCollapsedByScope[key] ?? EMPTY_SET;
        return {
          ...patchExpanded(state, key, EMPTY_SET),
          ...patchCollapsed(
            state,
            key,
            withMembersAdded(collapsed, currentlyExpanded),
          ),
        };
      });
    },

    copyTabState: (sourceTabId, targetTabId) => {
      if (sourceTabId === targetTabId) return;
      set((state) => {
        const userExpandedByScope = remapTabScopes(
          state.userExpandedByScope,
          sourceTabId,
          targetTabId,
        );
        const userCollapsedByScope = remapTabScopes(
          state.userCollapsedByScope,
          sourceTabId,
          targetTabId,
        );
        if (
          userExpandedByScope === state.userExpandedByScope &&
          userCollapsedByScope === state.userCollapsedByScope
        ) {
          return state;
        }
        return { userExpandedByScope, userCollapsedByScope };
      });
    },
  }),
);
function useEpicSidebarUserExpanded(
  tabId: string,
  panelId: RootCreatePanelId,
): ReadonlySet<string> {
  return useEpicSidebarExpansionStore(
    (s) => s.userExpandedByScope[scopeKey(tabId, panelId)] ?? EMPTY_SET,
  );
}
function useEpicSidebarUserCollapsed(
  tabId: string,
  panelId: RootCreatePanelId,
): ReadonlySet<string> {
  return useEpicSidebarExpansionStore(
    (s) => s.userCollapsedByScope[scopeKey(tabId, panelId)] ?? EMPTY_SET,
  );
}

/**
 * Derive the effective expanded-id set: implicit roots + active-artifact
 * ancestors, merged with user-driven explicit expansions, minus user
 * collapses. Pure derivation - no store writes happen during render.
 */
export function useEpicSidebarEffectiveExpanded(
  tabId: string,
  panelId: RootCreatePanelId,
  rootIds: readonly string[],
  ancestorIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const userExpanded = useEpicSidebarUserExpanded(tabId, panelId);
  const userCollapsed = useEpicSidebarUserCollapsed(tabId, panelId);
  // Memoize the derived Set on its inputs. Without this, `deriveEffectiveExpanded`
  // allocates a fresh `Set` on every render, so the expansion controller built
  // from it gets a new identity every render and defeats memoized tree nodes.
  return useMemo(
    () =>
      deriveEffectiveExpanded(
        userExpanded,
        userCollapsed,
        rootIds,
        ancestorIds,
      ),
    [userExpanded, userCollapsed, rootIds, ancestorIds],
  );
}
function deriveEffectiveExpanded(
  userExpanded: ReadonlySet<string>,
  userCollapsed: ReadonlySet<string>,
  rootIds: readonly string[],
  ancestorIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const result = new Set<string>(userExpanded);
  for (const id of rootIds) result.add(id);
  for (const id of ancestorIds) result.add(id);
  for (const id of userCollapsed) result.delete(id);
  return result;
}
