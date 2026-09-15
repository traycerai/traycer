import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

import { ComposerToolbarLeft } from "@/components/home/toolbar/composer-toolbar-left";
import type { PermissionMode } from "@/components/home/data/landing-options";

describe("<ComposerToolbarLeft />", () => {
  afterEach(() => {
    cleanup();
  });

  it("opens an images-only file picker from the attachment button", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    const { container } = renderToolbar(onAttachImages, false, () => undefined);
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
    const { container } = renderToolbar(onAttachImages, false, () => undefined);
    const input = getImageInput(container);
    const imageFile = new File(["image-bytes"], "screenshot.png", {
      type: "image/png",
    });

    fireEvent.change(input, { target: { files: [imageFile] } });

    expect(onAttachImages).toHaveBeenCalledTimes(1);
    const call = onAttachImages.mock.calls[0];
    expect(call[0]).toEqual([imageFile]);
  });

  it("locks the permission picker while settings are locked", () => {
    const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
    const onPermissionChange = vi.fn<(next: PermissionMode) => void>();
    renderToolbar(onAttachImages, true, onPermissionChange);

    expect(screen.getByRole("button", { name: "Supervised" })).toHaveProperty(
      "disabled",
      true,
    );

    fireEvent.click(screen.getByRole("button", { name: "Supervised" }));

    expect(onPermissionChange).not.toHaveBeenCalled();
  });

  it("renders the Auto option and disables it with the unsupported copy on a host whose row lacks it", () => {
    render(
      <TooltipProvider>
        <ComposerToolbarLeft
          onAttachImages={vi.fn<(files: ReadonlyArray<File>) => void>()}
          permission="supervised"
          onPermissionChange={vi.fn<(next: PermissionMode) => void>()}
          supportedPermissionModes={[
            "supervised",
            "auto_accept_edits",
            "full_access",
          ]}
          harnessLabel="Cursor"
          // `null` catalog is what keeps this case about the PROVIDER: the
          // union is unknown, so the copy blames Cursor rather than the host.
          // The host-blaming branch has its own coverage in
          // `pickers/__tests__/permissions-picker.test.tsx`.
          catalogSupportedModes={null}
          turnActive={false}
          judgeBilling={null}
          showNextTurnPermissionNote={false}
          settingsLocked={false}
        />
      </TooltipProvider>,
    );

    fireEvent.pointerDown(screen.getByRole("button", { name: "Supervised" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    // Auto is the only mode this row omits, so the "Not supported by" copy
    // appears exactly once - scoped through it rather than an accessible-name
    // match, since "Auto" is a substring of "Auto-accept edits" too.
    const unsupportedCopy = screen.getByText("Not supported by Cursor.");
    const auto = unsupportedCopy.closest('[role="menuitemradio"]');
    if (auto === null) throw new Error("expected the Auto menu item");
    expect(auto.getAttribute("aria-disabled")).toBe("true");
    expect(auto.textContent).toContain("Auto");
  });
});

function renderToolbar(
  onAttachImages: (files: ReadonlyArray<File>) => void,
  settingsLocked: boolean,
  onPermissionChange: (next: PermissionMode) => void,
) {
  return render(
    <TooltipProvider>
      <ComposerToolbarLeft
        onAttachImages={onAttachImages}
        permission="supervised"
        onPermissionChange={onPermissionChange}
        supportedPermissionModes={null}
        harnessLabel={null}
        // Today's-behaviour values: no catalog to union, no turn in flight and
        // no host whose judge this fixture could name, so the picker renders
        // exactly what it rendered before these three props existed.
        catalogSupportedModes={null}
        turnActive={false}
        judgeBilling={null}
        showNextTurnPermissionNote={false}
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
