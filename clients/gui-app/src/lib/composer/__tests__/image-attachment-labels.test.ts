import { describe, expect, it } from "vitest";

import { buildImageAttachmentDisplayLabels } from "../image-attachment-labels";

describe("image attachment display labels", () => {
  it("uses concise numbered reference labels for duplicate image names", () => {
    const labels = buildImageAttachmentDisplayLabels([
      { id: "img-1", fileName: "image.png" },
      { id: "img-2", fileName: "image.png" },
      { id: "img-3", fileName: "image.png" },
    ]);

    expect(labels.get("img-1")?.inlineLabel).toBe("Image#1");
    expect(labels.get("img-2")?.inlineLabel).toBe("Image#2");
    expect(labels.get("img-3")?.inlineLabel).toBe("Image#3");
    expect(labels.get("img-2")?.title).toBe("Image#2: image.png");
  });

  it("keeps meaningful unique filenames out of the visible label", () => {
    const labels = buildImageAttachmentDisplayLabels([
      { id: "diagram", fileName: "architecture.png" },
      { id: "flow", fileName: "checkout-flow.webp" },
    ]);

    expect(labels.get("diagram")?.inlineLabel).toBe("Image#1");
    expect(labels.get("flow")?.inlineLabel).toBe("Image#2");
    expect(labels.get("flow")?.title).toBe("Image#2: checkout-flow.webp");
  });

  it("uses numbered references when meaningful filenames repeat", () => {
    const labels = buildImageAttachmentDisplayLabels([
      { id: "before", fileName: "error-state.png" },
      { id: "after", fileName: "error-state.png" },
    ]);

    expect(labels.get("before")?.inlineLabel).toBe("Image#1");
    expect(labels.get("after")?.inlineLabel).toBe("Image#2");
  });

  it("uses numbered references for screenshot-style filenames", () => {
    const labels = buildImageAttachmentDisplayLabels([
      { id: "shot", fileName: "Screenshot 2026-07-01 at 8.42.12 PM.png" },
    ]);

    expect(labels.get("shot")?.inlineLabel).toBe("Image#1");
  });
});
