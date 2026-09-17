import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RefObject } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { createComposerPickerStore } from "@/components/chat/composer/picker/composer-picker-store";
import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { ComposerDraftsControl } from "@/components/composer/drafts/composer-drafts-control";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import {
  acquireDraftMirrorSession,
  releaseDraftMirrorSession,
  resetDraftMirrorCoordinatorForTests,
} from "@/lib/drafts/draft-mirror-coordinator";
import { fakeDraftStreamClient } from "@/lib/drafts/__tests__/draft-mirror-test-stream";
import { resetActiveDraftsControlForTests } from "@/lib/commands/active-drafts-control-registry";
import {
  useComposerDraftStore,
  type DraftState,
} from "@/stores/composer/composer-draft-store";
import {
  useNewConversationModalStore,
  type NewConversationModalDraftPatch,
} from "@/stores/epics/new-conversation-modal-store";
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
  openRow: vi.fn<(row: DraftInventoryRow) => void>(),
  copyRow: vi.fn<(row: DraftInventoryRow) => void>(),
  deleteRow: vi.fn<(row: DraftInventoryRow) => void>(),
};
vi.mock("@/hooks/drafts/use-draft-inventory-actions", () => ({
  useDraftInventoryActions: () => actions,
}));

const HOST_ID = "host-drafts";
const EPIC_ID = "epic-1";

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

function chatDraft(overrides: Partial<DraftState>): DraftState {
  return {
    content: typed("chat draft"),
    selection: null,
    browserAnnotations: [],
    resetEpoch: 0,
    revision: 1,
    draftId: "draft-chat",
    hostRevision: 1,
    targetEpicId: EPIC_ID,
    lastTouchedAt: 3_000,
    generation: 1,
    syncedGeneration: 1,
    ownerHostId: HOST_ID,
    origin: "own",
    supersedes: null,
    publication: null,
    chatTitle: "Sibling chat",
    epicTitle: "Payments",
    ...overrides,
  };
}

function newChatPatch(
  overrides: Partial<NewConversationModalDraftPatch>,
): NewConversationModalDraftPatch {
  return {
    content: typed("new agent draft"),
    selection: null,
    settings: null,
    composerMode: "chat",
    workspace: null,
    revision: 1,
    draftId: "draft-new-chat",
    hostRevision: 1,
    lastTouchedAt: 4_000,
    generation: 1,
    syncedGeneration: 1,
    epicTitle: "Payments",
    ownerHostId: HOST_ID,
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

function rowText(rowId: string): string {
  return (
    document.querySelector<HTMLElement>(`[data-draft-row-id="${rowId}"]`)
      ?.textContent ?? ""
  );
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
    useComposerDraftStore.setState({
      drafts: {
        "chat-1": chatDraft({
          draftId: "draft-chat-1",
          content: typed("Half-written question"),
        }),
      },
    });
    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    mountSession();
  });

  afterEach(() => {
    cleanup();
    releaseDraftMirrorSession(HOST_ID);
    resetDraftMirrorCoordinatorForTests();
    resetActiveDraftsControlForTests();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    useComposerDraftStore.setState({ drafts: {} });
    useNewConversationModalStore.setState({ draftPatchesByEpicId: {} });
    actions.openRow.mockReset();
    actions.copyRow.mockReset();
    actions.deleteRow.mockReset();
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

  it("switches to All from the toggle and chips each row's source", () => {
    useNewConversationModalStore.setState({
      draftPatchesByEpicId: { [EPIC_ID]: newChatPatch({}) },
    });
    renderLandingControl("landing-active");
    openList();

    fireEvent.click(screen.getByRole("button", { name: "All" }));

    // Newest first (D12).
    expect(listedRowIds()).toEqual([
      "draft-new-chat",
      "draft-chat-1",
      "landing-a",
    ]);
    // The start page has no epic, so every in-epic row is outside the scope's
    // and carries the epic prefix. Asserted on the ROW, not the document:
    // "Start page" is also the filter toggle's own segment label.
    expect(rowText("draft-chat-1")).toContain("Payments · Sibling chat");
    expect(rowText("draft-new-chat")).toContain("Payments · New agent");
    expect(rowText("landing-a")).toContain("Start page");
  });

  it("toggles the filter on Tab", () => {
    renderLandingControl("landing-active");
    openList();
    expect(listedRowIds()).toEqual(["landing-a"]);

    pressKey("Tab");
    expect(listedRowIds()).toEqual(["draft-chat-1", "landing-a"]);

    pressKey("Tab");
    expect(listedRowIds()).toEqual(["landing-a"]);
  });

  it("opens the highlighted row on Enter and closes the list", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("Enter");

    expect(actions.openRow).toHaveBeenCalledTimes(1);
    expect(actions.openRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(listedRowIds()).toEqual([]);
  });

  it("copies on C and keeps the list open", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("c");

    expect(actions.copyRow).toHaveBeenCalledTimes(1);
    expect(actions.copyRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(listedRowIds()).toEqual(["landing-a"]);
  });

  it("deletes on D and keeps the list open", () => {
    renderLandingControl("landing-active");
    openList();

    pressKey("d");

    expect(actions.deleteRow).toHaveBeenCalledTimes(1);
    expect(actions.deleteRow.mock.calls[0]?.[0].id).toBe("landing-a");
    expect(listedRowIds()).toEqual(["landing-a"]);
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

  it("chips every in-epic row on a chat surface, without the epic prefix", () => {
    useComposerDraftStore.setState({
      drafts: {
        "chat-1": chatDraft({
          draftId: "draft-chat-1",
          content: typed("Half-written question"),
        }),
        "chat-2": chatDraft({
          draftId: "draft-chat-2",
          chatTitle: "Release checklist",
          content: typed("A different thread"),
        }),
      },
    });
    useNewConversationModalStore.setState({
      draftPatchesByEpicId: { [EPIC_ID]: newChatPatch({}) },
    });
    render(
      <ComposerDraftsControl
        scope={{ surface: "chat", epicId: EPIC_ID, chatId: "chat-1" }}
        hostId={HOST_ID}
        pickerStore={createComposerPickerStore()}
        editorRef={editorRef}
        active
      />,
    );
    openList();

    expect(screen.getByRole("button", { name: "This epic" })).toBeTruthy();
    // The scope's own chat is the live buffer, never a row; the start page's
    // drafts belong to All.
    expect(listedRowIds()).toEqual(["draft-new-chat", "draft-chat-2"]);
    // Inside the scope's own epic the chip is the bare name - but it is still
    // there, because a draft's text does not say which chat it belongs to.
    expect(rowText("draft-chat-2")).toContain("Release checklist");
    expect(rowText("draft-chat-2")).not.toContain("Payments ·");
    expect(rowText("draft-new-chat")).toContain("New agent");
    expect(rowText("draft-new-chat")).not.toContain("Payments ·");
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

  it("says so when a chat surface's epic has no other drafts", () => {
    render(
      <ComposerDraftsControl
        scope={{ surface: "chat", epicId: EPIC_ID, chatId: "chat-1" }}
        hostId={HOST_ID}
        pickerStore={createComposerPickerStore()}
        editorRef={editorRef}
        active
      />,
    );
    openList();

    expect(listedRowIds()).toEqual([]);
    expect(screen.getByText("No drafts here yet")).toBeTruthy();
  });
});
