import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { DraftsDialog } from "@/components/composer/drafts/drafts-dialog";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";
import type { DraftInventoryRow } from "@/lib/drafts/draft-inventory";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

function typed(text: string): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  };
}

type LandingRow = Extract<DraftInventoryRow, { readonly kind: "landing" }>;
type ChatRow = Extract<DraftInventoryRow, { readonly kind: "chat" }>;
type NewChatRow = Extract<DraftInventoryRow, { readonly kind: "new-chat" }>;

function landingRow(
  overrides: Partial<LandingRow> & { readonly id: string },
): LandingRow {
  return {
    kind: "landing",
    preview: "a landing draft",
    content: typed("a landing draft"),
    lastTouchedAt: 1_000,
    open: false,
    foreign: false,
    ownerHostId: null,
    ...overrides,
  };
}

function chatRow(
  overrides: Partial<ChatRow> & { readonly id: string },
): ChatRow {
  return {
    kind: "chat",
    preview: "a chat draft",
    content: typed("a chat draft"),
    lastTouchedAt: 2_000,
    open: false,
    foreign: false,
    chatId: "chat-1",
    epicId: "epic-1",
    ownerHostId: "host-a",
    chatTitle: "Sibling chat",
    epicTitle: "Payments",
    ...overrides,
  };
}

function newChatRow(
  overrides: Partial<NewChatRow> & { readonly id: string },
): NewChatRow {
  return {
    kind: "new-chat",
    preview: "a new agent draft",
    content: typed("a new agent draft"),
    lastTouchedAt: 3_000,
    open: false,
    foreign: false,
    epicId: "epic-2",
    ownerHostId: "host-a",
    epicTitle: "Billing",
    ...overrides,
  };
}

const inventoryMock = vi.hoisted(() => ({
  rows: [] as DraftInventoryRow[],
  calls: [] as Array<{ scope: unknown; filter: unknown }>,
}));
vi.mock("@/hooks/drafts/use-draft-inventory", () => ({
  useDraftInventory: (scope: unknown, filter: unknown) => {
    inventoryMock.calls.push({ scope, filter });
    return inventoryMock.rows;
  },
}));

// The row actions are exercised directly against real stores/a fake host in
// `lib/drafts/__tests__/draft-inventory-actions.test.ts`; this file is only
// about what rows the dialog lists and which gesture reaches which action.
const actionsMock = vi.hoisted(() => ({
  calls: [] as Array<{ hostId: string | null }>,
  openRow:
    vi.fn<
      (row: DraftInventoryRow, input: string, usedSearch: boolean) => void
    >(),
  copyRow: vi.fn<(row: DraftInventoryRow) => void>(),
  deleteRow: vi.fn<(row: DraftInventoryRow) => void>(),
}));
vi.mock("@/hooks/drafts/use-draft-inventory-actions", () => ({
  useDraftInventoryActions: (hostId: string | null) => {
    actionsMock.calls.push({ hostId });
    return actionsMock;
  },
}));

beforeEach(() => {
  vi.spyOn(Analytics.getInstance(), "track").mockImplementation(() => true);
  inventoryMock.rows = [];
  inventoryMock.calls = [];
  actionsMock.calls = [];
  actionsMock.openRow.mockReset();
  actionsMock.copyRow.mockReset();
  actionsMock.deleteRow.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const noop = () => undefined;

function renderDialog(props: {
  readonly activeEpicId: string | null;
  readonly onClose: () => void;
}) {
  return render(
    <DraftsDialog
      entryPoint="menu"
      hostId="host-a"
      activeEpicId={props.activeEpicId}
      onClose={props.onClose}
    />,
  );
}

function searchBox(): HTMLElement {
  return screen.getByPlaceholderText("Search drafts");
}

function openFilter(): void {
  fireEvent.click(screen.getByRole("button", { name: "Filter drafts" }));
}

function toggle(name: string): void {
  fireEvent.click(screen.getByRole("checkbox", { name }));
}

function optionIds(): Array<string | undefined> {
  return screen
    .queryAllByRole("option")
    .map((option) => option.dataset.draftRowId);
}

describe("<DraftsDialog />", () => {
  it.each(["menu", "palette"] as const)(
    "records an empty dialog opened from %s",
    (entryPoint) => {
      const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
      render(
        <DraftsDialog
          entryPoint={entryPoint}
          hostId={null}
          activeEpicId={null}
          onClose={() => undefined}
        />,
      );
      expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftsListOpened, {
        surface: "avatar_menu",
        entry_point: entryPoint,
        draft_count: "0",
      });
    },
  );

  it("reads the landing inventory under `all`, scoped to no active draft", () => {
    renderDialog({ activeEpicId: null, onClose: noop });

    expect(inventoryMock.calls.at(-1)).toEqual({
      scope: { surface: "landing", activeDraftId: null },
      filter: "all",
    });
  });

  it("resolves the row actions against the dialog's own hostId", () => {
    render(
      <DraftsDialog
        entryPoint="menu"
        hostId="host-effective"
        activeEpicId={null}
        onClose={() => undefined}
      />,
    );

    expect(actionsMock.calls.at(-1)).toEqual({ hostId: "host-effective" });
  });

  it("puts focus in the search box on open", () => {
    inventoryMock.rows = [landingRow({ id: "d-1" })];
    renderDialog({ activeEpicId: null, onClose: noop });

    expect(document.activeElement).toBe(searchBox());
  });

  it("lists every kind, each carrying its own source chip", () => {
    inventoryMock.rows = [
      landingRow({ id: "d-landing", preview: "Ship the release notes" }),
      chatRow({ id: "d-chat", preview: "Half-written question" }),
      newChatRow({ id: "d-new-chat", preview: "A fresh agent" }),
    ];
    renderDialog({ activeEpicId: null, onClose: noop });

    expect(optionIds()).toHaveLength(3);
    const listText = document.body.textContent;
    expect(listText).toContain("Start page");
    expect(listText).toContain("Payments · Sibling chat");
    expect(listText).toContain("Billing · New agent");
  });

  it("opens the second row with Down then Enter and closes the dialog", () => {
    const first = landingRow({ id: "d-1", preview: "first" });
    const second = landingRow({ id: "d-2", preview: "second" });
    inventoryMock.rows = [first, second];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });

    fireEvent.keyDown(searchBox(), { key: "ArrowDown" });
    fireEvent.keyDown(searchBox(), { key: "Enter" });

    expect(actionsMock.openRow).toHaveBeenCalledTimes(1);
    expect(actionsMock.openRow.mock.calls[0]?.[0]).toBe(second);
    expect(actionsMock.openRow.mock.calls[0]?.[1]).toBe("keyboard");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores an Enter that confirms an IME composition", () => {
    inventoryMock.rows = [landingRow({ id: "d-1" })];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });

    fireEvent.keyDown(searchBox(), { key: "Enter", isComposing: true });
    fireEvent.keyDown(searchBox(), { key: "Enter", keyCode: 229 });

    expect(actionsMock.openRow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Tab then Enter on the filter button opens the popover and opens no draft", async () => {
    inventoryMock.rows = [landingRow({ id: "d-1" })];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });
    const user = userEvent.setup();

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Filter drafts" }),
    );
    await user.keyboard("{Enter}");

    expect(screen.getByRole("checkbox", { name: "Start pages" })).toBeTruthy();
    expect(actionsMock.openRow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Tab then Enter on a row's Copy copies it and opens no draft", async () => {
    const row = landingRow({ id: "d-1" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });
    const user = userEvent.setup();

    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Copy draft" }),
    );
    await user.keyboard("{Enter}");

    expect(actionsMock.copyRow).toHaveBeenCalledTimes(1);
    expect(actionsMock.copyRow.mock.calls[0]?.[0]).toBe(row);
    expect(actionsMock.openRow).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("filters rows by their text and their source chip, case-insensitively", () => {
    inventoryMock.rows = [
      landingRow({ id: "d-landing", preview: "Ship the release notes" }),
      chatRow({ id: "d-chat", preview: "Half-written question" }),
    ];
    renderDialog({ activeEpicId: null, onClose: noop });

    fireEvent.change(searchBox(), { target: { value: "RELEASE" } });
    expect(optionIds()).toEqual(["d-landing"]);

    fireEvent.change(searchBox(), { target: { value: "payments" } });
    expect(optionIds()).toEqual(["d-chat"]);
  });

  it("reports whether the search box held text when a row is opened, never the text", () => {
    const row = landingRow({ id: "d-1", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    renderDialog({ activeEpicId: null, onClose: noop });

    fireEvent.change(searchBox(), { target: { value: "ship" } });
    fireEvent.keyDown(searchBox(), { key: "Enter" });

    expect(actionsMock.openRow).toHaveBeenCalledWith(row, "keyboard", true);
  });

  it("filters by each checkbox", () => {
    inventoryMock.rows = [
      landingRow({ id: "d-landing", preview: "start draft" }),
      chatRow({ id: "d-here", preview: "here draft", epicId: "epic-1" }),
      chatRow({ id: "d-there", preview: "there draft", epicId: "epic-9" }),
    ];
    renderDialog({ activeEpicId: "epic-1", onClose: noop });
    openFilter();

    toggle("Start pages");
    expect(optionIds()).not.toContain("d-landing");
    expect(optionIds()).toHaveLength(2);
    toggle("Start pages");

    toggle("This task");
    expect(optionIds()).not.toContain("d-here");
    expect(optionIds()).toHaveLength(2);
    toggle("This task");

    toggle("Other tasks");
    expect(optionIds()).not.toContain("d-there");
    expect(optionIds()).toHaveLength(2);
  });

  it("offers `This task` only inside a task", () => {
    renderDialog({ activeEpicId: null, onClose: noop });
    openFilter();

    expect(screen.getByRole("checkbox", { name: "Other tasks" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Start pages" })).toBeTruthy();
    expect(screen.queryByRole("checkbox", { name: "This task" })).toBeNull();
  });

  it("shows `No drafts yet` with none at all", () => {
    renderDialog({ activeEpicId: null, onClose: noop });

    expect(screen.getByText("No drafts yet")).toBeTruthy();
  });

  it("shows `No drafts match` when the search hides everything", () => {
    inventoryMock.rows = [landingRow({ id: "d-1", preview: "Ship the notes" })];
    renderDialog({ activeEpicId: null, onClose: noop });

    fireEvent.change(searchBox(), { target: { value: "zzz" } });

    expect(screen.getByText("No drafts match")).toBeTruthy();
    expect(screen.queryByText("No drafts yet")).toBeNull();
  });

  it("shows `No drafts match` when the filter hides everything", () => {
    inventoryMock.rows = [landingRow({ id: "d-1" })];
    renderDialog({ activeEpicId: null, onClose: noop });
    openFilter();

    toggle("Start pages");

    expect(screen.getByText("No drafts match")).toBeTruthy();
  });

  it("fires drafts_filter_changed once per change, null when the box is not offered", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    renderDialog({ activeEpicId: null, onClose: noop });
    openFilter();
    trackSpy.mockClear();

    toggle("Start pages");

    expect(trackSpy).toHaveBeenCalledTimes(1);
    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftsFilterChanged, {
      surface: "avatar_menu",
      this_task: null,
      other_tasks: true,
      start_pages: false,
    });
  });

  it("reports `This task` as a boolean inside a task", () => {
    const trackSpy = vi.spyOn(Analytics.getInstance(), "track");
    renderDialog({ activeEpicId: "epic-1", onClose: noop });
    openFilter();
    trackSpy.mockClear();

    toggle("This task");

    expect(trackSpy).toHaveBeenCalledWith(AnalyticsEvent.DraftsFilterChanged, {
      surface: "avatar_menu",
      this_task: false,
      other_tasks: true,
      start_pages: true,
    });
  });

  it("opens a row by click through the caller's actions and closes the dialog", () => {
    const row = landingRow({ id: "d-landing", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });

    fireEvent.click(screen.getByRole("option"));

    expect(actionsMock.openRow).toHaveBeenCalledWith(row, "pointer", false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("copies a row through the caller's actions without closing the dialog", () => {
    const row = landingRow({ id: "d-landing", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));

    expect(actionsMock.copyRow).toHaveBeenCalledWith(row, "keyboard");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("deletes a row through the caller's actions without closing the dialog", () => {
    const row = landingRow({ id: "d-landing", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    renderDialog({ activeEpicId: null, onClose });

    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));

    expect(actionsMock.deleteRow).toHaveBeenCalledWith(row, "keyboard");
    expect(onClose).not.toHaveBeenCalled();
  });

  // Review finding 4: Cmd+S stacks the dialog above an open new-agent modal,
  // and opening a chat used to close only the dialog - leaving the modal
  // covering the chat it just opened.
  it("closes an active new-conversation request before the row's open action runs", () => {
    useNewConversationModalOpenStore.getState().open({
      epicId: "epic-1",
      tabId: "tab-1",
      placement: null,
      parentId: null,
      hostId: null,
    });
    const row = chatRow({ id: "d-chat", preview: "Half-written question" });
    inventoryMock.rows = [row];
    let requestWhenOpenRowRan: unknown = "not called";
    actionsMock.openRow.mockImplementationOnce(() => {
      requestWhenOpenRowRan =
        useNewConversationModalOpenStore.getState().request;
    });
    renderDialog({ activeEpicId: null, onClose: noop });

    fireEvent.click(screen.getByRole("option"));

    expect(requestWhenOpenRowRan).toBeNull();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  });
});
