import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SwitcherNewArtifactMenu,
  SwitcherNewChatAction,
  SwitcherNewTerminalRow,
} from "@/components/epic-canvas/mobile/switcher-create-actions";

const spies = vi.hoisted(() => ({
  createArtifact: vi.fn(),
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
  spies.createArtifact.mockClear();
});
afterEach(cleanup);

describe("<SwitcherNewChatAction />", () => {
  it("calls onSelect when tapped", () => {
    const onSelect = vi.fn();
    render(<SwitcherNewChatAction onSelect={onSelect} isPending={false} />);
    fireEvent.click(screen.getByTestId("switcher-new-chat"));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("switcher-new-chat-pending")).toBeNull();
  });

  it("is disabled and shows a spinner while a create is pending", () => {
    const onSelect = vi.fn();
    render(<SwitcherNewChatAction onSelect={onSelect} isPending />);
    const button = screen.getByTestId("switcher-new-chat");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByTestId("switcher-new-chat-pending")).not.toBeNull();
    fireEvent.click(button);
    expect(onSelect).not.toHaveBeenCalled();
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
