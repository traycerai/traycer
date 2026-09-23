/**
 * `useIdentityTabsStore`: `openTab` idempotency (keeps host/order, refreshes
 * title), `closeTab` removing from order and clearing the active tab, and
 * `setActiveTab` ignoring an unknown id.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  resetIdentityTabsStoreForTests,
  useIdentityTabsStore,
} from "@/stores/identities/identity-tabs-store";

describe("useIdentityTabsStore", () => {
  afterEach(() => {
    resetIdentityTabsStoreForTests();
  });

  it("openTab creates a new tab and appends it to the open order", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-1", hostId: "host-a", title: "Soul" });

    const state = useIdentityTabsStore.getState();
    expect(state.tabsById["identity-1"]).toEqual({
      id: "identity-1",
      identityId: "identity-1",
      hostId: "host-a",
      title: "Soul",
    });
    expect(state.openTabOrder).toEqual(["identity-1"]);
  });

  it("a second openTab for the same id is idempotent: keeps host and order, refreshes title", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-1", hostId: "host-a", title: "Soul" });
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-2", hostId: "host-b", title: "Other" });

    useIdentityTabsStore.getState().openTab({
      identityId: "identity-1",
      // A different host on the re-open must NOT move the tab: the record's
      // host is bound for life.
      hostId: "host-z",
      title: "Soul (renamed)",
    });

    const state = useIdentityTabsStore.getState();
    expect(state.tabsById["identity-1"]?.hostId).toBe("host-a");
    expect(state.tabsById["identity-1"]?.title).toBe("Soul (renamed)");
    // Order is untouched - the re-open does not move the tab to the end.
    expect(state.openTabOrder).toEqual(["identity-1", "identity-2"]);
  });

  it("closeTab removes the tab from the open order and clears the active tab if it was active", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-1", hostId: "host-a", title: "Soul" });
    useIdentityTabsStore.getState().setActiveTab("identity-1");
    expect(useIdentityTabsStore.getState().activeTabId).toBe("identity-1");

    useIdentityTabsStore.getState().closeTab("identity-1");

    const state = useIdentityTabsStore.getState();
    expect(state.tabsById["identity-1"]).toBeUndefined();
    expect(state.openTabOrder).toEqual([]);
    expect(state.activeTabId).toBeNull();
  });

  it("closeTab leaves the active tab alone when a DIFFERENT tab is closed", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-1", hostId: "host-a", title: "Soul" });
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-2", hostId: "host-a", title: "Other" });
    useIdentityTabsStore.getState().setActiveTab("identity-1");

    useIdentityTabsStore.getState().closeTab("identity-2");

    expect(useIdentityTabsStore.getState().activeTabId).toBe("identity-1");
    expect(useIdentityTabsStore.getState().openTabOrder).toEqual([
      "identity-1",
    ]);
  });

  it("setActiveTab ignores an unknown id", () => {
    useIdentityTabsStore
      .getState()
      .openTab({ identityId: "identity-1", hostId: "host-a", title: "Soul" });
    useIdentityTabsStore.getState().setActiveTab("identity-1");

    useIdentityTabsStore.getState().setActiveTab("no-such-identity");

    expect(useIdentityTabsStore.getState().activeTabId).toBe("identity-1");
  });

  it("setActiveTab on a never-opened store stays null for an unknown id", () => {
    useIdentityTabsStore.getState().setActiveTab("no-such-identity");
    expect(useIdentityTabsStore.getState().activeTabId).toBeNull();
  });
});
