import "../../../../__tests__/test-browser-apis";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { MobileCurrentTileBar } from "@/components/epic-canvas/mobile/mobile-current-tile-bar";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
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

const mocks = vi.hoisted(() => ({
  handle: { current: null as OpenEpicStoreHandle | null },
}));

const mutateSpies = vi.hoisted(() => ({
  renameChat: vi.fn(),
  renameTuiAgent: vi.fn(),
  renameArtifact: vi.fn(),
  renameTerminal: vi.fn(),
}));

function makeMutateAsync<TVariables>(
  spy: (variables: TVariables) => void,
): (variables: TVariables) => Promise<void> {
  return (variables: TVariables) => {
    spy(variables);
    return Promise.resolve();
  };
}

// `useSwitcherRename` (the hook this bar's title delegates rename commits to)
// now reads a REAL session handle for the optimistic overlay
// (`beginRenameMutation` / `retirePendingMutation`), so it is backed by a real
// `createOpenEpicStore` session rather than a fake shape. The mutation hooks
// stay mocked (rather than the `useSwitcherRename` mapping itself), which
// exercises the real kind -> mutation mapping in `use-switcher-rename.ts`.
vi.mock("@/providers/use-open-epic-handle", () => ({
  useOpenEpicHandle: () => {
    if (mocks.handle.current === null) throw new Error("no handle seeded");
    return mocks.handle.current;
  },
}));
vi.mock("@/hooks/epic/use-epic-chat-mutations", () => ({
  useEpicRenameChat: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameChat),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-tui-agent-mutations", () => ({
  useEpicRenameTuiAgent: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameTuiAgent),
    isPending: false,
  }),
}));
vi.mock("@/hooks/epic/use-epic-node-mutations", () => ({
  useEpicRenameArtifact: () => ({
    mutateAsync: makeMutateAsync(mutateSpies.renameArtifact),
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

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-1",
      title: "Epic test",
      initialUserPrompt: "",
      ticketCount: 0,
      specCount: 0,
      storyCount: 0,
      reviewCount: 0,
      status: "open",
      createdAt: 0,
      updatedAt: 0,
      createdBy: "u",
      version: "1",
    },
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

/** A live session for "epic-1" - no nodes seeded, since these tests only
 * assert on the RPC call args, and `useSwitcherRename` fires the RPC
 * regardless of whether `beginRenameMutation` finds a row to overlay. */
function newSession(): OpenEpicStoreHandle {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = createOpenEpicStore({
    epicId: "epic-1",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

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
    mocks.handle.current = newSession();
  });
  afterEach(() => {
    cleanup();
    mocks.handle.current?.dispose();
    mocks.handle.current = null;
  });

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
