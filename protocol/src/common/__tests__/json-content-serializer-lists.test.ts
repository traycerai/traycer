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

describe("jsonContentToMarkdown bare bullet markers under text", () => {
  const MARKER_ROWS = [
    ["-", "- parent\n\n  -"],
    ["*", "* parent\n\n  *"],
    ["+", "+ parent\n\n  +"],
  ] as const;

  for (const [bulletMarker, bytes] of MARKER_ROWS) {
    it(`puts a blank line before an empty nested ${bulletMarker} item under text`, () => {
      expect(
        jsonContentToMarkdown(
          docOf(
            bulletList([
              listItem([
                textParagraph("parent"),
                bulletList([listItem([{ type: "paragraph" }])]),
              ]),
            ]),
          ),
          { mentionFormat: "llm", platform: "POSIX", bulletMarker },
        ),
      ).toBe(bytes);
    });
  }
});

describe("jsonContentToMarkdown keeps the marker space only on a real empty item", () => {
  const KEPT_SPACE = "\uFDD0";
  const empty: JsonContent = { type: "paragraph" };

  function check(content: JsonContent, bytes: string): void {
    const out = toMarkdown(content);
    expect(out).toBe(bytes);
    expect(out).not.toContain(KEPT_SPACE);
  }

  it("trims a paragraph whose text is an ordered marker and a space", () => {
    check(docOf(textParagraph("1. ")), "1.");
  });

  it("trims a paragraph whose text is an empty task marker and a space", () => {
    check(docOf(textParagraph("- [ ] ")), "- [ ]");
  });

  it("keeps the space of an empty ordered item that ends the document", () => {
    check(docOf(orderedBlock([listItem([empty])], 1)), "1. ");
  });

  it("keeps the space of an empty ordered item before a paragraph", () => {
    check(
      docOf(orderedBlock([listItem([empty])], 1), textParagraph("x")),
      "1. \n\nx",
    );
  });

  it("keeps the space of an empty task item that ends the document", () => {
    check(docOf(taskBlock([taskEntry([empty])])), "- [ ] ");
  });
});

describe("jsonContentToMarkdown placeholder never collides with the user's text", () => {
  const FDD0 = "\uFDD0";

  function collisionDoc(): JsonContent {
    return docOf(
      textParagraph(`x${FDD0}y`),
      bulletList([listItem([textParagraph(FDD0)])]),
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [textParagraph("h")],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [textParagraph(`a${FDD0}b`)],
              },
            ],
          },
        ],
      },
      orderedBlock([listItem([{ type: "paragraph" }])], 1),
    );
  }

  it("keeps the user's U+FDD0 where it was typed and still writes an empty item's space", () => {
    const out = toMarkdown(collisionDoc());
    expect(out.split(FDD0)).toHaveLength(4);
    expect(out).toContain(`x${FDD0}y`);
    expect(out).toContain(`- ${FDD0}`);
    expect(out).toContain(`| a${FDD0}b |`);
    expect(out.endsWith("\n1. ")).toBe(true);
  });

  it("writes a paragraph whose text is exactly '1.' and U+FDD0 as it was typed", () => {
    expect(toMarkdown(docOf(textParagraph(`1.${FDD0}`)))).toBe(`1.${FDD0}`);
  });
});

describe("jsonContentToMarkdown placeholder yields to runs of U+FDD0 in the text", () => {
  const FDD0 = "\uFDD0";

  it("leaves the user's runs unchanged and ends empty items with their space", () => {
    const out = toMarkdown(
      docOf(
        textParagraph(`x${FDD0.repeat(3)}y`),
        bulletList([listItem([textParagraph(`p${FDD0}q`)])]),
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [{ type: "tableHeader", content: [textParagraph("h")] }],
            },
            {
              type: "tableRow",
              content: [
                { type: "tableCell", content: [textParagraph(`a${FDD0}b`)] },
              ],
            },
          ],
        },
        orderedBlock([listItem([{ type: "paragraph" }])], 1),
        taskBlock([taskEntry([{ type: "paragraph" }])]),
      ),
    );
    expect(out.split(FDD0)).toHaveLength(6);
    expect(out).toContain(`x${FDD0.repeat(3)}y`);
    expect(out).toContain(`- p${FDD0}q`);
    expect(out).toContain(`| a${FDD0}b |`);
    expect(out.split("\n")).toContain("1. ");
    expect(out.endsWith("\n- [ ] ")).toBe(true);
  });

  it("serializes text holding every noncharacter and private-use code point", () => {
    const ranges: ReadonlyArray<readonly [number, number]> = [
      [0xfdd0, 0xfdef],
      [0xe000, 0xf8ff],
      [0xf0000, 0xffffd],
    ];
    let census = "";
    for (const [first, last] of ranges) {
      for (let codePoint = first; codePoint <= last; codePoint++) {
        census += String.fromCodePoint(codePoint);
      }
    }
    const out = toMarkdown(
      docOf(
        textParagraph(census),
        orderedBlock([listItem([{ type: "paragraph" }])], 1),
      ),
    );
    expect(out).toBe(`${census}\n\n1. `);
  });
});

describe("jsonContentToMarkdown writes paragraph text as typed", () => {
  const TEXTS = ["# h", "1. x", "- x"];

  for (const typed of TEXTS) {
    it(`writes "${typed}" as typed at the top level`, () => {
      expect(toMarkdown(docOf(textParagraph(typed)))).toBe(typed);
    });

    it(`writes "${typed}" as typed in a bullet item`, () => {
      expect(
        toMarkdown(docOf(bulletList([listItem([textParagraph(typed)])]))),
      ).toBe(`- ${typed}`);
    });

    it(`writes "${typed}" as typed in an ordered item`, () => {
      expect(
        toMarkdown(docOf(orderedBlock([listItem([textParagraph(typed)])], 1))),
      ).toBe(`1. ${typed}`);
    });
  }
});

describe("jsonContentToMarkdown placeholder against adjacent and very long input", () => {
  const FDD0 = "\uFDD0";
  const emptyOrdered = (): JsonContent =>
    orderedBlock([listItem([{ type: "paragraph" }])], 1);

  function adjacentRuns(): JsonContent {
    return {
      type: "paragraph",
      content: [
        { type: "text", text: FDD0, marks: [{ type: "textStyle" }] },
        { type: "text", text: FDD0 },
      ],
    };
  }

  it("keeps two adjacent U+FDD0 nodes whose marks differ and still writes an empty item's space", () => {
    const out = toMarkdown(docOf(adjacentRuns(), emptyOrdered()));
    expect(out).toContain(`${FDD0}${FDD0}`);
    expect(out).toBe(`${FDD0}${FDD0}\n\n1. `);
  });

  it("keeps two adjacent U+FDD0 nodes in a table cell, where the placeholder becomes a space", () => {
    const table: JsonContent = {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [{ type: "tableHeader", content: [textParagraph("h")] }],
        },
        {
          type: "tableRow",
          content: [{ type: "tableCell", content: [adjacentRuns()] }],
        },
      ],
    };
    const out = toMarkdown(docOf(table, emptyOrdered()));
    expect(out).toBe(`| h |\n| --- |\n| ${FDD0}${FDD0} |\n\n1. `);
  });

  it("keeps adjacent U+FDD0 nodes beside text holding every noncharacter and private-use code point", () => {
    let census = "";
    for (const [first, last] of [
      [0xfdd0, 0xfdef],
      [0xe000, 0xf8ff],
      [0xf0000, 0xffffd],
    ] as const) {
      for (let codePoint = first; codePoint <= last; codePoint++) {
        census += String.fromCodePoint(codePoint);
      }
    }
    const out = toMarkdown(
      docOf(textParagraph(census), adjacentRuns(), emptyOrdered()),
    );
    expect(out).toBe(`${census}\n\n${FDD0}${FDD0}\n\n1. `);
  });

  it("writes thousands of empty items after a very long run in linear size", () => {
    const run = FDD0.repeat(100000);
    const count = 6000;
    const items: JsonContent[] = [];
    const lines: string[] = [];
    for (let index = 1; index <= count; index++) {
      items.push(listItem([{ type: "paragraph" }]));
      lines.push(`${index}. `);
    }
    const out = toMarkdown(docOf(textParagraph(run), orderedBlock(items, 1)));
    const expected = `${run}\n\n${lines.join("\n")}`;
    expect(out.length).toBe(expected.length);
    expect(out === expected).toBe(true);
  });

  it("leaves non-breaking spaces at a document's edges alone", () => {
    expect(toMarkdown(docOf(textParagraph("\u00a0a\u00a0")))).toBe(
      "\u00a0a\u00a0",
    );
  });

  it("trims plain spaces at a document's edges", () => {
    expect(toMarkdown(docOf(textParagraph(" a ")))).toBe("a");
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
