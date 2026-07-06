import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ComposerToolbarLeft } from "@/components/home/toolbar/composer-toolbar-left";
import type {
  AgentMode,
  PermissionMode,
} from "@/components/home/data/landing-options";

describe("<ComposerToolbarLeft />", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens an images-only file picker from the attachment button", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    const { container } = renderToolbar(
      onAttachImages,
      false,
      () => undefined,
      () => undefined,
    );
    const input = getImageInput(container);
    const clickSpy = vi.spyOn(input, "click").mockImplementation(() => {
      return undefined;
    });

    fireEvent.click(screen.getByRole("button", { name: "Attach image" }));

    expect(input.getAttribute("accept")).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it("passes selected image files to the attachment pipeline", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    const { container } = renderToolbar(
      onAttachImages,
      false,
      () => undefined,
      () => undefined,
    );
    const input = getImageInput(container);
    const imageFile = new File(["image-bytes"], "screenshot.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [imageFile] } });

    expect(onAttachImages).toHaveBeenCalledTimes(1);
    const call = onAttachImages.mock.calls[0];
    expect(call[0]).toEqual([imageFile]);
  });

  it("locks permission and agent mode pickers while settings are locked", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    const onPermissionChange = vi.fn<(next: PermissionMode) => void>();
    const onAgentModeChange = vi.fn<(next: AgentMode) => void>();
    renderToolbar(onAttachImages, true, onPermissionChange, onAgentModeChange);

    expect(screen.getByRole("button", { name: "Supervised" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(
      screen.getByRole("button", { name: "Switch to Epic Mode" }),
    ).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: "Supervised" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Epic Mode" }),
    );

    expect(onPermissionChange).not.toHaveBeenCalled();
    expect(onAgentModeChange).not.toHaveBeenCalled();
  });
});

function renderToolbar(
  onAttachImages: (files: ReadonlyArray<File>) => void,
  settingsLocked: boolean,
  onPermissionChange: (next: PermissionMode) => void,
  onAgentModeChange: (next: AgentMode) => void,
) {
  return render(
    <TooltipProvider>
      <ComposerToolbarLeft
        onAttachImages={onAttachImages}
        agentMode="regular"
        onAgentModeChange={onAgentModeChange}
        permission="supervised"
        onPermissionChange={onPermissionChange}
        supportedPermissionModes={null}
        harnessLabel={null}
        showNextTurnPermissionNote={false}
        showAgentModeTooltip={false}
        settingsLocked={settingsLocked}
      />
    </TooltipProvider>,
  );
}

function getImageInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("expected image file input");
  return input;
}
