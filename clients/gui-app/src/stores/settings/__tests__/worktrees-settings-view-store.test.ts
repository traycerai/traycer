import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_PERSIST_VERSION, STORE_KEYS, persistKey } from "@/lib/persist";
import {
  DEFAULT_WORKTREE_SORT_MODE,
  EMPTY_WORKTREE_TIER_FILTERS,
  useWorktreesSettingsViewStore,
} from "@/stores/settings/worktrees-settings-view-store";

const PERSIST_KEY = persistKey(STORE_KEYS.worktreesSettingsView);

function resetStore(): void {
  window.localStorage.clear();
  useWorktreesSettingsViewStore.setState({
    searchText: "",
    sortMode: DEFAULT_WORKTREE_SORT_MODE,
    tierFilters: EMPTY_WORKTREE_TIER_FILTERS,
  });
}

describe("useWorktreesSettingsViewStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("persists search, selected tiers, and sort order", async () => {
    const store = useWorktreesSettingsViewStore.getState();
    store.setSearchText("payments");
    store.toggleTierFilter("merged");
    store.toggleTierFilter("at-base-commit");
    store.setSortMode("oldest");

    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(
      JSON.parse(window.localStorage.getItem(PERSIST_KEY) ?? "{}"),
    ).toEqual({
      state: {
        searchText: "payments",
        sortMode: "oldest",
        tierFilters: ["merged", "at-base-commit"],
      },
      version: CURRENT_PERSIST_VERSION,
    });
  });

  it("rehydrates the saved view", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          searchText: "review",
          sortMode: "oldest",
          tierFilters: ["review", "merged"],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useWorktreesSettingsViewStore.persist.rehydrate();

    expect(useWorktreesSettingsViewStore.getState()).toMatchObject({
      searchText: "review",
      sortMode: "oldest",
      tierFilters: ["merged", "review"],
    });
  });

  it("drops malformed persisted fields", async () => {
    window.localStorage.setItem(
      PERSIST_KEY,
      JSON.stringify({
        state: {
          searchText: 42,
          sortMode: "sideways",
          tierFilters: ["missing", "merged", "merged"],
        },
        version: CURRENT_PERSIST_VERSION,
      }),
    );

    await useWorktreesSettingsViewStore.persist.rehydrate();

    expect(useWorktreesSettingsViewStore.getState()).toMatchObject({
      searchText: "",
      sortMode: "newest",
      tierFilters: ["merged"],
    });
  });
});
