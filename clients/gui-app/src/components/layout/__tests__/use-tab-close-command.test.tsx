import "../../../../__tests__/test-browser-apis";
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useTabCloseCommand } from "@/components/layout/tabs/use-tab-close-command";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { useTabsStore } from "@/stores/tabs/store";
import { installTabSyncCoordinator } from "@/lib/tab-sync/tab-sync-coordinator";

installTabSyncCoordinator({ readyPromise: Promise.resolve() });

function resetStores(): void {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  useTabsStore.setState({
    stripOrder: [],
    systemTabs: { history: null, settings: null },
  });
}

describe("useTabCloseCommand", () => {
  beforeEach(resetStores);
  afterEach(resetStores);

  it("dispatches an epic close through the epic descriptor", () => {
    const tabId = useEpicCanvasStore.getState().openEpicTab("epic-x", "Epic X");
    expect(useEpicCanvasStore.getState().openTabOrder).toContain(tabId);

    const { result } = renderHook(() => useTabCloseCommand());
    result.current({
      kind: "epic",
      id: tabId,
      epicId: "epic-x",
      name: "Epic X",
      route: `/epics/epic-x/${tabId}`,
      icon: null,
      canDuplicate: true,
      canOpenInNewWindow: true,
    });

    expect(useEpicCanvasStore.getState().openTabOrder).not.toContain(tabId);
  });

  it("dispatches a draft close through the draft descriptor", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(true);

    const { result } = renderHook(() => useTabCloseCommand());
    result.current({
      kind: "draft",
      id: draftId,
      route: `/draft/${draftId}`,
      name: "Start Page",
      icon: null,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });

    expect(
      useLandingDraftStore.getState().drafts.some((d) => d.id === draftId),
    ).toBe(false);
  });

  it("dispatches a system close through the system descriptor", () => {
    useTabsStore.getState().openSystemTab({
      kind: "history",
      name: "History",
      lastPath: "/epics",
    });
    expect(useTabsStore.getState().systemTabs.history).not.toBeNull();

    const { result } = renderHook(() => useTabCloseCommand());
    result.current({
      kind: "history",
      id: "history",
      name: "History",
      lastPath: "/epics",
      route: "/epics",
      icon: null,
      canDuplicate: false,
      canOpenInNewWindow: false,
    });

    expect(useTabsStore.getState().systemTabs.history).toBeNull();
  });
});
