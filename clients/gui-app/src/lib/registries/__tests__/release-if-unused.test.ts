import { afterEach, describe, expect, it } from "vitest";
import {
  __getOpenEpicRegistryForTests,
  releaseOpenEpicSessionIfUnused,
} from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import { openStoreForTest } from "@/stores/epics/open-epic/test-support/open-store-for-test";

/**
 * The registry is keyed by EPIC and the UI is keyed by TAB, and one window can legitimately show the same epic in two tabs.
 * `registry.release(epicId)` disposes unconditionally, so every path that has finished with ONE tab has to ask whether another still holds the epic - otherwise it takes the live session out from under a tab that was never closed.
 */
const noopStreamClientFactory: EpicStreamClientFactory = () => ({
  applyUpdate: () => undefined,
  awareness: () => undefined,
  applyArtifactRoomUpdate: () => undefined,
  artifactRoomAwareness: () => undefined,
  retryMigration: () => undefined,
  close: () => undefined,
});

function mountSession(epicId: string): void {
  __getOpenEpicRegistryForTests().acquireMounted(epicId, () =>
    openStoreForTest({
      epicId: epicId,
      userId: null,
      // The factories go to the COMPOSITION now: the store stopped constructing a runtime, so a `streamClientFactory` has nowhere else to go.
      factories: {
        streamClientFactory: noopStreamClientFactory,
        laneSelection: null,
      },
      writeCommand: null,
    }),
  );
}

/** Opens a real tab for `epicId` through the store's own API. */
function openTabFor(epicId: string): void {
  useEpicCanvasStore.getState().resolveTargetTabForEpic(epicId, "Test epic");
}

function closeAllTabs(): void {
  useEpicCanvasStore.setState({ openTabOrder: [], tabsById: {} });
}

afterEach(() => {
  __getOpenEpicRegistryForTests().disposeAll();
  useEpicCanvasStore.setState({ openTabOrder: [], tabsById: {} });
});

describe("releaseOpenEpicSessionIfUnused", () => {
  it("keeps the session alive while another tab in this window still shows the epic", () => {
    mountSession("epic-1");
    // The denied tab has already been removed by its caller; this is the
    // legitimately-open second view of the same epic.
    openTabFor("epic-1");

    releaseOpenEpicSessionIfUnused("epic-1", "keep", null);

    expect(__getOpenEpicRegistryForTests().peek("epic-1")).not.toBeNull();
  });

  /**
   * THE PAIRED POSITIVE.
   * Without it, the arm above passes just as happily against a helper that never releases anything - which would leak every session in the app and satisfy "the other tab survived" perfectly.
   */
  it("releases once no tab shows it, which is what makes the guard a guard", () => {
    mountSession("epic-1");
    closeAllTabs();

    releaseOpenEpicSessionIfUnused("epic-1", "keep", null);

    expect(__getOpenEpicRegistryForTests().peek("epic-1")).toBeNull();
  });

  it("does not confuse a different epic's tab for this one", () => {
    mountSession("epic-1");
    openTabFor("epic-2");

    releaseOpenEpicSessionIfUnused("epic-1", "keep", null);

    expect(__getOpenEpicRegistryForTests().peek("epic-1")).toBeNull();
  });
});
