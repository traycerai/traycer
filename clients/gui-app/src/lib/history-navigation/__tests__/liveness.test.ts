import "../../../../__tests__/test-browser-apis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isHistoryEntryDead } from "@/lib/history-navigation/liveness";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { EpicViewTab } from "@/stores/epics/canvas/types";

function tab(tabId: string, epicId: string): EpicViewTab {
  return { tabId, epicId, name: "Epic" };
}

beforeEach(() => {
  window.localStorage.clear();
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
});

afterEach(() => {
  useEpicCanvasStore.setState(useEpicCanvasStore.getInitialState(), true);
  useLandingDraftStore.setState(useLandingDraftStore.getInitialState(), true);
});

describe("isHistoryEntryDead — conservative liveness", () => {
  it("keeps routes no store can prove dead", () => {
    for (const href of [
      "/",
      "/onboarding",
      "/draft/new",
      "/epics",
      "/settings",
      "/settings/general",
      "/settings/keybindings",
      "/totally-unknown/route/shape",
      "",
    ]) {
      expect(isHistoryEntryDead(href)).toBe(false);
    }
  });

  it("keeps an epic-tab href whose tab still maps to the epic", () => {
    useEpicCanvasStore.setState({ tabsById: { t1: tab("t1", "e1") } });
    expect(isHistoryEntryDead("/epics/e1/t1")).toBe(false);
    // Query string / hash are ignored when matching the path.
    expect(isHistoryEntryDead("/epics/e1/t1?focusArtifactId=a#frag")).toBe(
      false,
    );
  });

  it("prunes a gone-tab href when the epic has no resolvable sibling", () => {
    // tabsById holds t1 but openTabOrder is empty, so resolveTabIdForEpic("e1")
    // finds nothing to redirect to → the stale entry is dead.
    useEpicCanvasStore.setState({ tabsById: { t1: tab("t1", "e1") } });
    expect(isHistoryEntryDead("/epics/e1/tGONE")).toBe(true);
  });

  it("keeps a gone-tab href when the epic still has a sibling tab", () => {
    // The exact tab is gone, but resolveTabIdForEpic("e1") resolves sibling t1
    // (present in openTabOrder), so the route's beforeLoad would redirect a back
    // step there instead of failing — prune must not drop it.
    useEpicCanvasStore.setState({
      tabsById: { t1: tab("t1", "e1") },
      openTabOrder: ["t1"],
    });
    expect(isHistoryEntryDead("/epics/e1/tGONE")).toBe(false);
  });

  it("prunes an epic-tab href whose tab now belongs to a different epic", () => {
    useEpicCanvasStore.setState({ tabsById: { t1: tab("t1", "e1") } });
    expect(isHistoryEntryDead("/epics/e2/t1")).toBe(true);
  });

  it("keeps a draft href whose id is present in the landing-draft store", () => {
    const draftId = useLandingDraftStore.getState().createDraft(null);
    expect(isHistoryEntryDead(`/draft/${draftId}`)).toBe(false);
  });

  it("prunes a draft href whose id is absent from the store", () => {
    expect(isHistoryEntryDead("/draft/missing-draft-id")).toBe(true);
  });

  it("never prunes the /draft/new route even with an empty store", () => {
    expect(isHistoryEntryDead("/draft/new")).toBe(false);
  });
});
