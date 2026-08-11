import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";
import { ImagePreview, type ImagePreviewFit } from "../image-preview";

const META: ImageAssetMeta = {
  mediaType: "image/png",
  sizeBytes: 10,
  width: 4,
  height: 3,
};

function preview(props: {
  readonly fitOverride: ImagePreviewFit | null;
  readonly onFitOverrideChange: ((fit: ImagePreviewFit) => void) | null;
  readonly scrollContainerRef?:
    ((element: HTMLDivElement | null) => void) | null;
  readonly onScroll?: ((event: React.UIEvent<HTMLDivElement>) => void) | null;
}) {
  return render(
    <ImagePreview
      status="ready"
      url="blob:image"
      meta={META}
      fileName="photo.png"
      compact={false}
      fitOverride={props.fitOverride}
      onFitOverrideChange={props.onFitOverrideChange}
      scrollContainerRef={props.scrollContainerRef ?? null}
      onScroll={props.onScroll ?? null}
      onDecodeError={null}
    />,
  );
}

afterEach(() => {
  cleanup();
});

describe("<ImagePreview /> controlled fit and scroll props", () => {
  it("keeps the existing internal fit state when fitOverride is null", () => {
    preview({ fitOverride: null, onFitOverrideChange: null });

    const imageButton = screen.getByRole("button", { name: "Zoom to 100%" });
    fireEvent.click(imageButton);

    expect(screen.getByRole("button", { name: "Zoom to fit" })).toBeTruthy();
    expect(imageButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses the external fit value and callback when controlled", () => {
    const onFitOverrideChange = vi.fn();
    preview({ fitOverride: "fit", onFitOverrideChange });

    fireEvent.click(screen.getByRole("button", { name: "Zoom to 100%" }));

    expect(onFitOverrideChange).toHaveBeenCalledWith("actual");
    expect(screen.getByRole("button", { name: "Zoom to 100%" })).toBeTruthy();
  });

  it("allows the caller to freeze a controlled fit with a null callback", () => {
    preview({ fitOverride: "fit", onFitOverrideChange: null });

    const imageButton = screen.getByRole("button", { name: "Zoom to 100%" });
    fireEvent.click(imageButton);

    expect(screen.getByRole("button", { name: "Zoom to 100%" })).toBeTruthy();
    expect(imageButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("forwards the callback ref and scroll event", () => {
    const scrollContainerRef = vi.fn();
    const onScroll = vi.fn();

    preview({
      fitOverride: null,
      onFitOverrideChange: null,
      scrollContainerRef,
      onScroll,
    });

    const stage = document.querySelector<HTMLDivElement>(
      ".image-preview-checkerboard",
    );
    if (stage === null) throw new Error("missing image preview stage");

    expect(scrollContainerRef).toHaveBeenCalledWith(stage);
    fireEvent.scroll(stage);
    expect(onScroll).toHaveBeenCalledTimes(1);
    expect(onScroll).toHaveBeenCalledWith(
      expect.objectContaining({ target: stage }),
    );
  });
});
