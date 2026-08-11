import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";
import { ImagePreview } from "../image-preview";

const IMAGE_WIDTH = 640;
const IMAGE_HEIGHT = 480;

const META: ImageAssetMeta = {
  mediaType: "image/png",
  sizeBytes: 2048,
  width: IMAGE_WIDTH,
  height: IMAGE_HEIGHT,
};

function renderPreview(
  status: "loading" | "header" | "ready",
  meta: ImageAssetMeta | null,
  compact: boolean,
) {
  return render(
    <ImagePreview
      status={status}
      url={status === "ready" ? "blob:image" : null}
      meta={meta}
      fileName="photo.png"
      compact={compact}
      fitOverride={null}
      onFitOverrideChange={null}
      scrollContainerRef={null}
      onScroll={null}
      onDecodeError={null}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("<ImagePreview />", () => {
  it("shows an aspect-ratio skeleton from known header dimensions", () => {
    renderPreview("header", META, false);

    const skeleton = screen.getByTestId("image-preview-skeleton");
    expect(skeleton.style.aspectRatio).toContain(
      String(IMAGE_WIDTH / IMAGE_HEIGHT),
    );
    expect(skeleton.style.width).toBe("100%");
    expect(screen.getByText("640x480 · 2.0 KB")).toBeTruthy();
  });

  it("does not render a skeleton when header dimensions are unknown", () => {
    renderPreview("header", { ...META, width: null, height: null }, false);

    expect(screen.queryByTestId("image-preview-skeleton")).toBeNull();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
  });

  it("shows the loading spinner before the header arrives", () => {
    const { container } = renderPreview("loading", null, false);

    expect(
      container.querySelector(
        '.image-preview-checkerboard [aria-hidden="true"]',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("image-preview-skeleton")).toBeNull();
  });

  it("toggles fit/actual state from both controls and the image", () => {
    renderPreview("ready", META, false);

    const toolbar = screen.getByRole("toolbar", {
      name: "Image preview controls",
    });
    const zoomControl = within(toolbar).getAllByRole("button")[0];
    const imageButton = screen.getByRole("button", { name: "Zoom to 100%" });

    expect(zoomControl.getAttribute("aria-pressed")).toBe("false");
    expect(imageButton.getAttribute("aria-pressed")).toBe("false");
    expect(imageButton.className).toContain("cursor-zoom-in");

    fireEvent.click(zoomControl);

    expect(zoomControl.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("button", { name: "Zoom to fit" }).className,
    ).toContain("cursor-zoom-out");

    fireEvent.click(screen.getByRole("button", { name: "Zoom to fit" }));

    expect(
      screen
        .getByRole("button", { name: "Zoom to 100%" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("omits the controls toolbar in compact mode", () => {
    renderPreview("header", META, true);

    expect(
      screen.queryByRole("toolbar", { name: "Image preview controls" }),
    ).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("640x480 · 2.0 KB")).toBeTruthy();
  });
});
