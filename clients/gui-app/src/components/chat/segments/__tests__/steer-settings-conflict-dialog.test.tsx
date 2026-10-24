import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SteerSettingsConflictDialog } from "@/components/chat/segments/steer-settings-conflict-dialog";

const onOpenChange = vi.fn();
const onRestart = vi.fn();

function renderDialog() {
  render(
    <SteerSettingsConflictDialog
      open
      onOpenChange={onOpenChange}
      onRestart={onRestart}
      reasons={["settings"]}
      changed={["model"]}
    />,
  );
}

describe("<SteerSettingsConflictDialog /> reasons", () => {
  afterEach(() => {
    cleanup();
  });

  it("names every reason the turn would end for", () => {
    render(
      <SteerSettingsConflictDialog
        open
        onOpenChange={onOpenChange}
        onRestart={onRestart}
        reasons={["harness", "settings", "images", "slash_command", "skills"]}
        changed={[]}
      />,
    );

    expect(screen.getByRole("dialog").textContent).toContain(
      [
        "This agent can't take a message while its turn is running.",
        "This message uses different settings.",
        "This agent can't take images while its turn is running.",
        "A slash command can't run inside a turn that is already running.",
        "A skill can't be added to a turn that is already running.",
        "Sending it now will end the current turn and start a new one with this message.",
      ].join(" "),
    );
  });

  it("keeps the settings wording for a settings change alone", () => {
    renderDialog();

    expect(
      screen.getByText("End the current turn to send with new settings?"),
    ).toBeDefined();
    expect(screen.getByRole("dialog").textContent).toContain(
      "The current turn is running with different model.",
    );
  });
});

describe("<SteerSettingsConflictDialog /> keyboard navigation", () => {
  beforeEach(() => {
    onOpenChange.mockReset();
    onRestart.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("confirms end turn and send with Enter", () => {
    renderDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("also confirms with the originating Cmd+Enter chord", () => {
    renderDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      metaKey: true,
    });

    expect(onRestart).toHaveBeenCalledTimes(1);
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores held-key Enter repeats", () => {
    renderDialog();

    fireEvent.keyDown(screen.getByRole("dialog"), {
      key: "Enter",
      repeat: true,
    });

    expect(onRestart).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores Enter while an IME composition is active", () => {
    renderDialog();

    screen.getByRole("dialog").dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      }),
    );

    expect(onRestart).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("keeps both actions reachable by keyboard and Escape cancels", async () => {
    const user = userEvent.setup();
    renderDialog();

    const cancel = screen.getByRole("button", { name: /cancel/i });
    const confirm = screen.getByRole("button", {
      name: /end turn & send/i,
    });

    expect(document.activeElement).toBe(cancel);
    await user.tab();
    expect(document.activeElement).toBe(confirm);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(cancel);

    await user.keyboard("{Escape}");
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onRestart).not.toHaveBeenCalled();
  });
});
