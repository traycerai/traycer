import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { cleanup, render } from "@testing-library/react";
import type {
  ImageAssetRequest,
  ImageAssetState,
} from "@/hooks/assets/use-image-asset";
import type { ImagePreviewProps } from "../image-preview";

const state = vi.hoisted(() => ({
  animationMs: [] as Array<number>,
  old: null as ImageAssetState | null,
  new: null as ImageAssetState | null,
}));

vi.mock("@/hooks/assets/use-image-asset", () => ({
  useImageAsset: (request: ImageAssetRequest | null) => {
    const asset =
      request?.method === "git" && request.side === "old"
        ? state.old
        : state.new;
    if (asset === null) throw new Error("missing image asset state");
    return { ...asset, reportDecodeFailure: vi.fn() };
  },
}));

vi.mock("../image-preview", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../image-preview")>();
  const ImagePreviewProbe = (props: ImagePreviewProps): ReactNode => {
    state.animationMs.push(props.animationMs);
    return <actual.ImagePreview {...props} />;
  };
  return { ...actual, ImagePreview: ImagePreviewProbe };
});

import { ImageDiffView } from "../image-diff-view";

const READY_ASSET: ImageAssetState = {
  status: "ready",
  url: "blob:image",
  meta: {
    mediaType: "image/png",
    sizeBytes: 1,
    width: 640,
    height: 480,
  },
  reason: null,
  receivedBytes: 1,
  totalBytes: 1,
  servedFromCache: false,
};

const PROPS = {
  runningDir: "/repo",
  filePath: "images/new.png",
  previousPath: "images/old.png",
  oldStage: "staged" as const,
  newStage: "unstaged" as const,
  fileName: "new.png",
  conflicted: false,
  compact: false,
  onOpenExternally: null,
  openExternallyOpening: false,
};

beforeEach(() => {
  state.animationMs.length = 0;
  state.old = READY_ASSET;
  state.new = READY_ASSET;
});

afterEach(() => {
  cleanup();
});

describe("ImageDiffView animation duration invariant", () => {
  it("passes animationMs=0 to every mounted side across compact and inactive-side modes", () => {
    const cases = [
      PROPS,
      { ...PROPS, compact: true },
      { ...PROPS, oldStage: null, previousPath: null },
      { ...PROPS, filePath: "images/new.png", previousPath: "notes/old.txt" },
    ];
    for (const props of cases) {
      render(<ImageDiffView {...props} />);
      cleanup();
    }

    expect(state.animationMs.length).toBeGreaterThanOrEqual(6);
    expect(new Set(state.animationMs)).toEqual(new Set([0]));
  });
});
