import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { QueuedMessageContentPreview } from "@/components/chat/queued-message-content-preview";
import { TooltipProvider } from "@/components/ui/tooltip";

function renderPreview(content: JsonContent) {
  return render(
    <TooltipProvider delayDuration={0}>
      <QueuedMessageContentPreview content={content} />
    </TooltipProvider>,
  );
}

describe("QueuedMessageContentPreview", () => {
  it("preserves a non-one ordered-list start", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 2 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Second" }],
                },
              ],
            },
          ],
        },
      ],
    };

    renderPreview(content);

    const orderedList = screen.getByRole("list");
    if (!(orderedList instanceof HTMLOListElement)) {
      throw new Error("expected an ordered list");
    }
    expect(orderedList.start).toBe(2);
  });

  it("renders mention chips inline instead of summary badges", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "mention " },
            {
              type: "mention",
              attrs: {
                contextType: "file",
                id: "/tmp/CODE_OF_CONDUCT.md",
                path: "CODE_OF_CONDUCT.md",
                pathKind: "file",
                relPath: "CODE_OF_CONDUCT.md",
                absolutePath: "/tmp/CODE_OF_CONDUCT.md",
                workspacePath: "/tmp",
                label: "CODE_OF_CONDUCT.md",
                description: null,
              },
            },
          ],
        },
      ],
    };

    renderPreview(content);

    expect(screen.getByText("mention")).not.toBeNull();
    expect(screen.getByText("CODE_OF_CONDUCT.md")).not.toBeNull();
    expect(screen.queryByText("1 mention")).toBeNull();
  });

  it("renders inline image reference chips for attachments", () => {
    const content: JsonContent = {
      type: "doc",
      content: [
        {
          type: "imageAttachment",
          attrs: {
            id: "img-1",
            fileName: "shot.png",
            b64content: "abc",
            mimeType: "image/png",
            size: 10,
          },
        },
      ],
    };

    renderPreview(content);

    expect(screen.getByText("Image#1")).not.toBeNull();
    expect(screen.getByLabelText("Attached Image#1: shot.png")).not.toBeNull();
    expect(screen.queryByText("1 image")).toBeNull();
  });
});
