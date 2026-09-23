/**
 * Deleting an identity closes its tab through the SAME coordinator wiring
 * `close-wiring-t10.test.ts` pins for epic/draft/system tabs
 * (`tabCommandCoordinator.closeRefAfterConfirmed`), and the identity source
 * store's own `closeTab` is reconciled into the layout the same way when it
 * changes out from under the coordinator (`installSourceReconciliation`'s
 * `useIdentityTabsStore.subscribe`).
 */
import { afterEach, describe, expect, it } from "vitest";
import { tabItemId } from "@/stores/tabs/layout";
import { useTabsStore } from "@/stores/tabs/store";
import { tabCommandCoordinator } from "@/stores/tabs/tab-command-coordinator";
import {
  resetIdentityTabsStoreForTests,
  useIdentityTabsStore,
} from "@/stores/identities/identity-tabs-store";
import type { TabRef } from "@/stores/tabs/types";

const REF_A: TabRef = { kind: "identity", id: "id-a" };
const REF_B: TabRef = { kind: "identity", id: "id-b" };

function seedTwoIdentityTabs(): void {
  useIdentityTabsStore
    .getState()
    .openTab({ identityId: "id-a", hostId: "host-a", title: "A" });
  useIdentityTabsStore
    .getState()
    .openTab({ identityId: "id-b", hostId: "host-a", title: "B" });
  useTabsStore.setState({
    version: 2,
    items: [
      { kind: "tab", id: tabItemId(REF_A), ref: REF_A },
      { kind: "tab", id: tabItemId(REF_B), ref: REF_B },
    ],
    activeItemId: tabItemId(REF_A),
    stripOrder: [REF_A, REF_B],
    systemTabs: { history: null, settings: null },
  });
}

afterEach(() => {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  resetIdentityTabsStoreForTests();
  tabCommandCoordinator.resetReconciliationForTesting();
});

describe("T10: identity tab delete routes through the coordinator", () => {
  it("closeRefAfterConfirmed removes the layout item, promotes the survivor, and closes the source tab", () => {
    tabCommandCoordinator.installSourceReconciliation();
    seedTwoIdentityTabs();

    const closed = tabCommandCoordinator.closeRefAfterConfirmed({
      kind: "identity",
      id: "id-a",
    });

    expect(closed).toBe(true);
    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: tabItemId(REF_B), ref: REF_B },
    ]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(REF_B));
    expect(useIdentityTabsStore.getState().tabsById["id-a"]).toBeUndefined();
  });

  it("closing the identity tab directly through its own store reconciles the layout the same way", () => {
    tabCommandCoordinator.installSourceReconciliation();
    seedTwoIdentityTabs();

    useIdentityTabsStore.getState().closeTab("id-a");

    expect(useTabsStore.getState().items).toEqual([
      { kind: "tab", id: tabItemId(REF_B), ref: REF_B },
    ]);
    expect(useTabsStore.getState().activeItemId).toBe(tabItemId(REF_B));
    expect(useIdentityTabsStore.getState().tabsById["id-a"]).toBeUndefined();
  });
});
