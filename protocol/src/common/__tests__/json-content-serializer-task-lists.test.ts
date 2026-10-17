import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import { jsonContentToMarkdown } from "../json-content-serializer";

// traycer#2357 item 4: the artifact parser reads `- [ ]` / `- [x]` into
// `taskList` / `taskItem` nodes. Without an arm for either, the serializer's
// default arm concatenated the items' text into one line.
describe("jsonContentToMarkdown task lists", () => {
  it("writes each item back as a checkbox line", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [paragraph("Write the spec")]),
            taskItem(true, [paragraph("Review it")]),
          ]),
        ]),
      ),
    ).toBe("- [ ] Write the spec\n- [x] Review it");
  });

  it("keeps a nested task list under its parent item", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [
              paragraph("Parent"),
              taskList([taskItem(true, [paragraph("Child")])]),
            ]),
          ]),
        ]),
      ),
    ).toBe("- [ ] Parent\n  - [x] Child");
  });

  it("separates a task list from the paragraph after it", () => {
    expect(
      toMarkdown(
        doc([
          taskList([taskItem(false, [paragraph("Only item")])]),
          paragraph("After"),
        ]),
      ),
    ).toBe("- [ ] Only item\n\nAfter");
  });

  it("keeps the space after the checkbox of an empty item mid-document", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [{ type: "paragraph" }]),
            taskItem(true, [paragraph("Next")]),
          ]),
        ]),
      ),
    ).toBe("- [ ] \n- [x] Next");
  });

  it("keeps the space after the checkbox of an empty item on the last line", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(true, [paragraph("First")]),
            taskItem(false, [{ type: "paragraph" }]),
          ]),
        ]),
      ),
    ).toBe("- [x] First\n- [ ] ");
  });

  it("renders an unchecked box when attrs.checked is missing or not a boolean", () => {
    const item = (attrs: Record<string, unknown> | undefined): JsonContent => ({
      type: "taskItem",
      attrs,
      content: [paragraph("x")],
    });
    for (const attrs of [
      undefined,
      {},
      { checked: "true" },
      { checked: 1 },
      { checked: null },
    ]) {
      expect(toMarkdown(doc([taskList([item(attrs)])]))).toBe("- [ ] x");
    }
  });

  it("writes a second paragraph behind a blank line at the bullet's content column", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [paragraph("First"), paragraph("Second")]),
          ]),
        ]),
      ),
    ).toBe("- [ ] First\n\n  Second");
  });

  it("writes a code block under a task item at the item's content column", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [
              paragraph("a"),
              {
                type: "codeBlock",
                attrs: { language: "js" },
                content: [{ type: "text", text: "x" }],
              },
            ]),
          ]),
        ]),
      ),
    ).toBe("- [ ] a\n  ```js\n  x\n  ```");
  });

  it("nests a task list under a bullet item", () => {
    expect(
      toMarkdown(
        doc([
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  paragraph("Parent"),
                  taskList([taskItem(true, [paragraph("Child")])]),
                ],
              },
            ],
          },
        ]),
      ),
    ).toBe("- Parent\n  - [x] Child");
  });

  it("nests a bullet list under a task item", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [
              paragraph("Parent"),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph("Child")] }],
              },
            ]),
          ]),
        ]),
      ),
    ).toBe("- [ ] Parent\n  - Child");
  });

  it("uses the configured bullet marker before the checkbox", () => {
    expect(
      jsonContentToMarkdown(
        doc([
          taskList([
            taskItem(false, [paragraph("a")]),
            taskItem(true, [paragraph("b")]),
          ]),
        ]),
        { mentionFormat: "llm", platform: "POSIX", bulletMarker: "*" },
      ),
    ).toBe("* [ ] a\n* [x] b");
  });

  it("does not throw on a top-level task item", () => {
    expect(() =>
      toMarkdown(doc([taskItem(true, [paragraph("Lone")])])),
    ).not.toThrow();
    expect(toMarkdown(doc([taskItem(true, [paragraph("Lone")])]))).toBe(
      "- [x] Lone",
    );
  });

  it.each([
    [false, "- [ ] First\n  Second"],
    [true, "- [x] First\n  Second"],
  ])(
    "keeps the line after a hard break in a task item's first paragraph at the content column (checked %s)",
    (checked, expected) => {
      expect(
        toMarkdown(
          doc([
            taskList([
              taskItem(checked, [hardBreakParagraph("First", "Second")]),
            ]),
          ]),
        ),
      ).toBe(expected);
    },
  );

  it("keeps a bullet-looking line after a hard break inside the task item", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [hardBreakParagraph("First", "- Second")]),
          ]),
        ]),
      ),
    ).toBe("- [ ] First\n  - Second");
  });

  it("writes a paragraph after an empty first paragraph directly under the empty marker line", () => {
    expect(
      toMarkdown(
        doc([
          taskList([taskItem(false, [{ type: "paragraph" }, paragraph("b")])]),
        ]),
      ),
    ).toBe("- [ ] \n  b");
  });

  it("puts a blank line before a nested ordered list that starts above 1 under a task item's text", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [
              paragraph("t"),
              {
                type: "orderedList",
                attrs: { start: 10 },
                content: [{ type: "listItem", content: [paragraph("a")] }],
              },
            ]),
          ]),
        ]),
      ),
    ).toBe("- [ ] t\n\n  10. a");
  });

  it("writes an ordered list starting above 1 directly under an empty task paragraph", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [
              { type: "paragraph" },
              {
                type: "orderedList",
                attrs: { start: 10 },
                content: [{ type: "listItem", content: [paragraph("a")] }],
              },
            ]),
          ]),
        ]),
      ),
    ).toBe("- [ ] \n  10. a");
  });
});

describe("writes list item text as the agent typed it", () => {
  it("leaves a bullet-looking line after a hard break in a task item unescaped", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [hardBreakParagraph("First", "- Second")]),
          ]),
        ]),
      ),
    ).toBe("- [ ] First\n  - Second");
  });

  it("leaves a blockquote-looking line after a hard break in a bullet item unescaped", () => {
    expect(
      toMarkdown(
        doc([
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [hardBreakParagraph("First", "> q")],
              },
            ],
          },
        ]),
      ),
    ).toBe("- First\n  > q");
  });

  it("leaves a heading-looking line after a hard break in an ordered item at 10 unescaped", () => {
    expect(
      toMarkdown(
        doc([
          {
            type: "orderedList",
            attrs: { start: 10 },
            content: [
              {
                type: "listItem",
                content: [hardBreakParagraph("First", "# h")],
              },
            ],
          },
        ]),
      ),
    ).toBe("10. First\n    # h");
  });

  it("leaves a top-level paragraph's lines unescaped", () => {
    expect(toMarkdown(doc([hardBreakParagraph("First", "- Second")]))).toBe(
      "First\n- Second",
    );
  });
});

describe("jsonContentToMarkdown horizontal rules in task items", () => {
  const empty: JsonContent = { type: "paragraph" };

  it("writes a rule after a task item's text behind a blank line", () => {
    expect(
      toMarkdown(doc([taskList([taskItem(false, [paragraph("a"), rule()])])])),
    ).toBe("- [ ] a\n\n  ---");
  });

  it("writes a rule under an empty task marker", () => {
    expect(
      toMarkdown(doc([taskList([taskItem(false, [empty, rule()])])])),
    ).toBe("- [ ] \n  ---");
  });

  it("writes a rule after a nested list behind a blank line", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [
              paragraph("a"),
              {
                type: "bulletList",
                content: [{ type: "listItem", content: [paragraph("x")] }],
              },
              rule(),
            ]),
          ]),
        ]),
      ),
    ).toBe("- [ ] a\n  - x\n\n  ---");
  });

  it("keeps the next task item after two rules", () => {
    expect(
      toMarkdown(
        doc([
          taskList([
            taskItem(false, [paragraph("a"), rule(), rule()]),
            taskItem(false, [paragraph("b")]),
          ]),
        ]),
      ),
    ).toBe("- [ ] a\n\n  ---\n\n  ---\n- [ ] b");
  });
});

function rule(): JsonContent {
  return { type: "horizontalRule" };
}

function doc(content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

function taskList(items: JsonContent[]): JsonContent {
  return { type: "taskList", content: items };
}

function taskItem(checked: boolean, content: JsonContent[]): JsonContent {
  return { type: "taskItem", attrs: { checked }, content };
}

function paragraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function toMarkdown(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
}

function hardBreakParagraph(first: string, second: string): JsonContent {
  return {
    type: "paragraph",
    content: [
      { type: "text", text: first },
      { type: "hardBreak" },
      { type: "text", text: second },
    ],
  };
}
