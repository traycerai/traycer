import { afterEach, describe, expect, it } from "vitest";
import {
  __getOpenEpicRegistryForTests,
  releaseOpenEpicSessionIfUnused,
} from "@/lib/registries/epic-session-registry";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
} from "@/stores/epics/open-epic/store";

/**
 * The registry is keyed by EPIC and the UI is keyed by TAB, and one window can
 * legitimately show the same epic in two tabs. `registry.release(epicId)`
 * disposes unconditionally, so every path that has finished with ONE tab has to
 * ask whether another still holds the epic - otherwise it takes the live
 * session out from under a tab that was never closed.
 *
 * The ownership-denial path did not ask. Its own comment says a denial is about
 * a tab id and that "two windows CAN hold the same epic live at once with
 * different tab ids", and the next line released by epic.
 *
 * ⚠ WHY THIS ASKS THE TAB STORE AND NOT `mountedRefs`. The registry keeps a
 * real mount refcount, which looks like the obvious authority and is the wrong
 * one HERE: the denied tab's own provider is still mounted when it runs, so its
 * ref is live and a `mountedRefs > 0` guard would make the release a permanent
 * no-op - the opposite defect, and one that reads as a fix. The callers reach
 * this helper only AFTER removing their own tab from the store, so the question
 * it asks is exactly "does a DIFFERENT tab still hold this epic".
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
    createOpenEpicStore({
      epicId,
      streamClientFactory: noopStreamClientFactory,
      userId: null,
      onAuthError: null,
    }),
  );
}

/**
 * Opens a real tab for `epicId` through the store's own API.
 *
 * Not a hand-rolled `tabsById` literal: `EpicViewTab` carries fields this test
 * does not care about, and a partial literal type-checks nowhere while RUNNING
 * fine - vitest transpiles without checking, so the first version of this file
 * was 3/3 green against a shape `tsc` rejected.
 */
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
   * THE PAIRED POSITIVE. Without it, the arm above passes just as happily
   * against a helper that never releases anything - which would leak every
   * session in the app and satisfy "the other tab survived" perfectly.
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
