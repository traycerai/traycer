import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
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
  useImageAsset: (request: ImageAssetRequest | null): ImageAssetState => {
    state.requests.push(request);
    if (request?.method === "git" && request.side === "old") {
      if (state.old === null) throw new Error("missing old image state");
      return state.old;
    }
    if (state.new === null) throw new Error("missing new image state");
    return state.new;
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
};

function renderDiff(overrides: Partial<ImageDiffViewProps>): void {
  render(<ImageDiffView {...DEFAULT_PROPS} {...overrides} />);
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
    receivedBytes: 12,
    totalBytes: 12,
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
    receivedBytes: 18,
    totalBytes: 18,
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
      },
      {
        method: "git",
        runningDir: "/repo",
        filePath: "images/current.png",
        previousPath: "images/old-name.png",
        side: "new",
        stage: "unstaged",
      },
    ]);
  });

  it("renders an Added empty state when the old side is absent", () => {
    renderDiff({ oldStage: null });

    expect(screen.getByText("Added")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Zoom to 100%" }),
    ).toHaveLength(1);
    expect(
      state.requests.filter((request) => request?.method === "git"),
    ).toHaveLength(1);
  });

  it("renders a Deleted empty state when the new side is absent", () => {
    renderDiff({ newStage: null });

    expect(screen.getByText("Deleted")).toBeTruthy();
    expect(
      screen.getAllByRole("button", { name: "Zoom to 100%" }),
    ).toHaveLength(1);
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
      receivedBytes: 0,
      totalBytes: null,
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
      receivedBytes: 0,
      totalBytes: null,
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

  it("falls back only the side whose image fails to decode", () => {
    renderDiff({});

    const images = screen.getAllByRole("img");
    const oldImage = images.at(0);
    if (oldImage === undefined) throw new Error("missing old image");

    fireEvent.error(oldImage);

    expect(screen.getByText("Preview could not be decoded.")).toBeTruthy();
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

  it("links the shared zoom toggle to both image previews", () => {
    renderDiff({});

    const toolbar = screen.getByRole("toolbar", {
      name: "Image diff controls",
    });
    fireEvent.click(within(toolbar).getByRole("button"));

    const imageButtons = screen.getAllByRole("button", { name: "Zoom to fit" });
    expect(imageButtons).toHaveLength(2);
    expect(
      imageButtons.every(
        (button) => button.getAttribute("aria-pressed") === "true",
      ),
    ).toBe(true);
    expect(
      screen.queryAllByRole("toolbar", { name: "Image preview controls" }),
    ).toHaveLength(0);
  });

  it("locks both sides to fit and removes every toolbar in compact mode", () => {
    renderDiff({ compact: true });

    expect(screen.queryByRole("toolbar")).toBeNull();
    const imageButtons = screen.getAllByRole("button", {
      name: "Zoom to 100%",
    });
    expect(imageButtons).toHaveLength(2);

    fireEvent.click(imageButtons[0]);

    expect(
      screen.getAllByRole("button", { name: "Zoom to 100%" }),
    ).toHaveLength(2);
  });

  it("mirrors scroll positions between the two sides without a ping-pong loop", () => {
    renderDiff({});

    const stages = Array.from(
      document.querySelectorAll<HTMLDivElement>(".image-preview-checkerboard"),
    );
    expect(stages).toHaveLength(2);

    const oldStage = stages.at(0);
    const newStage = stages.at(1);
    if (oldStage === undefined || newStage === undefined) {
      throw new Error("missing image diff stages");
    }

    oldStage.scrollTop = 41;
    oldStage.scrollLeft = 17;
    fireEvent.scroll(oldStage);

    expect(newStage.scrollTop).toBe(41);
    expect(newStage.scrollLeft).toBe(17);

    newStage.scrollTop = 9;
    newStage.scrollLeft = 3;
    fireEvent.scroll(newStage);

    expect(oldStage.scrollTop).toBe(9);
    expect(oldStage.scrollLeft).toBe(3);
  });
});
