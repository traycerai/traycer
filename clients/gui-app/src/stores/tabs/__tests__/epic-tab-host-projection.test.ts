/**
 * Pins the epic `HeaderTab` variant's `hostId` field: a PROJECTION of the
 * epic session's own host (`epic-session-registry.ts` / `kinds/epic.tsx`),
 * never a second decider. Drives the real `getHeaderTabs()` projection path
 * (the non-hook counterpart of `useHeaderTabs`) against the actual
 * `useTabsStore` / `useEpicCanvasStore` state and the real module-scoped
 * `OpenEpicSessionRegistry` singleton, so the memoization cache in
 * `use-header-tabs.ts` (`epicHeaderTabCacheKey`, `memoizedEpicHeaderTab`) is
 * exercised for real rather than asserted against in isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { getHeaderTabs } from "@/stores/tabs/use-header-tabs";
import type { HeaderTab } from "@/stores/tabs/types";

// Honestly-typed, zero-implementation factory - mirrors
// `session-registry.test.ts` / `use-chat-archive-support.test.ts`. The
// projection path under test only ever reads `handle.store` (via `build()`)
// and the `handleHostIds` stamp; it never touches the stream transport.
const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildHandle(epicId: string): OpenEpicStoreHandle {
  return createOpenEpicStore({
    epicId,
    streamClientFactory: noopStreamClientFactory,
    userId: null,
    onAuthError: null,
  });
}

/** Opens a real epic tab via the canvas store, then places its ref in the
 * tabs store's strip order - the two facts `getHeaderTabs()` joins on. */
function seedEpicTab(epicId: string, name: string): string {
  const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, name);
  useTabsStore.setState({ stripOrder: [{ kind: "epic", id: tabId }] });
  return tabId;
}

function findEpicTab(
  tabs: ReadonlyArray<HeaderTab>,
  tabId: string,
): Extract<HeaderTab, { kind: "epic" }> {
  const tab = tabs.find((candidate) => candidate.id === tabId);
  if (tab === undefined || tab.kind !== "epic") {
    throw new Error(`expected an epic tab for ${tabId}`);
  }
  return tab;
}

function resetStores(): void {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  getOpenEpicRegistry().disposeAll();
}

describe("epic tab host projection", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("projects hostId: null when the epic has no live session in the registry", () => {
    const tabId = seedEpicTab("epic-no-session", "No Session");

    const tab = findEpicTab(getHeaderTabs(), tabId);

    expect(tab.hostId).toBeNull();
  });

  it("projects the live session's host once a handle is registered", () => {
    const tabId = seedEpicTab("epic-live-session", "Live Session");
    const handle = buildHandle("epic-live-session");
    handleHostIds.set(handle, "host-a");
    getOpenEpicRegistry().acquireMounted("epic-live-session", () => handle);

    const tab = findEpicTab(getHeaderTabs(), tabId);

    expect(tab.hostId).toBe("host-a");
  });

  it("re-projects the new host after a re-point, and keeps identity stable when nothing moved", () => {
    const epicId = "epic-repoint";
    const tabId = seedEpicTab(epicId, "Re-point Me");
    const handleA = buildHandle(epicId);
    handleHostIds.set(handleA, "host-a");
    getOpenEpicRegistry().acquireMounted(epicId, () => handleA);

    const first = findEpicTab(getHeaderTabs(), tabId);
    expect(first.hostId).toBe("host-a");

    // Case 4: projecting again with NOTHING changed (same `EpicViewTab`
    // source object, same lock state, same registered handle/host) must
    // return the exact same `HeaderTab` object - `memoizedEpicHeaderTab`
    // caches by source-object identity + `epicHeaderTabCacheKey`, and
    // neither input moved. Header rows must not re-render off an unrelated
    // revision bump.
    const second = findEpicTab(getHeaderTabs(), tabId);
    expect(second).toBe(first);

    // Case 3 (load-bearing): `replaceMounted` re-points this SAME epic tab
    // at a NEW handle/host without touching the canvas store's
    // `EpicViewTab` object at all - `tabsById[tabId]` is untouched, so the
    // key `epicHeaderTabCache` (a `WeakMap<EpicViewTab, ...>`) is keyed on
    // has NOT changed. The only thing that changed is what
    // `epicSessionHostId()` reads from the registry. If
    // `epicHeaderTabCacheKey` ignored its `hostId` argument (keyed on lock
    // state alone), this call would still hit the case-2 cache entry for
    // "unlocked" and keep serving "host-a" forever - the assertions below
    // only pass because the cache key genuinely folds in the projected host.
    const handleB = buildHandle(epicId);
    handleHostIds.set(handleB, "host-b");
    const replaced = getOpenEpicRegistry().replaceMounted(
      epicId,
      handleA,
      handleB,
      {
        hostStamp: "host-a",
        ownerIdentityKey: null,
        editsTransferredToReplacement: false,
      },
    );
    expect(replaced).toBe(true);

    const third = findEpicTab(getHeaderTabs(), tabId);
    expect(third.hostId).toBe("host-b");
    expect(third).not.toBe(first);
  });

  it("carries hostId only on the epic tab variant", () => {
    useTabsStore.getState().openSystemTab({
      kind: "history",
      name: "History",
      lastPath: null,
    });

    const tabs = getHeaderTabs();
    const historyTab = tabs.find((candidate) => candidate.kind === "history");
    if (historyTab === undefined) {
      throw new Error("expected a history tab to be projected");
    }

    // Runtime: the projected tab is not the epic variant.
    expect(historyTab.kind).not.toBe("epic");
    // Type-level: the `if` above narrows `historyTab` to the "history"
    // member of the `HeaderTab` union, which has no `hostId` property at
    // all (see `stores/tabs/types.ts`) - `historyTab.hostId` would fail to
    // compile here. Only the "epic" variant carries a projected host.
  });
});
