import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

// The live tile icon is covered by the tab-strip tests; stub it here so this
// test targets the bar's own composition (title, rename gating).
vi.mock("@/components/epic-canvas/canvas/tab-strip", () => ({
  TabIcon: () => <span data-testid="tab-icon" />,
  TabStrip: () => null,
}));

const holder = vi.hoisted(() => ({ role: "owner" }));

vi.mock("@/lib/epic-selectors", () => ({
  useEpicTabDisplayTitle: (node: { readonly name: string }) => node.name,
  useEpicLiveArtifactTitleGenerating: () => false,
  useEpicPermissionRole: () => holder.role,
}));

vi.mock("@/hooks/host/use-host-client-for-host-id", () => ({
  useHostClientForHostId: () => null,
}));

const mutateSpies = vi.hoisted(() => ({
  renameChat: vi.fn(),
  renameTuiAgent: vi.fn(),
  renameArtifact: vi.fn(),
  renameTerminal: vi.fn(),
}));

// `useSwitcherRename` maps kind -> mutation hook; mocking the mutation hooks
// (rather than the mapping itself) exercises the real mapping in
// `use-switcher-rename.ts`.
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({
    mutate: mutateSpies.renameChat,
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({
    mutate: mutateSpies.renameTuiAgent,
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicRenameArtifact: () => ({
    mutate: mutateSpies.renameArtifact,
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-session-host-client", () => ({
  useEpicSessionHostClient: () => null,
}));
vi.mock("@/hooks/terminal/use-terminal-rename-for-mutation", () => ({
  useTerminalRenameFor: () => ({
    mutate: mutateSpies.renameTerminal,
    isPending: false,
  }),
}));

const SPEC_TILE: EpicCanvasTileRef = {
  id: "spec-1",
  instanceId: "inst-1",
  type: "spec",
  name: "Life Philosophy",
  hostId: "host-A",
};

const CHAT_TILE: EpicCanvasTileRef = {
  id: "chat-1",
  instanceId: "inst-2",
  type: "chat",
  name: "Chat title",
  hostId: "host-A",
};

const FILE_TILE: EpicCanvasTileRef = {
  id: "file-1",
  instanceId: "inst-3",
  type: "workspace-file",
  name: "index.ts",
  hostId: "host-A",
  workspacePath: "/ws",
  filePath: "index.ts",
};

function openEdit(): HTMLElement {
  fireEvent.click(screen.getByTestId("mobile-current-tile-title"));
  return screen.getByTestId("mobile-current-tile-title-input");
}

describe("<MobileCurrentTileBar />", () => {
  beforeEach(() => {
    holder.role = "owner";
    mutateSpies.renameChat.mockClear();
    mutateSpies.renameTuiAgent.mockClear();
    mutateSpies.renameArtifact.mockClear();
    mutateSpies.renameTerminal.mockClear();
  });
  afterEach(cleanup);

  it("shows the current tile title and icon", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={SPEC_TILE} />);
    const bar = screen.getByTestId("mobile-current-tile-bar");
    expect(bar.textContent).toContain("Life Philosophy");
    expect(screen.getByTestId("tab-icon")).not.toBeNull();
  });

  it("renders the title as an editable control for a renameable kind and an editor role", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    expect(screen.getByTestId("mobile-current-tile-title").tagName).toBe(
      "BUTTON",
    );
  });

  it("commits an edited title through the rename mutation, keyed to the tile kind", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "New title" } });
    fireEvent.blur(input);
    expect(mutateSpies.renameChat).toHaveBeenCalledTimes(1);
    expect(mutateSpies.renameChat).toHaveBeenCalledWith({
      epicId: "epic-1",
      chatId: "chat-1",
      title: "New title",
    });
    expect(mutateSpies.renameTuiAgent).not.toHaveBeenCalled();
    expect(mutateSpies.renameArtifact).not.toHaveBeenCalled();
    expect(mutateSpies.renameTerminal).not.toHaveBeenCalled();
  });

  it("Escape restores the previous title and does not commit", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "Discarded" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(mutateSpies.renameChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
      "Chat title",
    );
  });

  it("empty/whitespace commit does not call the mutation and keeps the previous title", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    const input = openEdit();
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);
    expect(mutateSpies.renameChat).not.toHaveBeenCalled();
    expect(screen.getByTestId("mobile-current-tile-title").textContent).toBe(
      "Chat title",
    );
  });

  it("renders plain text with no editable control for a non-renameable tile kind", () => {
    render(<MobileCurrentTileBar epicId="epic-1" tile={FILE_TILE} />);
    const title = screen.getByTestId("mobile-current-tile-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-current-tile-title-input")).toBeNull();
  });

  it("renders plain text for a viewer role even on a renameable kind", () => {
    holder.role = "viewer";
    render(<MobileCurrentTileBar epicId="epic-1" tile={CHAT_TILE} />);
    const title = screen.getByTestId("mobile-current-tile-title");
    expect(title.tagName).toBe("SPAN");
    expect(screen.queryByTestId("mobile-current-tile-title-input")).toBeNull();
  });
});
