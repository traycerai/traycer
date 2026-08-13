import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { ImageAssetMeta } from "@/hooks/assets/use-image-asset";
import { DEFAULT_ANIMATION_MS, ImagePreview } from "../image-preview";

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
  servedFromCache: boolean,
) {
  return render(
    <ImagePreview
      status={status}
      url={status === "ready" ? "blob:image" : null}
      meta={meta}
      servedFromCache={servedFromCache}
      fileName="photo.png"
      compact={compact}
      gesturesEnabled
      animationMs={DEFAULT_ANIMATION_MS}
      transformRef={null}
      onTransformChange={null}
      doubleClickOverride={null}
      onDecodeError={null}
    />,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("<ImagePreview />", () => {
  it("shows an aspect-ratio skeleton from known header dimensions", () => {
    renderPreview("header", META, false, false);

    const skeleton = screen.getByTestId("image-preview-skeleton");
    expect(skeleton.style.aspectRatio).toContain(
      String(IMAGE_WIDTH / IMAGE_HEIGHT),
    );
    expect(skeleton.style.width).toBe("100%");
    expect(screen.getByText("640x480 · 2.0 KB")).toBeTruthy();
  });

  it("does not render a skeleton when header dimensions are unknown", () => {
    renderPreview(
      "header",
      { ...META, width: null, height: null },
      false,
      false,
    );

    expect(screen.queryByTestId("image-preview-skeleton")).toBeNull();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
  });

  it("shows the loading spinner before the header arrives", () => {
    const { container } = renderPreview("loading", null, false, false);

    expect(
      container.querySelector(
        '.image-preview-checkerboard [aria-hidden="true"]',
      ),
    ).toBeTruthy();
    expect(screen.queryByTestId("image-preview-skeleton")).toBeNull();
  });

  // Supersedes decisions #16/#17's click-to-toggle interaction (ticket 07):
  // the <button>-wrapped image and its cursor-zoom-in/out classes are gone,
  // replaced by a continuous pan/zoom transform driven from the toolbar
  // (plus gestures - covered separately, see the Luna-delegated transform
  // suite). This pins the toolbar's initial static state and the removal
  // of the old click affordance; deep transform-state assertions (actually
  // clicking Fit/Actual and observing the resulting scale) need
  // `react-zoom-pan-pinch` mocked for deterministic jsdom behavior and are
  // left to that suite rather than guessed at here.
  it("renders fit/zoom toolbar controls with fit active by default, and drops the old click-to-toggle image button", () => {
    renderPreview("ready", META, false, false);

    const toolbar = screen.getByRole("toolbar", {
      name: "Image preview controls",
    });
    expect(
      within(toolbar).getByRole("button", { name: "Zoom out" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: "Fit to screen" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: "Actual size" }),
    ).toBeTruthy();
    expect(
      within(toolbar).getByRole("button", { name: "Zoom in" }),
    ).toBeTruthy();

    expect(
      within(toolbar)
        .getByRole("button", { name: "Fit to screen" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      within(toolbar)
        .getByRole("button", { name: "Actual size" })
        .getAttribute("aria-pressed"),
    ).toBe("false");

    expect(screen.queryByRole("button", { name: "Zoom to 100%" })).toBeNull();
    expect(document.querySelector(".cursor-zoom-in")).toBeNull();
    expect(document.querySelector(".cursor-zoom-out")).toBeNull();
  });

  it("omits the controls toolbar in compact mode", () => {
    renderPreview("header", META, true, false);

    expect(
      screen.queryByRole("toolbar", { name: "Image preview controls" }),
    ).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("640x480 · 2.0 KB")).toBeTruthy();
  });

  it("skips the entrance fade for cache hits but keeps it for streamed images", () => {
    renderPreview("ready", META, false, true);

    const cachedImage = screen.getByRole("img", { name: "photo.png" });
    expect(cachedImage.className).toContain("opacity-100");

    cleanup();
    renderPreview("ready", META, false, false);

    const streamedImage = screen.getByRole("img", { name: "photo.png" });
    expect(streamedImage.className).toContain("opacity-0");

    fireEvent.load(streamedImage);
    expect(streamedImage.className).toContain("opacity-100");
  });

  it("commits cache-hit opacity-100 before any opacity-0 class is assigned", () => {
    const classNameSetter = vi.spyOn(Element.prototype, "className", "set");
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");

    renderPreview("ready", META, false, true);

    const imageClasses = [
      ...classNameSetter.mock.calls.map(([value]) => String(value)),
      ...setAttribute.mock.calls
        .filter(([name]) => name === "class")
        .map(([, value]) => String(value)),
    ].filter((value) => value.includes("image-preview-outline"));

    expect(imageClasses.length).toBeGreaterThan(0);
    expect(imageClasses[0]).toContain("opacity-100");
    expect(imageClasses.some((value) => value.includes("opacity-0"))).toBe(
      false,
    );
  });
});
