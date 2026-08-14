import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  type RenderResult,
} from "@testing-library/react";
import type {
  ImageAssetRequest,
  ImageAssetState,
} from "@/hooks/assets/use-image-asset";

const state = vi.hoisted(() => ({
  requests: [] as Array<ImageAssetRequest | null>,
  old: null as ImageAssetState | null,
  new: null as ImageAssetState | null,
}));

vi.mock("@/hooks/assets/use-image-asset", () => ({
  useImageAsset: (request: ImageAssetRequest | null) => {
    // Dedupe by reference (round-2 review finding #4: `ImageDiffView` now
    // fires one legitimate extra render on mount, learning each side's
    // real initial bounds from `onInit` - the SAME memoized `request`
    // object is passed to this hook again on that render, not a new fetch)
    // so tests keep counting distinct requests, not raw render passes.
    if (!state.requests.includes(request)) {
      state.requests.push(request);
    }
    // Forces THIS call site's own re-render when `reportDecodeFailure` fires
    // (the real hook transitions synchronously from a callback, not a prop
    // change) - `state.old`/`state.new` stay the module-level source of
    // truth so a test's own direct mutations still work exactly as before.
    const [, forceRender] = useState(0);
    // A `null` request (a non-image side) never falls back to `"new"` - the
    // real hook always reports `"loading"` for a null request (its
    // `requestKey`/`resolved.key` comparison can never match), so a test
    // exercising a Deleted/non-image side must see that too, not silently
    // read the OTHER side's `"ready"` state (CodeRabbit finding: this hid
    // a raw-status check that should have gated on `oldActive`/`newActive`).
    if (request === null) {
      return {
        status: "loading",
        url: null,
        meta: null,
        reason: null,
        totalBytes: null,
        servedFromCache: false,
        reportDecodeFailure: () => {},
      };
    }
    const side = request.method === "git" ? request.side : "new";
    const reportDecodeFailure = () => {
      const fallback: ImageAssetState = {
        status: "fallback",
        url: null,
        meta: null,
        reason: "This image could not be decoded.",
        totalBytes: null,
        servedFromCache: false,
      };
      if (side === "old") {
        state.old = fallback;
      } else {
        state.new = fallback;
      }
      forceRender((count) => count + 1);
    };
    const current = side === "old" ? state.old : state.new;
    if (current === null) throw new Error(`missing ${side} image state`);
    return { ...current, reportDecodeFailure };
  },
}));

import type { ImageDiffViewProps } from "../image-diff-view";
import { ImageDiffView } from "../image-diff-view";

const DEFAULT_PROPS: ImageDiffViewProps = {
  runningDir: "/repo",
  filePath: "images/current.png",
  previousPath: null,
  oldStage: "staged",
  newStage: "unstaged",
  fileName: "current.png",
  conflicted: false,
  compact: false,
  onOpenExternally: vi.fn(),
  openExternallyOpening: false,
  revisionKey: "revision-1",
};

function renderDiff(overrides: Partial<ImageDiffViewProps>): RenderResult {
  return render(<ImageDiffView {...DEFAULT_PROPS} {...overrides} />);
}

beforeEach(() => {
  state.requests.length = 0;
  state.old = {
    status: "ready",
    url: "blob:old",
    meta: {
      mediaType: "image/png",
      sizeBytes: 12,
      width: 4,
      height: 3,
    },
    reason: null,
    totalBytes: 12,
    servedFromCache: false,
  };
  state.new = {
    status: "ready",
    url: "blob:new",
    meta: {
      mediaType: "image/png",
      sizeBytes: 18,
      width: 6,
      height: 5,
    },
    reason: null,
    totalBytes: 18,
    servedFromCache: false,
  };
});

afterEach(() => {
  cleanup();
});

describe("<ImageDiffView />", () => {
  it("requests both git sides and threads previousPath to each request", () => {
    renderDiff({ previousPath: "images/old-name.png" });

    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([
      {
        method: "git",
        runningDir: "/repo",
        filePath: "images/current.png",
        previousPath: "images/old-name.png",
        side: "old",
        stage: "staged",
        coalesceRevision: "revision-1",
      },
      {
        method: "git",
        runningDir: "/repo",
        filePath: "images/current.png",
        previousPath: "images/old-name.png",
        side: "new",
        stage: "unstaged",
        coalesceRevision: "revision-1",
      },
    ]);
  });

  it("renders an Added empty state when the old side is absent", () => {
    renderDiff({ oldStage: null });

    expect(screen.getByText("Added")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toHaveLength(1);
  });

  it("renders a Deleted empty state when the new side is absent", () => {
    renderDiff({ newStage: null });

    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toHaveLength(1);
  });

  it("renders a side fallback reason with the settled BinaryPlaceholder treatment (pre-landing review, P1: reuse BinaryPlaceholder, keep Open Externally when the caller offers it)", () => {
    state.old = {
      status: "fallback",
      url: null,
      meta: null,
      reason: "This image could not be loaded.",
      totalBytes: null,
      servedFromCache: false,
    };

    renderDiff({});

    expect(screen.getByText("This image could not be loaded.")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Open Externally" }),
    ).toBeTruthy();
  });

  it("hides Open Externally per-side when the caller has no unambiguous target (e.g. a bundle row)", () => {
    state.old = {
      status: "fallback",
      url: null,
      meta: null,
      reason: "This image could not be loaded.",
      totalBytes: null,
      servedFromCache: false,
    };

    renderDiff({ onOpenExternally: null });

    expect(
      screen.queryByRole("button", { name: "Open Externally" }),
    ).toBeNull();
  });

  it("routes old.png to an image side and new.txt to a non-image placeholder without a new-side fetch", () => {
    renderDiff({
      filePath: "assets/new.txt",
      previousPath: "assets/old.png",
    });

    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "old" })]);
  });

  it("routes new.png to an image side and old.txt to a non-image placeholder without an old-side fetch", () => {
    renderDiff({
      filePath: "assets/new.png",
      previousPath: "assets/old.txt",
    });

    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByText("This file is not one of the supported image formats."),
    ).toBeTruthy();
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toEqual([expect.objectContaining({ side: "new" })]);
  });

  it("lets the surviving image side report Actual size when the other rename side is non-image", () => {
    renderDiff({
      filePath: "assets/new.png",
      previousPath: "assets/old.txt",
    });

    const toolbar = screen.getByRole("toolbar", {
      name: "Image diff controls",
    });
    const actualButton = within(toolbar).getByRole("button", {
      name: "Actual size",
    });

    expect(actualButton.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(actualButton);

    expect(actualButton.getAttribute("aria-pressed")).toBe("true");
  });

  it("uses the neutral pressed baseline when both diff sides are non-image", () => {
    renderDiff({
      filePath: "assets/new.txt",
      previousPath: "assets/old.txt",
    });

    const toolbar = screen.getByRole("toolbar", {
      name: "Image diff controls",
    });
    const fitButton = within(toolbar).getByRole("button", {
      name: "Fit to screen",
    });
    const actualButton = within(toolbar).getByRole("button", {
      name: "Actual size",
    });

    expect(fitButton.getAttribute("aria-pressed")).toBe("true");
    expect(actualButton.getAttribute("aria-pressed")).toBe("false");
  });

  it("falls back only the side whose image fails to decode", () => {
    renderDiff({});

    const images = screen.getAllByRole("img");
    const oldImage = images.at(0);
    if (oldImage === undefined) throw new Error("missing old image");

    fireEvent.error(oldImage);

    expect(screen.getByText("This image could not be decoded.")).toBeTruthy();
    expect(screen.getAllByRole("img")).toHaveLength(1);
    expect(
      screen.getByRole("button", { name: "Open Externally" }),
    ).toBeTruthy();
  });

  it("shows the Conflicted badge only in the full diff toolbar", () => {
    renderDiff({ conflicted: true });

    expect(
      screen.getByRole("toolbar", { name: "Image diff controls" }),
    ).toBeTruthy();
    expect(screen.getByText("Conflicted")).toBeTruthy();

    cleanup();
    renderDiff({ conflicted: false, compact: true });

    expect(
      screen.queryByRole("toolbar", { name: "Image diff controls" }),
    ).toBeNull();
    expect(screen.queryByText("Conflicted")).toBeNull();
  });

  // Supersedes decision #17's scroll-mirroring interaction (ticket 07): zoom
  // + pan are now one continuous transform per side (react-zoom-pan-pinch),
  // linked via `onTransform`-driven `setTransform` on the peer instead of
  // scrollTop/Left mirroring. This pins the SHARED toolbar's own mechanism
  // (single Fit/Actual-size pair driving both sides, no per-side toolbar);
  // the deeper linked-transform-sync behavior (does a GESTURE on one side's
  // real RZPP instance actually propagate to the peer's real instance) needs
  // `react-zoom-pan-pinch` mocked for deterministic jsdom assertions and is
  // left to that suite rather than guessed at here.
  it("drives fit/actual state from one shared toolbar, with no per-side toolbar", () => {
    renderDiff({});

    const toolbar = screen.getByRole("toolbar", {
      name: "Image diff controls",
    });
    const fitButton = within(toolbar).getByRole("button", {
      name: "Fit to screen",
    });
    const actualButton = within(toolbar).getByRole("button", {
      name: "Actual size",
    });
    expect(fitButton.getAttribute("aria-pressed")).toBe("true");
    expect(actualButton.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(actualButton);

    expect(fitButton.getAttribute("aria-pressed")).toBe("false");
    expect(actualButton.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.queryAllByRole("toolbar", { name: "Image preview controls" }),
    ).toHaveLength(0);
  });

  it("removes every toolbar (shared and per-side) in compact mode", () => {
    renderDiff({ compact: true });

    expect(screen.queryByRole("toolbar")).toBeNull();
    expect(screen.getAllByRole("img")).toHaveLength(2);
  });

  it("uses full height for the non-compact root", () => {
    const { container } = renderDiff({});
    const root = container.firstElementChild;

    expect(root?.className).toContain("h-full");
  });

  it("sizes a compact root from the more demanding known side ratio", () => {
    const { container } = renderDiff({ compact: true });
    const root = container.firstElementChild;

    expect(root?.className).toContain("max-h-[min(45vh,20rem)]");
    expect(root?.className).toContain("min-h-24");
    expect(root?.className).toContain("overflow-hidden");
    expect(root?.className).not.toContain("h-full");
    const aspectRatio =
      root instanceof HTMLElement ? root.style.aspectRatio : "";
    expect(Number.parseFloat(aspectRatio)).toBeCloseTo(2.4);
  });

  it("uses the single known side when the other side has no dimensions", () => {
    state.new = {
      status: "ready",
      url: "blob:new",
      meta: null,
      reason: null,
      totalBytes: 18,
      servedFromCache: false,
    };
    const { container } = renderDiff({ compact: true });
    const root = container.firstElementChild;

    const aspectRatio =
      root instanceof HTMLElement ? root.style.aspectRatio : "";
    expect(Number.parseFloat(aspectRatio)).toBeCloseTo(2 * (4 / 3));
    expect(root?.className).toContain("max-h-[min(45vh,20rem)]");
    expect(root?.className).toContain("min-h-24");
  });

  it("adds a compact height floor for panoramic image ratios", () => {
    state.old = {
      status: "ready",
      url: "blob:old",
      meta: {
        mediaType: "image/png",
        sizeBytes: 160_000,
        width: 4_000,
        height: 40,
      },
      reason: null,
      totalBytes: 160_000,
      servedFromCache: false,
    };
    state.new = {
      status: "ready",
      url: "blob:new",
      meta: null,
      reason: null,
      totalBytes: 18,
      servedFromCache: false,
    };
    const { container } = renderDiff({ compact: true });
    const root = container.firstElementChild;

    expect(root?.className).toContain("min-h-24");
    expect(root?.className).toContain("max-h-[min(45vh,20rem)]");
  });

  it("falls back to a viewport-only height when neither side has dimensions", () => {
    state.old = {
      status: "ready",
      url: "blob:old",
      meta: null,
      reason: null,
      totalBytes: 12,
      servedFromCache: false,
    };
    state.new = {
      status: "ready",
      url: "blob:new",
      meta: null,
      reason: null,
      totalBytes: 18,
      servedFromCache: false,
    };
    const { container } = renderDiff({ compact: true });
    const root = container.firstElementChild;

    expect(root?.className).toContain("h-[45vh]");
    expect(root?.className).toContain("overflow-hidden");
    const aspectRatio =
      root instanceof HTMLElement ? root.style.aspectRatio : "";
    expect(aspectRatio).toBe("");
    expect(root?.className).not.toContain("max-h-[min(45vh,20rem)]");
    expect(root?.className).not.toContain("min-h-24");
  });
});
