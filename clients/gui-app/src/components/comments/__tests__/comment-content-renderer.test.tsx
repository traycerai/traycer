import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { CommentContent } from "../comment-content-renderer";

afterEach(() => {
  cleanup();
});

describe("CommentContent ordered lists", () => {
  it("preserves a non-one start across multiple rendered items", () => {
    render(
      <CommentContent
        content={orderedList(["Second", "Third"], 2)}
        className={undefined}
      />,
    );

    const orderedListElement = screen.getByRole("list");
    if (!(orderedListElement instanceof HTMLOListElement)) {
      throw new Error("expected an ordered list");
    }
    expect(orderedListElement.start).toBe(2);
    expect(
      within(orderedListElement)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Second", "Third"]);
  });
});

function orderedList(items: ReadonlyArray<string>, start: number): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "orderedList",
        attrs: { start },
        content: items.map((text) => ({
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text }],
            },
          ],
        })),
      },
    ],
  };
}
