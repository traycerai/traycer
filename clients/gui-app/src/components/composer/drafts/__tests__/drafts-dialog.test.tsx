import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { DraftsDialog } from "@/components/composer/drafts/drafts-dialog";
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
  openRow: vi.fn<(row: DraftInventoryRow) => void>(),
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
  inventoryMock.rows = [];
  inventoryMock.calls = [];
  actionsMock.calls = [];
  actionsMock.openRow.mockReset();
  actionsMock.copyRow.mockReset();
  actionsMock.deleteRow.mockReset();
});

afterEach(cleanup);

describe("<DraftsDialog />", () => {
  it("shows the empty message at zero drafts", () => {
    render(<DraftsDialog hostId="host-a" onClose={() => undefined} />);

    expect(screen.getByText("No drafts yet")).toBeTruthy();
  });

  it("reads the landing inventory under `all`, scoped to no active draft", () => {
    render(<DraftsDialog hostId="host-a" onClose={() => undefined} />);

    expect(inventoryMock.calls.at(-1)).toEqual({
      scope: { surface: "landing", activeDraftId: null },
      filter: "all",
    });
  });

  it("resolves the row actions against the dialog's own hostId", () => {
    render(<DraftsDialog hostId="host-effective" onClose={() => undefined} />);

    expect(actionsMock.calls.at(-1)).toEqual({ hostId: "host-effective" });
  });

  it("lists every kind, each carrying its own source chip", () => {
    inventoryMock.rows = [
      landingRow({ id: "d-landing", preview: "Ship the release notes" }),
      chatRow({ id: "d-chat", preview: "Half-written question" }),
      newChatRow({ id: "d-new-chat", preview: "A fresh agent" }),
    ];
    render(<DraftsDialog hostId="host-a" onClose={() => undefined} />);

    expect(screen.queryByText("No drafts yet")).toBeNull();
    expect(document.querySelectorAll("li")).toHaveLength(3);
    const listText = document.body.textContent;
    expect(listText).toContain("Start page");
    expect(listText).toContain("Payments · Sibling chat");
    expect(listText).toContain("Billing · New agent");
  });

  it("opens a row through the caller's actions and closes the dialog", () => {
    const row = landingRow({ id: "d-landing", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    render(<DraftsDialog hostId="host-a" onClose={onClose} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Open draft: Ship the notes" }),
    );

    expect(actionsMock.openRow).toHaveBeenCalledWith(row);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("copies a row through the caller's actions without closing the dialog", () => {
    const row = landingRow({ id: "d-landing", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    render(<DraftsDialog hostId="host-a" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));

    expect(actionsMock.copyRow).toHaveBeenCalledWith(row);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("deletes a row through the caller's actions without closing the dialog", () => {
    const row = landingRow({ id: "d-landing", preview: "Ship the notes" });
    inventoryMock.rows = [row];
    const onClose = vi.fn();
    render(<DraftsDialog hostId="host-a" onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete draft" }));

    expect(actionsMock.deleteRow).toHaveBeenCalledWith(row);
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
      requestWhenOpenRowRan = useNewConversationModalOpenStore.getState().request;
    });
    render(<DraftsDialog hostId="host-a" onClose={() => undefined} />);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Open draft: Half-written question",
      }),
    );

    expect(requestWhenOpenRowRan).toBeNull();
    expect(useNewConversationModalOpenStore.getState().request).toBeNull();
  });
});
