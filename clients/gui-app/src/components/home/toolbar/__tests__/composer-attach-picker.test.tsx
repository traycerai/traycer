/**
 * The task composer's Attach control, `ComposerAttachImageButton`: its Layout
 * region, its re-pick and its split of a pick between images and other files.
 * That its input takes any file is held by `composer-toolbar-left.test.tsx`.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerAttachImageButton } from "@/components/home/toolbar/composer-attach-image-button";
import {
  DEFAULT_LAYOUT_SNAPSHOT,
  useLayoutStore,
} from "@/stores/layout/layout-store";

const onAttachImages = vi.fn<(files: ReadonlyArray<File>) => void>();
const onAttachFiles = vi.fn<(files: ReadonlyArray<File>) => void>();

function renderButton(): HTMLElement {
  return render(
    <ComposerAttachImageButton
      onAttachImages={onAttachImages}
      onAttachFiles={onAttachFiles}
    />,
  ).container;
}

function pickerInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (input === null) throw new Error("the control has no file input");
  return input;
}

function file(name: string, type: string): File {
  return new File(["bytes"], name, { type });
}

beforeEach(() => {
  useLayoutStore.setState({ ...DEFAULT_LAYOUT_SNAPSHOT });
});

afterEach(() => {
  cleanup();
  onAttachImages.mockReset();
  onAttachFiles.mockReset();
});

describe("<ComposerAttachImageButton />", () => {
  it("is the Layout region attachImage, and Layout hiding it removes the control with its file input", () => {
    const container = renderButton();
    expect(
      screen
        .getByRole("button", { name: "Attach" })
        .getAttribute("data-layout-region"),
    ).toBe("attachImage");

    act(() => {
      useLayoutStore
        .getState()
        .setRegionValues("attachImage", { shown: "hidden" });
    });

    expect(screen.queryByRole("button", { name: "Attach" })).toBeNull();
    expect(container.querySelector('input[type="file"]')).toBeNull();
  });

  it("fires again when the same file is picked again", async () => {
    const user = userEvent.setup();
    const input = pickerInput(renderButton());
    const shot = file("shot.png", "image/png");

    await user.upload(input, shot);
    await user.upload(input, shot);

    expect(onAttachImages).toHaveBeenCalledTimes(2);
  });

  it("splits a mixed pick: images to the image route, the rest to the file route, each in pick order", async () => {
    const user = userEvent.setup();
    const input = pickerInput(renderButton());
    const first = file("first.png", "image/png");
    const notes = file("notes.pdf", "application/pdf");
    const second = file("second.jpg", "image/jpeg");
    const data = file("data.csv", "text/csv");

    await user.upload(input, [first, notes, second, data]);

    expect(onAttachImages).toHaveBeenCalledTimes(1);
    expect(onAttachImages).toHaveBeenCalledWith([first, second]);
    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(onAttachFiles).toHaveBeenCalledWith([notes, data]);
  });
});
