import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useNewConversationModalStore } from "@/stores/epics/new-conversation-modal-store";
import { useNewConversationModalOpenStore } from "@/stores/epics/new-conversation-modal-open-store";

const { NewConversationModalAction, NewConversationModalHeader } =
  await import("../new-conversation-modal");

afterEach(() => {
  cleanup();
  useNewConversationModalStore.getState().resetForTests();
  useNewConversationModalOpenStore.getState().close();
});

describe("<NewConversationModalAction />", () => {
  it("preserves the remembered terminal interface when opening the modal", () => {
    useNewConversationModalStore
      .getState()
      .setComposerMode("epic-1", "terminal");

    render(
      <NewConversationModalAction
        epicId="epic-1"
        tabId="tab-1"
        parentId={null}
        size="icon-sm"
        disabled={false}
        disabledTooltip={null}
        triggerLabel="New agent"
        triggerTestId="new-agent"
        actionRevealClassName=""
        onBeforeOpen={undefined}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "New agent" }));

    expect(
      useNewConversationModalStore.getState().draftPatchesByEpicId["epic-1"]
        ?.composerMode,
    ).toBe("terminal");
    expect(useNewConversationModalOpenStore.getState().request).toMatchObject({
      epicId: "epic-1",
      tabId: "tab-1",
    });
  });
});

describe("<NewConversationModalHeader />", () => {
  it("places the interface switcher on the left below the title", () => {
    const { container } = render(
      <NewConversationModalHeader
        switcher={<button type="button">Switch to Terminal</button>}
      />,
    );

    expect(screen.getByText("Start a new agent")).not.toBeNull();
    expect(screen.queryByText(/interface/i)).toBeNull();
    expect(
      screen.getByRole("button", { name: "Switch to Terminal" }),
    ).not.toBeNull();
    expect(container.firstElementChild?.classList).toContain("flex-col");
    expect(container.firstElementChild?.classList).toContain("items-start");
  });
});
