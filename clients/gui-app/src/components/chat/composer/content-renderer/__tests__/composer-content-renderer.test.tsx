import "../../../../../../__tests__/test-browser-apis";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { buildSubmittedChatJSONContent } from "@/lib/composer/tiptap-json-content";
import { ComposerContentRenderer } from "../composer-content-renderer";

afterEach(() => {
  cleanup();
});

function quoteDraft(): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "the original point" }],
          },
        ],
      },
      {
        type: "paragraph",
        content: [{ type: "text", text: "my reply" }],
      },
    ],
  };
}

describe("blockquote submit round-trip", () => {
  it("passes a draft containing a blockquote through buildSubmittedChatJSONContent unchanged", () => {
    const draft = quoteDraft();
    expect(buildSubmittedChatJSONContent(draft)).toEqual(draft);
  });

  it("renders the submitted content through ComposerContentRenderer with the quote styling", () => {
    const submitted = buildSubmittedChatJSONContent(quoteDraft());
    const { container } = render(
      <ComposerContentRenderer
        content={submitted}
        variant={undefined}
        className={undefined}
        testId={undefined}
      />,
    );

    const blockquote = container.querySelector("blockquote");
    expect(blockquote).not.toBeNull();
    if (blockquote === null) throw new Error("expected a rendered blockquote");
    expect(blockquote.textContent).toBe("the original point");
    expect(blockquote.className).toContain("border-primary/60");
    expect(blockquote.className).toContain("text-muted-foreground");
    expect(container.textContent).toContain("my reply");
  });
});
