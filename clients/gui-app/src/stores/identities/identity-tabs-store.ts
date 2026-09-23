/**
 * The open Identities tabs: the SOURCE records the `identity` tab kind
 * projects from, as the epic canvas store is for `epic` tabs and the landing
 * draft store for `draft` tabs.
 *
 * One record per open identity, keyed by the identity id, and bound to a host
 * for life: an identity is an account-wide object, but the tab's session is a
 * set of sockets to one host (`open-identity/session-registry.ts`), and the
 * repo's rule is clone-not-migrate. Opening the same identity on a different
 * host is deliberately NOT modelled - the record's host wins and the caller's
 * is ignored - because two tabs for one identity would need two tab ids for
 * one route, and the route is what a deep link has to resolve.
 *
 * Persisted like the tabs store, so a restored strip can re-project its
 * identity tabs; `tabSourceRefs()` prunes any strip ref this store no longer
 * holds.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";

export interface IdentityTab {
  /** The tab id, which IS the identity id. */
  readonly id: string;
  readonly identityId: string;
  /** The host this tab is bound to for life. */
  readonly hostId: string;
  /** Last known title, for the strip before the session's index snapshot lands. */
  readonly title: string;
}

export interface OpenIdentityTabInput {
  readonly identityId: string;
  readonly hostId: string;
  readonly title: string;
}

interface IdentityTabsState {
  readonly tabsById: Readonly<Record<string, IdentityTab | undefined>>;
  readonly openTabOrder: readonly string[];
  readonly activeTabId: string | null;
  /**
   * Open (or refresh the title of) the tab for `identityId`. Idempotent: an
   * existing record keeps its host and its place in the order.
   */
  openTab: (input: OpenIdentityTabInput) => void;
  closeTab: (id: string) => void;
  setActiveTab: (id: string) => void;
  clearActiveTab: () => void;
  setTitle: (id: string, title: string) => void;
}

export const IDENTITY_TABS_PERSIST_KEY = persistKey(STORE_KEYS.identityTabs);

interface PersistedIdentityTabsState {
  readonly tabsById: Readonly<Record<string, IdentityTab | undefined>>;
  readonly openTabOrder: readonly string[];
}

export const useIdentityTabsStore = create<IdentityTabsState>()(
  persist(
    (set) => ({
      tabsById: {},
      openTabOrder: [],
      activeTabId: null,

      openTab: ({ identityId, hostId, title }) => {
        set((state) => {
          const existing = state.tabsById[identityId];
          if (existing !== undefined) {
            if (existing.title === title) return state;
            return {
              tabsById: {
                ...state.tabsById,
                [identityId]: { ...existing, title },
              },
            };
          }
          return {
            tabsById: {
              ...state.tabsById,
              [identityId]: { id: identityId, identityId, hostId, title },
            },
            openTabOrder: [...state.openTabOrder, identityId],
          };
        });
      },

      closeTab: (id) => {
        set((state) => {
          if (state.tabsById[id] === undefined) return state;
          const { [id]: _removed, ...tabsById } = state.tabsById;
          return {
            tabsById,
            openTabOrder: state.openTabOrder.filter((held) => held !== id),
            activeTabId: state.activeTabId === id ? null : state.activeTabId,
          };
        });
      },

      setActiveTab: (id) => {
        set((state) =>
          state.tabsById[id] === undefined || state.activeTabId === id
            ? state
            : { activeTabId: id },
        );
      },

      clearActiveTab: () => {
        set((state) =>
          state.activeTabId === null ? state : { activeTabId: null },
        );
      },

      setTitle: (id, title) => {
        set((state) => {
          const existing = state.tabsById[id];
          if (existing === undefined || existing.title === title) return state;
          return {
            tabsById: { ...state.tabsById, [id]: { ...existing, title } },
          };
        });
      },
    }),
    {
      ...basePersistOptions(IDENTITY_TABS_PERSIST_KEY),
      partialize: (state): PersistedIdentityTabsState => ({
        tabsById: state.tabsById,
        openTabOrder: state.openTabOrder,
      }),
    },
  ),
);

export function isOpenIdentityTab(id: string): boolean {
  return useIdentityTabsStore.getState().tabsById[id] !== undefined;
}

export function resetIdentityTabsStoreForTests(): void {
  useIdentityTabsStore.setState({
    tabsById: {},
    openTabOrder: [],
    activeTabId: null,
  });
}
