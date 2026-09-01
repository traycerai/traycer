import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HISTORY_SEARCH,
  type HistorySearchState,
} from "@/lib/history-search";
import { useHistorySearchStore } from "@/stores/home/history-search-store";

// Hand-transcribed from `HISTORY_SEARCH_PERSIST_KEY` in
// `history-search-store.ts` (`persistKey(STORE_KEYS.historySearch)`), not
// derived from the builder - a divergence must fail HERE rather than pass a
// circular comparison against itself (see `src/lib/persist/__tests__/keys.test.ts`).
const HISTORY_SEARCH_PERSIST_KEY = "traycer-gui-app:history-search";

describe("useHistorySearchStore persisted-state rehydration", () => {
  beforeEach(() => {
    window.localStorage.clear();
    useHistorySearchStore.setState({ search: DEFAULT_HISTORY_SEARCH });
  });

  it("fills in chatHosts/chatHostMode missing from a pre-#1303 persisted payload while preserving the fields it did carry", async () => {
    window.localStorage.setItem(
      HISTORY_SEARCH_PERSIST_KEY,
      JSON.stringify({
        state: {
          search: {
            query: "auth",
            repos: ["traycerai/traycer"],
            repoMode: "any",
            workspaces: [],
            workspaceMode: "any",
            ownershipScopes: ["mine"],
            sort: "oldest",
            sortExplicit: true,
          },
        },
        version: 1,
      }),
    );

    // The former crash site: rehydrating pre-#1303 state must not leave
    // `chatHosts` undefined for the renderer's `.length` read.
    await useHistorySearchStore.persist.rehydrate();

    const search = useHistorySearchStore.getState().search;
    expect(search.chatHosts).toEqual([]);
    expect(search.chatHostMode).toBe("any");
    // Fields the older build DID persist must survive the normalization,
    // not silently fall back to defaults alongside the missing ones.
    expect(search.query).toBe("auth");
    expect(search.repos).toEqual(["traycerai/traycer"]);
    expect(search.repoMode).toBe("any");
    expect(search.workspaces).toEqual([]);
    expect(search.workspaceMode).toBe("any");
    expect(search.ownershipScopes).toEqual(["mine"]);
    expect(search.sort).toBe("oldest");
    expect(search.sortExplicit).toBe(true);
  });

  it("falls back to DEFAULT_HISTORY_SEARCH for a corrupted (non-object) persisted `search` instead of throwing", async () => {
    window.localStorage.setItem(
      HISTORY_SEARCH_PERSIST_KEY,
      JSON.stringify({ state: { search: "garbage" }, version: 1 }),
    );

    // Rehydration must complete without throwing, unlike the old verbatim
    // shallow merge, which handed a string to every `HistorySearchState` reader.
    await useHistorySearchStore.persist.rehydrate();

    expect(useHistorySearchStore.getState().search).toEqual(
      DEFAULT_HISTORY_SEARCH,
    );
  });

  it("round-trips a current-shape persisted state, including chatHosts/chatHostMode, unchanged", async () => {
    const persistedSearch: HistorySearchState = {
      query: "bug",
      repos: ["traycerai/traycer"],
      repoMode: "all",
      workspaces: [{ hostId: "host-a", workspacePath: "/tmp/ws" }],
      workspaceMode: "any",
      chatHosts: ["host-a", "host-b"],
      chatHostMode: "all",
      ownershipScopes: ["mine", "shared"],
      sort: "title-asc",
      sortExplicit: true,
    };
    window.localStorage.setItem(
      HISTORY_SEARCH_PERSIST_KEY,
      JSON.stringify({ state: { search: persistedSearch }, version: 1 }),
    );

    await useHistorySearchStore.persist.rehydrate();

    expect(useHistorySearchStore.getState().search).toEqual(persistedSearch);
  });
});
