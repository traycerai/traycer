import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import { jsonContentToMarkdown } from "../json-content-serializer";

describe("jsonContentToMarkdown ordered lists", () => {
  it("preserves an explicit starting number and increments later items", () => {
    expect(toMarkdown(orderedList(["First", "Second"], 2))).toBe(
      "2. First\n3. Second",
    );
  });

  it("keeps the default start at one when the attribute is absent", () => {
    expect(toMarkdown(orderedList(["First", "Second"], null))).toBe(
      "1. First\n2. Second",
    );
  });

  it("renders a code block that follows the first child of a bullet item at the item's content column", () => {
    expect(
      toMarkdown({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "a" }] },
                  {
                    type: "codeBlock",
                    attrs: { language: "js" },
                    content: [{ type: "text", text: "x" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("- a\n  ```js\n  x\n  ```");
  });

  it("renders a code block that is the only child of a bullet item on the line after an empty marker line", () => {
    expect(
      toMarkdown(docOf(bulletList([listItem([codeBlock("ts", "code")])]))),
    ).toBe("-\n  ```ts\n  code\n  ```");
  });

  it("renders a mermaid block after the first child of a bullet item at the item's content column", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              { type: "mermaidBlock", attrs: { code: "graph TD" } },
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  ```mermaid\n  graph TD\n  ```");
  });

  it("renders a UI preview block after the first child of a bullet item at the item's content column", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              { type: "uiPreviewBlock", attrs: { htmlContent: "<p>x</p>" } },
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  ```wireframe\n  <p>x</p>\n  ```");
  });

  it("renders a code block after the first child of an ordered item at the three-space content column", () => {
    expect(
      toMarkdown(
        docOf({
          type: "orderedList",
          content: [listItem([textParagraph("a"), codeBlock("", "code")])],
        }),
      ),
    ).toBe("1. a\n   ```\n   code\n   ```");
  });

  it("renders a code block in a nested bullet item at that item's content column", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              bulletList([
                listItem([textParagraph("b"), codeBlock("", "code")]),
              ]),
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  - b\n    ```\n    code\n    ```");
  });

  it.each([
    [1, "   "],
    [10, "    "],
    [100, "     "],
  ])(
    "renders a code block after the first child of an ordered item numbered %i at its content column",
    (start, pad) => {
      expect(
        toMarkdown(
          docOf(
            orderedBlock(
              [listItem([textParagraph("a"), codeBlock("", "code")])],
              start,
            ),
          ),
        ),
      ).toBe(`${start}. a\n${pad}\`\`\`\n${pad}code\n${pad}\`\`\``);
    },
  );

  it.each([
    [1, "   "],
    [10, "    "],
    [100, "     "],
  ])(
    "starts a task list nested under an ordered item numbered %i at the content column, with its code block two columns further",
    (start, pad) => {
      const body = `${pad}  `;
      expect(
        toMarkdown(
          docOf(
            orderedBlock(
              [
                listItem([
                  textParagraph("a"),
                  taskBlock([
                    taskEntry([textParagraph("t"), codeBlock("", "code")]),
                  ]),
                ]),
              ],
              start,
            ),
          ),
        ),
      ).toBe(
        `${start}. a\n${pad}- [ ] t\n${body}\`\`\`\n${body}code\n${body}\`\`\``,
      );
    },
  );

  it("nests an ordered list under a task item with a code block under the ordered item", () => {
    expect(
      toMarkdown(
        docOf(
          taskBlock([
            taskEntry([
              textParagraph("t"),
              orderedBlock(
                [listItem([textParagraph("a"), codeBlock("", "code")])],
                1,
              ),
            ]),
          ]),
        ),
      ),
    ).toBe("- [ ] t\n  1. a\n     ```\n     code\n     ```");
  });

  it("nests an ordered list under an ordered item at the parent's content column", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [
              listItem([textParagraph("one")]),
              listItem([
                textParagraph("two"),
                orderedBlock(
                  [listItem([textParagraph("nested"), codeBlock("", "x")])],
                  1,
                ),
              ]),
            ],
            1,
          ),
        ),
      ),
    ).toBe("1. one\n2. two\n   1. nested\n      ```\n      x\n      ```");
  });

  it("nests a bullet list under an ordered item at three columns", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [
              listItem([
                textParagraph("a"),
                bulletList([listItem([textParagraph("b")])]),
              ]),
            ],
            1,
          ),
        ),
      ),
    ).toBe("1. a\n   - b");
  });

  it("nests an ordered list under a bullet item at two columns", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              orderedBlock([listItem([textParagraph("b")])], 1),
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  1. b");
  });

  it("keeps a bullet list nested in a bullet list at two columns per level", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              bulletList([
                listItem([
                  textParagraph("b"),
                  bulletList([listItem([textParagraph("c")])]),
                ]),
              ]),
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  - b\n    - c");
  });

  it.each([
    [1, "   "],
    [10, "    "],
    [100, "     "],
  ])(
    "starts a fence-first ordered item numbered %i on the line after an empty marker line, whether or not an empty paragraph leads",
    (start, pad) => {
      const expected = `${start}. \n${pad}\`\`\`\n${pad}code\n${pad}\`\`\``;
      const only = listItem([codeBlock("", "code")]);
      const afterEmpty = listItem([
        { type: "paragraph" },
        codeBlock("", "code"),
      ]);
      expect(toMarkdown(docOf(orderedBlock([only], start)))).toBe(expected);
      expect(toMarkdown(docOf(orderedBlock([afterEmpty], start)))).toBe(
        expected,
      );
    },
  );

  it("starts a fence-first task item on the line after an empty marker line, whether or not an empty paragraph leads", () => {
    const expected = "- [ ] \n  ```\n  code\n  ```";
    expect(
      toMarkdown(docOf(taskBlock([taskEntry([codeBlock("", "code")])]))),
    ).toBe(expected);
    expect(
      toMarkdown(
        docOf(
          taskBlock([
            taskEntry([{ type: "paragraph" }, codeBlock("", "code")]),
          ]),
        ),
      ),
    ).toBe(expected);
  });

  it("writes the same text for a fence-first bullet item with or without a leading empty paragraph", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([{ type: "paragraph" }, codeBlock("ts", "code")]),
          ]),
        ),
      ),
    ).toBe("-\n  ```ts\n  code\n  ```");
  });

  it("keeps an ordered item with no children mid-list", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [
              listItem([textParagraph("a")]),
              { type: "listItem" },
              listItem([textParagraph("c")]),
            ],
            1,
          ),
        ),
      ),
    ).toBe("1. a\n2. \n3. c");
  });

  it("keeps an empty last item of a bullet list as its bare marker", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([textParagraph("a")]),
            { type: "listItem", content: [] },
          ]),
        ),
      ),
    ).toBe("- a\n-");
  });

  it("keeps the space after the marker of an empty last ordered item", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [listItem([textParagraph("a")]), { type: "listItem", content: [] }],
            1,
          ),
        ),
      ),
    ).toBe("1. a\n2. ");
  });

  it("keeps the space after the checkbox of an empty last task item", () => {
    expect(
      toMarkdown(
        docOf(
          taskBlock([
            taskEntry([textParagraph("a")]),
            { type: "taskItem", attrs: { checked: false }, content: [] },
          ]),
        ),
      ),
    ).toBe("- [ ] a\n- [ ] ");
  });

  it.each([
    [1, "   "],
    [10, "    "],
    [100, "     "],
  ])(
    "puts a blank line before a later paragraph of an ordered item numbered %i and none before the fence after it",
    (start, pad) => {
      expect(
        toMarkdown(
          docOf(
            orderedBlock(
              [
                listItem([
                  textParagraph("First item"),
                  textParagraph("Second paragraph"),
                  codeBlock("js", "x"),
                ]),
              ],
              start,
            ),
          ),
        ),
      ).toBe(
        `${start}. First item\n\n${pad}Second paragraph\n${pad}\`\`\`js\n${pad}x\n${pad}\`\`\``,
      );
    },
  );

  it("puts a blank line before a later paragraph of a task item", () => {
    expect(
      toMarkdown(
        docOf(
          taskBlock([
            taskEntry([
              textParagraph("First item"),
              textParagraph("Second paragraph"),
              codeBlock("js", "x"),
            ]),
          ]),
        ),
      ),
    ).toBe("- [ ] First item\n\n  Second paragraph\n  ```js\n  x\n  ```");
  });

  it("puts a blank line before a later paragraph of a bullet item", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("First item"),
              textParagraph("Second paragraph"),
              codeBlock("js", "x"),
            ]),
          ]),
        ),
      ),
    ).toBe("- First item\n\n  Second paragraph\n  ```js\n  x\n  ```");
  });

  it("puts a blank line before a paragraph that follows a nested list", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              bulletList([listItem([textParagraph("x")])]),
              textParagraph("c"),
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  - x\n\n  c");
  });

  it("keeps the line after a hard break in a bullet item's first paragraph at the content column", () => {
    expect(
      toMarkdown(
        docOf(bulletList([listItem([hardBreakParagraph("First", "Second")])])),
      ),
    ).toBe("- First\n  Second");
  });

  it.each([
    [1, "   "],
    [10, "    "],
    [100, "     "],
  ])(
    "keeps the line after a hard break in the first paragraph of an ordered item numbered %i at its content column",
    (start, pad) => {
      expect(
        toMarkdown(
          docOf(
            orderedBlock(
              [listItem([hardBreakParagraph("First", "Second")])],
              start,
            ),
          ),
        ),
      ).toBe(`${start}. First\n${pad}Second`);
    },
  );

  it("keeps the line after a hard break in a nested bullet item under an ordered item at that item's content column", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [
              listItem([
                textParagraph("a"),
                bulletList([listItem([hardBreakParagraph("First", "Second")])]),
              ]),
            ],
            1,
          ),
        ),
      ),
    ).toBe("1. a\n   - First\n     Second");
  });

  it("writes a paragraph after an empty first paragraph of a bullet item directly under the bare marker", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([listItem([{ type: "paragraph" }, textParagraph("b")])]),
        ),
      ),
    ).toBe("-\n  b");
  });

  it.each([
    [1, "   "],
    [10, "    "],
    [100, "     "],
  ])(
    "writes a paragraph after an empty first paragraph of an ordered item numbered %i directly under the marker line, which keeps its trailing space",
    (start, pad) => {
      expect(
        toMarkdown(
          docOf(
            orderedBlock(
              [listItem([{ type: "paragraph" }, textParagraph("b")])],
              start,
            ),
          ),
        ),
      ).toBe(`${start}. \n${pad}b`);
    },
  );

  it("puts a blank line before a nested bullet list that opens with an empty item", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([textParagraph("a"), bulletList([{ type: "listItem" }])]),
          ]),
        ),
      ),
    ).toBe("- a\n\n  -");
  });

  it("puts a blank line before a nested bullet list whose empty-first-paragraph item has a second paragraph", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              bulletList([
                listItem([{ type: "paragraph" }, textParagraph("b")]),
              ]),
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n\n  -\n    b");
  });

  it("leaves a nested bullet list whose first item has text without a blank line", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("a"),
              bulletList([listItem([textParagraph("x")])]),
            ]),
          ]),
        ),
      ),
    ).toBe("- a\n  - x");
  });

  it("opens an item that holds only a bullet list with a bare marker line", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              bulletList([
                listItem([textParagraph("x")]),
                listItem([textParagraph("y")]),
              ]),
            ]),
          ]),
        ),
      ),
    ).toBe("-\n  - x\n  - y");
  });

  it("opens a three-deep chain of bullet lists with bare marker lines", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              bulletList([
                listItem([bulletList([listItem([textParagraph("x")])])]),
              ]),
            ]),
          ]),
        ),
      ),
    ).toBe("-\n  -\n    - x");
  });

  it("opens an ordered item that holds only an ordered list with the marker and its trailing space", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [
              listItem([
                orderedBlock(
                  [
                    listItem([textParagraph("x")]),
                    listItem([textParagraph("y")]),
                  ],
                  1,
                ),
              ]),
            ],
            1,
          ),
        ),
      ),
    ).toBe("1. \n   1. x\n   2. y");
  });

  it("opens an ordered item at 10 that holds only a bullet list on the next line", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [listItem([bulletList([listItem([textParagraph("x")])])])],
            10,
          ),
        ),
      ),
    ).toBe("10. \n    - x");
  });

  it("opens a bullet item that holds only an ordered list with a bare marker", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([orderedBlock([listItem([textParagraph("x")])], 1)]),
          ]),
        ),
      ),
    ).toBe("-\n  1. x");
  });

  it("puts a blank line before a nested ordered list that starts above 1 under a line of text", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("t"),
              orderedBlock([listItem([textParagraph("a")])], 10),
            ]),
          ]),
        ),
      ),
    ).toBe("- t\n\n  10. a");
  });

  it("keeps a nested ordered list that starts at 1 directly under the text", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              textParagraph("t"),
              orderedBlock([listItem([textParagraph("a")])], 1),
            ]),
          ]),
        ),
      ),
    ).toBe("- t\n  1. a");
  });

  it("writes a three-deep chain of empty-first-paragraph items without a blank line", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              { type: "paragraph" },
              bulletList([
                listItem([
                  { type: "paragraph" },
                  bulletList([listItem([textParagraph("x")])]),
                ]),
              ]),
            ]),
          ]),
        ),
      ),
    ).toBe("-\n  -\n    - x");
  });

  it("writes an ordered list starting above 1 directly under an empty first paragraph", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([
              { type: "paragraph" },
              orderedBlock([listItem([textParagraph("a")])], 10),
            ]),
          ]),
        ),
      ),
    ).toBe("-\n  10. a");
  });
});

describe("jsonContentToMarkdown horizontal rules", () => {
  const empty: JsonContent = { type: "paragraph" };
  const a = textParagraph("a");
  const b = textParagraph("b");

  it("writes a top-level rule between blocks a blank line apart", () => {
    expect(toMarkdown(docOf(a, rule(), b))).toBe("a\n\n---\n\nb");
  });

  it("writes a top-level rule alone, first and last", () => {
    expect(toMarkdown(docOf(rule()))).toBe("---");
    expect(toMarkdown(docOf(rule(), a))).toBe("---\n\na");
    expect(toMarkdown(docOf(a, rule()))).toBe("a\n\n---");
  });

  it("writes a rule next to a heading and a second rule", () => {
    expect(
      toMarkdown(
        docOf(
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "H" }],
          },
          rule(),
        ),
      ),
    ).toBe("## H\n\n---");
    expect(toMarkdown(docOf(a, rule(), rule(), b))).toBe(
      "a\n\n---\n\n---\n\nb",
    );
  });

  it("gives a rule inside a quote as a line of its own", () => {
    expect(
      toMarkdown(docOf({ type: "blockquote", content: [a, rule(), b] })),
    ).toBe("<user_quoted_section>a\n---\nb</user_quoted_section>");
  });

  it("writes a rule after a bullet item's text behind a blank line", () => {
    expect(toMarkdown(docOf(bulletList([listItem([a, rule()])])))).toBe(
      "- a\n\n  ---",
    );
  });

  it("writes a rule as a bullet item's first block under the marker", () => {
    expect(toMarkdown(docOf(bulletList([listItem([empty, rule()])])))).toBe(
      "-\n  ---",
    );
  });

  it("writes a bullet item holding only a rule as an empty marker and the rule", () => {
    expect(toMarkdown(docOf(bulletList([listItem([rule()])])))).toBe(
      "-\n  ---",
    );
  });

  it("writes a rule after a nested list behind a blank line", () => {
    expect(
      toMarkdown(
        docOf(
          bulletList([
            listItem([a, bulletList([listItem([textParagraph("x")])]), rule()]),
          ]),
        ),
      ),
    ).toBe("- a\n  - x\n\n  ---");
  });

  it("writes two rules and a paragraph in a bullet item", () => {
    expect(toMarkdown(docOf(bulletList([listItem([a, rule(), rule()])])))).toBe(
      "- a\n\n  ---\n\n  ---",
    );
    expect(toMarkdown(docOf(bulletList([listItem([a, rule(), b])])))).toBe(
      "- a\n\n  ---\n\n  b",
    );
  });

  it("writes a rule in a nested bullet item at that item's content column", () => {
    expect(
      toMarkdown(
        docOf(bulletList([listItem([a, bulletList([listItem([b, rule()])])])])),
      ),
    ).toBe("- a\n  - b\n\n    ---");
  });

  it("writes a rule in an ordered item at the marker's content column", () => {
    expect(toMarkdown(docOf(orderedBlock([listItem([a, rule()])], 1)))).toBe(
      "1. a\n\n   ---",
    );
    expect(toMarkdown(docOf(orderedBlock([listItem([a, rule()])], 10)))).toBe(
      "10. a\n\n    ---",
    );
    expect(
      toMarkdown(docOf(orderedBlock([listItem([empty, rule()])], 100))),
    ).toBe("100. \n     ---");
  });

  it("keeps the next ordered item after a rule that follows a nested list", () => {
    expect(
      toMarkdown(
        docOf(
          orderedBlock(
            [
              listItem([
                a,
                bulletList([listItem([textParagraph("x")])]),
                rule(),
              ]),
              listItem([b]),
            ],
            1,
          ),
        ),
      ),
    ).toBe("1. a\n   - x\n\n   ---\n2. b");
  });
});

function rule(): JsonContent {
  return { type: "horizontalRule" };
}

function orderedList(
  items: ReadonlyArray<string>,
  start: number | null,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "orderedList",
        attrs: start === null ? undefined : { start },
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

function toMarkdown(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
}

function docOf(...content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

function bulletList(items: JsonContent[]): JsonContent {
  return { type: "bulletList", content: items };
}

function listItem(content: JsonContent[]): JsonContent {
  return { type: "listItem", content };
}

function textParagraph(text: string): JsonContent {
  return { type: "paragraph", content: [{ type: "text", text }] };
}

function codeBlock(language: string, text: string): JsonContent {
  return {
    type: "codeBlock",
    attrs: language === "" ? undefined : { language },
    content: [{ type: "text", text }],
  };
}

function orderedBlock(items: JsonContent[], start: number): JsonContent {
  return { type: "orderedList", attrs: { start }, content: items };
}

function taskBlock(items: JsonContent[]): JsonContent {
  return { type: "taskList", content: items };
}

function taskEntry(content: JsonContent[]): JsonContent {
  return { type: "taskItem", attrs: { checked: false }, content };
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
