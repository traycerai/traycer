import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SwitcherNewAgentButton,
  SwitcherNewArtifactMenu,
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

beforeEach(() => {
  spies.setComposerMode.mockClear();
  spies.openModal.mockClear();
  spies.createArtifact.mockClear();
});
afterEach(cleanup);

describe("<SwitcherNewAgentButton />", () => {
  it("opens the New Conversation modal (chat mode, active-tile placement) and closes the sheet", () => {
    const onClose = vi.fn();
    render(
      <SwitcherNewAgentButton
        epicId="epic-1"
        tabId="tab-1"
        onClose={onClose}
      />,
    );
    fireEvent.click(screen.getByTestId("switcher-new-agent"));
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
