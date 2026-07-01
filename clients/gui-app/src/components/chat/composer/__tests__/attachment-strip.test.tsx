import "../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { AttachmentStrip } from "../attachments/attachment-strip";

afterEach(() => {
  cleanup();
});

describe("AttachmentStrip", () => {
  it("renders document-order badges for duplicate image filenames", () => {
    render(
      <AttachmentStrip
        content={duplicateImageContent()}
        onRemoveImage={() => undefined}
        fetcher={() => Promise.reject(new Error("unused"))}
        sessionObjectUrl={() => null}
      />,
    );

    expect(
      Array.from(
        document.querySelectorAll<HTMLElement>(
          "[data-composer-image-strip-badge]",
        ),
      ).map((badge) => badge.textContent),
    ).toEqual(["1", "2", "3"]);
    expect(screen.getByLabelText("Open Image#2: image.png")).toBeTruthy();
    expect(screen.getByLabelText("Remove Image#3: image.png")).toBeTruthy();
  });
});

function duplicateImageContent(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          imageNode("img-1"),
          { type: "text", text: " and " },
          imageNode("img-2"),
          { type: "text", text: " then " },
          imageNode("img-3"),
        ],
      },
    ],
  };
}

function imageNode(id: string): JsonContent {
  return {
    type: "imageAttachment",
    attrs: {
      id,
      fileName: "image.png",
      b64content: id,
      mimeType: "image/png",
      size: id.length,
    },
  };
}
