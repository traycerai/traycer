/**
 * `useHeaderTabForRef` (now exported for the drag overlay) gained a
 * `subscribeEpicSessionHosts` subscription so a registry stamp/repoint
 * re-renders it on its own, with no unrelated prop change to force a
 * remount. `epic-tab-host-projection.test.ts` proves the projection via the
 * non-hook `getHeaderTabs()`, which re-reads state on every call and so
 * cannot tell whether the HOOK actually resubscribes - this drives the same
 * stamp/repoint sequence through one live `renderHook` instance instead.
 */
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import {
  getOpenEpicRegistry,
  handleHostIds,
} from "@/lib/registries/epic-session-registry";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useTabsStore } from "@/stores/tabs/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useHeaderTabForRef } from "@/stores/tabs/use-header-tabs";
import type { HeaderTab } from "@/stores/tabs/types";

/** `hostId` only exists on the "epic" member of the `HeaderTab` union. */
function readEpicHost(tab: HeaderTab | null): string | null {
  if (tab === null || tab.kind !== "epic") {
    throw new Error("expected an epic tab");
  }
  return tab.hostId;
}

const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function buildHandle(epicId: string): OpenedStoreForTest {
  return openStoreForTest({
    epicId,
    userId: null,
    factories: {
      streamClientFactory: noopStreamClientFactory,
      laneSelection: null,
    },
    writeCommand: null,
  });
}

function resetStores(): void {
  useTabsStore.setState(useTabsStore.getInitialState(), true);
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
  getOpenEpicRegistry().disposeAll();
}

afterEach(() => {
  cleanup();
  resetStores();
});

describe("useHeaderTabForRef: live session-host subscription", () => {
  it("re-renders on its own when a session is stamped, then again when it repoints - no other input changes", () => {
    resetStores();
    const epicId = "epic-live-subscription";
    const tabId = useEpicCanvasStore.getState().openEpicTab(epicId, "Live");

    const { result } = renderHook(() =>
      useHeaderTabForRef({ kind: "epic", id: tabId }),
    );
    expect(result.current?.kind).toBe("epic");
    expect(readEpicHost(result.current)).toBeNull();

    const handleA = buildHandle(epicId);
    handleHostIds.set(handleA, "host-a");
    act(() => {
      getOpenEpicRegistry().acquireMounted(epicId, () => handleA);
    });
    expect(readEpicHost(result.current)).toBe("host-a");

    const handleB = buildHandle(epicId);
    handleHostIds.set(handleB, "host-b");
    act(() => {
      getOpenEpicRegistry().replaceMounted(epicId, handleA, handleB, {
        hostStamp: "host-a",
        ownerIdentityKey: null,
        editsTransferredToReplacement: false,
      });
    });
    expect(readEpicHost(result.current)).toBe("host-b");
  });
});
