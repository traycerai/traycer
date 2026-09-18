import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { ComposerDraftsControl } from "@/components/composer/drafts/composer-drafts-control";
import { Analytics, AnalyticsEvent, type AnalyticsDraftInput } from "@/lib/analytics";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import {
  acquireDraftMirrorSession,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import {
  openActiveDraftsControl,
  resetActiveDraftsControlForTests,
} from "@/lib/commands/active-drafts-control-registry";
import {
  useLandingDraftStore,
  type LandingDraftTab,
  type LandingDraftWorkspaceSnapshot,
} from "@/stores/home/landing-draft-store";

/**
 * The row actions are T04's, exercised end to end by
 * `draft-inventory-actions.test.ts` against real stores and a fake host. Here
 * they are a boundary: this file is about which rows the control lists and
 * which gesture reaches which action, not about what an action then does to a
 * host. Mocking them also keeps the control out of the router and host-binding
 * providers it would otherwise need only to render a list.
 */
const actions = {
  openRow: vi.fn<(row: DraftInventoryRow, input: AnalyticsDraftInput) => void>(),
  copyRow: vi.fn<(row: DraftInventoryRow, input: AnalyticsDraftInput) => void>(),
  deleteRow: vi.fn<(row: DraftInventoryRow, input: AnalyticsDraftInput) => void>(),
};
vi.mock("@/hooks/drafts/use-draft-inventory-actions", () => ({
  useDraftInventoryActions: () => actions,
}));

const HOST_ID = "host-drafts";

const EMPTY_WORKSPACE: LandingDraftWorkspaceSnapshot = {
  folders: [],
  folderInfoByPath: {},
  primaryPath: null,
};

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

function landingTab(
  overrides: Partial<LandingDraftTab> & { readonly id: string },
): LandingDraftTab {
  return {
    content: typed(`landing ${overrides.id}`),
    selection: null,
    lastTouchedAt: 1_000,
    settings: null,
    composerMode: "chat",
    workspace: EMPTY_WORKSPACE,
    adoption: { state: "unadopted" },
    hostRevision: 0,
    generation: 1,
    syncedGeneration: 0,
    ownerHostId: null,
    origin: null,
    supersedes: null,
    publication: null,
    confirmedHostBlobHashes: [],
    closed: true,
    ...overrides,
  };
}

const fakeHostClient = {
  request: () =>
    Promise.resolve({
      drafts: [],
      tombstones: [],
      snapshotSeq: 0,
      scopeId: null,
    }),
};

function mountSession(): void {
  acquireDraftMirrorSession({
    hostId: HOST_ID,
    client: fakeHostClient as never,
    streamClient: fakeDraftStreamClient(),
    timing: { debounceMs: 0, maxWaitMs: 0 },
  });
}

/**
 * No editor behind the control: every call it makes on the handle is optional
 * (`hasFocus`, `focus`), and focus restoration is the composer's contract with
 * the editor, not this list's behaviour.
 */
const editorRef: RefObject<ComposerPromptEditorHandle | null> = {
  current: null,
};

function landingControl(activeDraftId: string | null, active: boolean) {
  return (
    <ComposerDraftsControl
      scope={{ surface: "landing", activeDraftId }}
      hostId={HOST_ID}
      pickerStore={createComposerPickerStore()}
      editorRef={editorRef}
      active={active}
    />
  );
}

/** The ordinary case: this surface is the one the user is on. */
function renderLandingControl(activeDraftId: string | null) {
  return render(landingControl(activeDraftId, true));
}

function openList(): void {
  fireEvent.click(screen.getByRole("button", { name: /drafts/i }));
}

function pressKey(key: string): void {
  fireEvent.keyDown(window, { key });
}

/** Whether the control consumed the press, rather than letting it through. */
function pressKeyPrevented(key: string): boolean {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * The listed rows, by draft id. Asserted by id rather than by text because a
 * row's text is the draft's own typed content, which these tests seed with
 * interchangeable fixture prose - the id is the stable handle.
 */
function listedRowIds(): ReadonlyArray<string> {
  return Array.from(
    document.querySelectorAll<HTMLElement>("[data-draft-row-id]"),
  ).map((element) => element.dataset.draftRowId ?? "");
}

describe("ComposerDraftsControl", () => {
  beforeEach(() => {
    window.innerWidth = 1024;
    useLandingDraftStore.setState({
      drafts: [
        landingTab({
          id: "landing-a",
          content: typed("Ship the release notes"),
          lastTouchedAt: 2_000,
        }),
        landingTab({
          id: "landing-active",
          content: typed("Being edited right now"),
          lastTouchedAt: 5_000,
        }),
      ],
      activeDraftId: "landing-active",
    });
    mountSession();
  });

  afterEach(() => {
    cleanup();
    releaseDraftMirrorSession(HOST_ID);
    resetDraftMirrorCoordinatorForTests();
    resetActiveDraftsControlForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    actions.openRow.mockReset();
    actions.copyRow.mockReset();
    actions.deleteRow.mockReset();
    vi.restoreAllMocks();
  });

  it("lists the start page's other drafts and never the one being edited", () => {
    renderLandingControl("landing-active");
    openList();

    // The active draft is the live buffer, never a row; chat drafts belong to
    // All, not to the start page's own filter (D05).
    expect(listedRowIds()).toEqual(["landing-a"]);
    expect(
      screen.getAllByText("Ship the release notes").length,
    ).toBeGreaterThan(0);
  });

  // H02: the start-page control has no filter any more - always `current`,
  // so there is nothing left to toggle and no source chip to show.
  it("never shows a filter toggle", () => {
    renderLandingControl("landing-active");
    openList();

    expect(screen.queryByRole("button", { name: "All" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start page" })).toBeNull();
  });

  // T09: the pill click is the "button" entry point (H06's shortcut and the
  // palette are the other two, threaded through the registry below).
  it("fires drafts_list_opened with entry_point button when the pill opens the list", () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    renderLandingControl("landing-active");

    openList();

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftsListOpened, {
      surface: "start_page",
      entry_point: "button",
      draft_count: "1",
    });
  });

  it("does not refire drafts_list_opened while the list stays open", () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    renderLandingControl("landing-active");
    openList();
    trackSpy.mockClear();

    pressKey("ArrowDown");

    expect(trackSpy).not.toHaveBeenCalled();
  });

  it("threads the registry's own entry point into drafts_list_opened for shortcut and palette, and never toggles the list closed (review finding 5)", () => {
    const trackSpy = vi
      .spyOn(Analytics.getInstance(), "track")
      .mockImplementation(() => true);
    renderLandingControl("landing-active");

    let opened = false;
    act(() => {
      opened = openActiveDraftsControl("shortcut");
    });
    expect(opened).toBe(true);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftsListOpened, {
      surface: "start_page",
      entry_point: "shortcut",
      draft_count: "1",
    });
    expect(listedRowIds()).toEqual(["landing-a"]);

    // Ensure-open, not toggle: a second shortcut fire while already open
    // must leave the list open and fire no second event.
    trackSpy.mockClear();
    act(() => {
      opened = openActiveDraftsControl("shortcut");
    });
    expect(opened).toBe(true);
    expect(listedRowIds()).toEqual(["landing-a"]);
    expect(trackSpy).not.toHaveBeenCalled();

    // The regression this fix closes: choosing "Drafts" from an already-open
    // palette must not close the list out from under it either.
    trackSpy.mockClear();
    act(() => {
      opened = openActiveDraftsControl("palette");
    });
    expect(opened).toBe(true);
    expect(listedRowIds()).toEqual(["landing-a"]);
    expect(trackSpy).not.toHaveBeenCalled();

    // Only an explicit dismissal closes it - a fresh entry point afterward
    // opens it again and fires its own event.
    pressKey("Escape");
    expect(listedRowIds()).toEqual([]);

    trackSpy.mockClear();
    act(() => {
      opened = openActiveDraftsControl("palette");
    });
    expect(opened).toBe(true);
    expect(listedRowIds()).toEqual(["landing-a"]);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftsListOpened, {
      surface: "start_page",
      entry_point: "palette",
      draft_count: "1",
    });
  });

  it("counts only the current-surface rows, and hides the badge at zero", () => {
    const { unmount } = renderLandingControl("landing-active");
    const trigger = screen.getByRole("button", { name: /drafts/i });
    expect(trigger.getAttribute("aria-label")).toBe("Drafts: 1. Open drafts.");
    expect(trigger.textContent).toContain("1");
    unmount();

    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    renderLandingControl(null);
    const empty = screen.getByRole("button", { name: /drafts/i });
    expect(empty.getAttribute("aria-label")).toBe("Drafts");
    expect(empty.textContent).toBe("Drafts");
  });

  it("renders a mention as a chip in the row, not the raw @ serialised form", () => {
    useLandingDraftStore.setState({
      drafts: [
        ...useLandingDraftStore.getState().drafts,
        landingTab({
          id: "landing-mention",
          content: {
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "see " },
                  {
                    type: "mention",
                    attrs: {
                      contextType: "file",
                      id: "/tmp/CODE_OF_CONDUCT.md",
                      path: "CODE_OF_CONDUCT.md",
                      pathKind: "file",
                      relPath: "CODE_OF_CONDUCT.md",
                      absolutePath: "/tmp/CODE_OF_CONDUCT.md",
                      workspacePath: "/tmp",
                      label: "CODE_OF_CONDUCT.md",
                      description: null,
                    },
                  },
                ],
              },
            ],
          },
          lastTouchedAt: 6_000,
        }),
      ],
    });
    render(landingControl("landing-active", true));
    openList();

    const content = document.querySelector<HTMLElement>(
      '[data-draft-row-id="landing-mention"] [data-testid="draft-row-content"]',
    );
    expect(content?.textContent).toContain("CODE_OF_CONDUCT.md");
    expect(content?.textContent).not.toContain("@CODE_OF_CONDUCT.md");
  });

  it("opens the highlighted row on Enter and closes the list, with keyboard input", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("Enter");

    expect(actions.openRow).toHaveBeenCalledTimes(1);
    expect(actions.openRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(actions.openRow.mock.calls[0]?.[1]).toBe("keyboard");
    expect(listedRowIds()).toEqual([]);
  });

  it("copies on C and keeps the list open, with keyboard input", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("c");

    expect(actions.copyRow).toHaveBeenCalledTimes(1);
    expect(actions.copyRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(actions.copyRow.mock.calls[0]?.[1]).toBe("keyboard");
    expect(listedRowIds()).toEqual(["landing-a"]);
  });

  it("deletes on D and keeps the list open, with keyboard input", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("d");

    expect(actions.deleteRow).toHaveBeenCalledTimes(1);
    expect(actions.deleteRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(actions.deleteRow.mock.calls[0]?.[1]).toBe("keyboard");
    expect(listedRowIds()).toEqual(["landing-a"]);
  });

  // The row's own key buttons read a real click's `event.detail` (nonzero)
  // apart from a synthetic Enter/Space activation (`detail: 0`) - the same
  // distinction `event.detail === 0` draws in production.
  it("classifies a key button's activation by its event detail: 0 is keyboard, nonzero is pointer", () => {
    renderLandingControl("landing-active");
    openList();
    const copyButton = screen.getByRole("button", { name: "Copy draft" });

    fireEvent.click(copyButton);
    expect(actions.copyRow.mock.calls[0]?.[1]).toBe("keyboard");

    fireEvent.click(copyButton, { detail: 1 });
    expect(actions.copyRow.mock.calls[1]?.[1]).toBe("pointer");
  });

  // cmdk's own row click (`onSelect`) never reaches a keyboard Enter - the
  // control's window-level capture below answers that first - so it is
  // hardcoded to pointer regardless of the click's `detail`.
  it("opens with pointer input when the row itself is clicked", () => {
    renderLandingControl("landing-active");
    openList();
    const row = document.querySelector<HTMLElement>(
      '[data-draft-row-id="landing-a"]',
    );
    if (row === null) throw new Error("expected the landing-a row to render");

    fireEvent.click(row);

    expect(actions.openRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(actions.openRow.mock.calls[0]?.[1]).toBe("pointer");
  });

  it("closes on any other printable key, so typing reaches the editor", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("x");

    expect(listedRowIds()).toEqual([]);
    expect(actions.copyRow).not.toHaveBeenCalled();
    expect(actions.deleteRow).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("Escape");

    expect(listedRowIds()).toEqual([]);
  });

  it("says so when the current surface has nothing", () => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    renderLandingControl(null);
    openList();

    expect(screen.getByText("No drafts here yet")).toBeTruthy();
  });

  it("renders a drawer on a phone-width viewport", () => {
    window.innerWidth = 480;
    renderLandingControl("landing-active");
    openList();

    expect(document.querySelector("[data-slot=drawer-content]")).not.toBeNull();
    expect(document.querySelector("[data-slot=popover-content]")).toBeNull();
    // No key hints on a phone; copy and delete are tappable instead (D22).
    expect(screen.getByRole("button", { name: "Copy draft" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete draft" })).toBeTruthy();
  });

  // `PopoverContent` un-presents its portal on a pane switch while leaving the
  // root open, so an ungated control would keep eating keys while invisible -
  // and `d` would delete a draft the user is no longer looking at.
  it("stops answering keys and closes when its surface loses focus", () => {
    const { rerender } = render(landingControl("landing-active", true));
    openList();
    expect(listedRowIds()).toEqual(["landing-a"]);

    rerender(landingControl("landing-active", false));

    expect(listedRowIds()).toEqual([]);
    pressKey("d");
    expect(actions.deleteRow).not.toHaveBeenCalled();
    pressKey("ArrowDown");
    expect(actions.openRow).not.toHaveBeenCalled();
    expect(pressKeyPrevented("Enter")).toBe(false);
  });

  it("reveals the action words on the highlighted row, not only on hover", () => {
    renderLandingControl("landing-active");
    openList();

    // The list opens with the first row highlighted, which is the state a
    // keyboard user is in before touching anything.
    const row = document.querySelector<HTMLElement>(
      '[data-draft-row-id="landing-a"]',
    );
    expect(row?.getAttribute("data-selected")).toBe("true");

    const word = screen.getByRole("button", {
      name: "Open draft",
    }).firstElementChild;
    expect(word?.textContent).toBe("Open");
    // jsdom loads no stylesheet, so the reveal is asserted as the two rules
    // that carry it (D14): the row's highlight and the cluster's hover.
    expect(word?.className).toContain(
      "group-data-[selected=true]/draft-row:opacity-100",
    );
    expect(word?.className).toContain("group-hover/draft-keys:opacity-100");
  });

  it("consumes Enter even with nothing highlighted, so it cannot submit", () => {
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    renderLandingControl(null);
    openList();
    expect(listedRowIds()).toEqual([]);

    // The list keeps editor focus behind it; an Enter that fell through would
    // send whatever is in the composer.
    expect(pressKeyPrevented("Enter")).toBe(true);
    expect(actions.openRow).not.toHaveBeenCalled();
    expect(screen.getByText("No drafts here yet")).toBeTruthy();
  });
});
