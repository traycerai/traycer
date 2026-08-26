import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SwitcherNewArtifactMenu,
  SwitcherNewChatRow,
  SwitcherNewTerminalRow,
} from "@/components/epic-canvas/mobile/switcher-create-actions";

const spies = vi.hoisted(() => ({
  setComposerMode: vi.fn(),
  openModal: vi.fn(),
  createArtifact: vi.fn(),
}));

vi.mock("@/stores/epics/new-conversation-modal-store", () => ({
  useNewConversationModalStore: {
    getState: () => ({ setComposerMode: spies.setComposerMode }),
  },
}));
vi.mock("@/stores/epics/new-conversation-modal-open-store", () => ({
  useNewConversationModalOpenStore: {
    getState: () => ({ open: spies.openModal }),
  },
}));
vi.mock("@/components/epic-canvas/mobile/use-switcher-create-artifact", () => ({
  useSwitcherCreateArtifact: () => ({
    create: spies.createArtifact,
    isPending: false,
  }),
}));
// The dialog shell pulls the desktop host/folder picker body (heavy: host
// queries, workspace search); stub it so this suite targets the row's own
// wiring - whether it renders `open`, and that launching reaches `onLaunched`.
vi.mock("@/components/epic-canvas/mobile/mobile-new-terminal-dialog", () => ({
  MobileNewTerminalDialog: (props: {
    readonly open: boolean;
    readonly onLaunched: () => void;
  }) =>
    props.open ? (
      <button
        type="button"
        data-testid="mobile-epic-new-terminal-dialog"
        onClick={props.onLaunched}
      />
    ) : null,
}));

beforeEach(() => {
  spies.setComposerMode.mockClear();
  spies.openModal.mockClear();
  spies.createArtifact.mockClear();
});
afterEach(cleanup);

describe("<SwitcherNewChatRow />", () => {
  it("sets chat composer mode, opens the New Conversation modal for this epic/tab, and closes the sheet", () => {
    const onClose = vi.fn();
    render(
      <SwitcherNewChatRow epicId="epic-1" tabId="tab-1" onClose={onClose} />,
    );
    fireEvent.click(screen.getByTestId("switcher-new-chat"));
    expect(spies.setComposerMode).toHaveBeenCalledWith("epic-1", "chat");
    expect(spies.openModal).toHaveBeenCalledWith(
      expect.objectContaining({
        epicId: "epic-1",
        tabId: "tab-1",
        parentId: null,
      }),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("<SwitcherNewTerminalRow />", () => {
  it("renders the terminal picker dialog only after its row is tapped, and launching it closes the sheet", () => {
    const onClose = vi.fn();
    render(
      <SwitcherNewTerminalRow
        epicId="epic-1"
        tabId="tab-1"
        onClose={onClose}
      />,
    );
    expect(screen.queryByTestId("mobile-epic-new-terminal-dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("switcher-new-terminal"));
    const dialog = screen.getByTestId("mobile-epic-new-terminal-dialog");
    expect(dialog).toBeTruthy();
    // `onLaunched` is wired straight to `onClose`: firing it from the dialog
    // reaches the sheet's close call.
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("<SwitcherNewArtifactMenu />", () => {
  it("creates the chosen artifact kind through the shared create hook", () => {
    render(
      <SwitcherNewArtifactMenu
        epicId="epic-1"
        tabId="tab-1"
        onClose={() => {}}
      />,
    );
    fireEvent.pointerDown(screen.getByTestId("switcher-new-artifact"));
    fireEvent.click(screen.getByTestId("switcher-new-artifact-spec"));
    expect(spies.createArtifact).toHaveBeenCalledWith("spec");
  });
});
