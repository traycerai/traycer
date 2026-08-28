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
      screen
        .getAllByRole("button", { name: /^Open Image#/ })
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual([
      "Open Image#1: image.png",
      "Open Image#2: image.png",
      "Open Image#3: image.png",
    ]);
    expect(
      screen.getByRole("button", { name: "Open Image#2: image.png" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Remove Image#3: image.png" }),
    ).toBeTruthy();

    const strip = document.querySelector("[data-composer-attachment-strip]");
    expect(strip?.className).toContain("overflow-x-auto");
    expect(strip?.className).toContain("flex-1");
    expect(strip?.firstElementChild?.className).toContain("w-max");
    expect(strip?.firstElementChild?.className).not.toContain("flex-wrap");
  });

  it("keeps leading annotation chips on the same one-row image scroller", () => {
    render(
      <AttachmentStrip
        content={duplicateImageContent()}
        onRemoveImage={() => undefined}
        fetcher={() => Promise.reject(new Error("unused"))}
        sessionObjectUrl={() => null}
        leadingAttachments={
          <div data-testid="browser-annotation-cards" className="contents">
            <div
              data-testid="browser-annotation-card"
              className="h-14 shrink-0"
            >
              annotation chip
            </div>
          </div>
        }
      />,
    );

    const strip = document.querySelector("[data-composer-attachment-strip]");
    const row = strip?.firstElementChild;
    expect(row?.className).toContain("flex");
    expect(row?.className).toContain("w-max");
    expect(row?.className).not.toContain("flex-wrap");
    expect(row?.contains(screen.getByTestId("browser-annotation-card"))).toBe(
      true,
    );
    expect(
      row?.contains(
        screen.getByRole("button", { name: "Open Image#1: image.png" }),
      ),
    ).toBe(true);
    expect(
      strip?.querySelectorAll("[data-composer-attachment-strip]"),
    ).toHaveLength(0);
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
