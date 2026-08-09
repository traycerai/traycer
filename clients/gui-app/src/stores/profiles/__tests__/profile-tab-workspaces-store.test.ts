import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profileTabWorkspacesKey } from "@/lib/persist/keys";
import {
  emptyTabStripLayout,
  tabItemId,
  type PersistedTabStripLayout,
} from "@/stores/tabs/layout";
import {
  ALL_PROJECTS_TAB_BUCKET,
  profileTabBucket,
  useProfileTabWorkspacesStore,
} from "../profile-tab-workspaces-store";

const WORKSPACES_KEY = profileTabWorkspacesKey(null);

function layoutWithEpic(tabId: string): PersistedTabStripLayout {
  const ref = { kind: "epic" as const, id: tabId };
  return {
    version: 2,
    items: [{ kind: "tab", id: tabItemId(ref), ref }],
    activeItemId: tabItemId(ref),
    systemTabs: { history: null, settings: null },
    activationHistory: [ref],
  };
}

function resetStore(): void {
  window.localStorage.clear();
  useProfileTabWorkspacesStore.persist.setOptions({ name: WORKSPACES_KEY });
  useProfileTabWorkspacesStore.getState().resetForTests();
}

describe("profileTabBucket", () => {
  it("maps null to all-projects and ids to themselves", () => {
    expect(profileTabBucket(null)).toBe(ALL_PROJECTS_TAB_BUCKET);
    expect(profileTabBucket("p1")).toBe("p1");
  });
});

describe("useProfileTabWorkspacesStore", () => {
  beforeEach(resetStore);
  afterEach(resetStore);

  it("saveLayout stores under the given bucket", () => {
    const layout = layoutWithEpic("tab-a");
    useProfileTabWorkspacesStore.getState().saveLayout("p1", layout);

    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket["p1"],
    ).toEqual(layout);
  });

  it("saveLayout overwrites an existing bucket", () => {
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout("p1", layoutWithEpic("tab-a"));
    const next = layoutWithEpic("tab-b");
    useProfileTabWorkspacesStore.getState().saveLayout("p1", next);

    expect(
      useProfileTabWorkspacesStore.getState().layoutsByBucket["p1"],
    ).toEqual(next);
  });

  it("dropBucket removes only the named bucket", () => {
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout("p1", layoutWithEpic("tab-a"));
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout(ALL_PROJECTS_TAB_BUCKET, emptyTabStripLayout());

    useProfileTabWorkspacesStore.getState().dropBucket("p1");

    const buckets = useProfileTabWorkspacesStore.getState().layoutsByBucket;
    expect(buckets["p1"]).toBeUndefined();
    expect(buckets[ALL_PROJECTS_TAB_BUCKET]).toEqual(emptyTabStripLayout());
  });

  it("dropBucket is a no-op for an unknown bucket", () => {
    useProfileTabWorkspacesStore
      .getState()
      .saveLayout("p1", layoutWithEpic("tab-a"));
    const before = useProfileTabWorkspacesStore.getState().layoutsByBucket;

    useProfileTabWorkspacesStore.getState().dropBucket("missing");

    expect(useProfileTabWorkspacesStore.getState().layoutsByBucket).toEqual(
      before,
    );
  });
});
