import { describe, expect, it, vi } from "vitest";

import type { JsonContent } from "../registry";
import {
  jsonContentToArtifactMarkdown,
  jsonContentToMarkdown,
  unresolvedArtifactImageText,
  type ArtifactImage,
  type ArtifactImageReader,
} from "../json-content-serializer";

/**
 * `jsonContentToArtifactMarkdown` escapes plain text wherever the parser would
 * otherwise read markup, so the md -> doc -> md pass every artifact write runs
 * is a fixed point (traycer#1563). `jsonContentToMarkdown` keeps the raw text:
 * prompts are read by a model or a person, who gains nothing from a backslash.
 */

type Mark = { type: string; attrs?: Record<string, unknown> };

const OPTIONS = { mentionFormat: "llm", platform: "POSIX" } as const;

function text(value: string, marks: Mark[] | undefined): JsonContent {
  return marks
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function plain(value: string): JsonContent {
  return text(value, undefined);
}

function paragraph(content: JsonContent[]): JsonContent {
  return { type: "paragraph", content };
}

function doc(content: JsonContent[]): JsonContent {
  return { type: "doc", content };
}

function paragraphDoc(content: JsonContent[]): JsonContent {
  return doc([paragraph(content)]);
}

function listItem(content: JsonContent[]): JsonContent {
  return { type: "listItem", content };
}

function bulletList(items: JsonContent[]): JsonContent {
  return { type: "bulletList", content: items };
}

// Protocol cannot carry the artifact parser, so the reader here is a stub that
// knows only the simplest image shape: one line, `![alt](dest)` with a flat
// alt and a bare or bracketed destination. What the REAL parser reads as one
// image is covered where that parser lives (the gui-app round trip).
const SIMPLE_IMAGE = /^!\[([^[\]\n]*)\]\((?:<([^<>\n]*)>|([^\s()<>]*))\)$/;

const simpleImageReader: ArtifactImageReader = (markdown) => {
  const match = SIMPLE_IMAGE.exec(markdown);
  if (match === null) return null;
  return { alt: match[1] ?? "", src: match[2] ?? match[3] ?? "" };
};

function artifactWith(
  content: JsonContent,
  readImage: ArtifactImageReader,
): string {
  return jsonContentToArtifactMarkdown(content, OPTIONS, readImage);
}

function artifact(content: JsonContent): string {
  return artifactWith(content, simpleImageReader);
}

function prompt(content: JsonContent): string {
  return jsonContentToMarkdown(content, OPTIONS);
}

function artifactOf(value: string): string {
  return artifact(paragraphDoc([plain(value)]));
}

function tableDoc(content: JsonContent[]): JsonContent {
  const cell = (body: JsonContent[], header: boolean): JsonContent => ({
    type: header ? "tableHeader" : "tableCell",
    content: [paragraph(body)],
  });
  return doc([
    {
      type: "table",
      content: [
        { type: "tableRow", content: [cell([plain("h")], true)] },
        { type: "tableRow", content: [cell(content, false)] },
      ],
    },
  ]);
}

describe("artifact text escaping: inline characters", () => {
  it("escapes an asterisk", () => {
    expect(artifactOf("a * b")).toBe("a \\* b");
  });

  it("escapes a backtick", () => {
    expect(artifactOf("a ` b")).toBe("a \\` b");
  });

  it("escapes a tilde", () => {
    expect(artifactOf("a ~ b")).toBe("a \\~ b");
  });

  it("escapes an opening bracket and leaves a closing bracket alone outside a link", () => {
    expect(artifactOf("a [b] c")).toBe("a \\[b] c");
  });

  it("escapes an underscore that is not intraword", () => {
    expect(artifactOf("a _b_ c")).toBe("a \\_b\\_ c");
  });

  it("escapes an angle bracket only before a letter, slash, bang or question mark", () => {
    expect(artifactOf("a <b> c < d")).toBe("a \\<b> c < d");
    expect(artifactOf("a </b> c")).toBe("a \\</b> c");
    expect(artifactOf("a <!-- c")).toBe("a \\<!-- c");
    expect(artifactOf("a <?x c")).toBe("a \\<?x c");
    expect(artifactOf("a <3 c")).toBe("a <3 c");
  });

  it("escapes an ampersand only before a complete entity reference", () => {
    expect(artifactOf("&amp; and AT&T")).toBe("\\&amp; and AT&T");
  });

  it("escapes a backslash before ASCII punctuation and at the end of a text segment", () => {
    expect(artifactOf("a\\*b")).toBe("a\\\\\\*b");
    expect(artifactOf("a\\")).toBe("a\\\\");
  });

  it("leaves a backslash before a letter alone", () => {
    expect(artifactOf("a\\b")).toBe("a\\b");
  });

  it("escapes a closing bracket inside link text", () => {
    const linked = paragraphDoc([
      text("a]b", [{ type: "link", attrs: { href: "https://example.com/x" } }]),
    ]);
    expect(artifact(linked)).toBe("[a\\]b](https://example.com/x)");
  });
});

describe("artifact text escaping: text that must not change", () => {
  it("leaves intraword underscores in identifiers alone", () => {
    expect(artifactOf("foo_bar_baz and snake_case_name")).toBe(
      "foo_bar_baz and snake_case_name",
    );
  });

  it("leaves text inside a code mark literal", () => {
    expect(artifact(paragraphDoc([text("_ * \\ [", [{ type: "code" }])]))).toBe(
      "`_ * \\ [`",
    );
  });

  it("leaves a code block's text literal", () => {
    const codeBlock: JsonContent = {
      type: "codeBlock",
      attrs: { language: "" },
      content: [plain("_ * \\ [ # x")],
    };
    expect(artifact(doc([codeBlock]))).toBe("```\n_ * \\ [ # x\n```");
  });

  it("escapes a link's text but not its href", () => {
    const linked = paragraphDoc([
      text("a_b *c*", [
        { type: "link", attrs: { href: "https://example.com/_x_" } },
      ]),
    ]);
    expect(artifact(linked)).toBe("[a_b \\*c\\*](https://example.com/_x_)");
  });

  it("writes a link whose text is its absolute URL as an autolink without escapes", () => {
    const linked = paragraphDoc([
      text("https://example.com/_x_", [
        { type: "link", attrs: { href: "https://example.com/_x_" } },
      ]),
    ]);
    expect(artifact(linked)).toBe("<https://example.com/_x_>");
  });
});

describe("artifact text escaping: line-start block markers", () => {
  it("escapes an ATX heading marker", () => {
    expect(artifactOf("# x")).toBe("\\# x");
  });

  it("escapes a dash bullet marker", () => {
    expect(artifactOf("- x")).toBe("\\- x");
  });

  it("escapes a plus bullet marker", () => {
    expect(artifactOf("+ x")).toBe("\\+ x");
  });

  it("escapes a block quote marker", () => {
    expect(artifactOf("> x")).toBe("\\> x");
  });

  it("escapes an ordered list marker after the digits", () => {
    expect(artifactOf("1. x")).toBe("1\\. x");
  });

  it("escapes a long ordered list marker", () => {
    expect(artifactOf("2024. A year")).toBe("2024\\. A year");
  });

  it("escapes a thematic break", () => {
    expect(artifactOf("---")).toBe("\\---");
  });

  it("leaves a hashtag without a space alone", () => {
    expect(artifactOf("#hashtag")).toBe("#hashtag");
  });

  it("leaves a dash without a space alone", () => {
    expect(artifactOf("-x")).toBe("-x");
  });

  it("escapes a heading marker inside a bullet list item", () => {
    const list = doc([bulletList([listItem([paragraph([plain("# kept")])])])]);
    expect(artifact(list)).toBe("- \\# kept");
  });

  it("escapes a task checkbox inside a bullet list item", () => {
    const list = doc([
      bulletList([listItem([paragraph([plain("[ ] not a task")])])]),
    ]);
    expect(artifact(list)).toBe("- \\[ ] not a task");
  });
});

describe("artifact text escaping: later lines of a paragraph", () => {
  it("escapes an ordered marker of 1 on a later line", () => {
    expect(artifactOf("a\n1. b")).toBe("a\n1\\. b");
  });

  it("leaves an ordered marker other than 1 on a later line alone", () => {
    expect(artifactOf("a\n2. b")).toBe("a\n2. b");
  });

  it("escapes a setext underline on a later line", () => {
    expect(artifactOf("a\n===")).toBe("a\n\\===");
  });

  it("does not escape a line start inside an inline code span", () => {
    const content = paragraphDoc([
      plain("a "),
      text("x\n# y", [{ type: "code" }]),
    ]);
    expect(artifact(content)).toBe("a `x\n# y`");
  });
});

describe("artifact text escaping: table cells", () => {
  it("escapes a cell's markup characters as well as its pipes", () => {
    const content = tableDoc([plain("*x* p_q _r | s")]);
    expect(artifact(content)).toBe(
      "| h |\n| --- |\n| \\*x\\* p_q \\_r \\| s |",
    );
  });

  it("doubles a backslash in front of an escaped pipe so the cell does not split", () => {
    const content = tableDoc([plain("a\\|b")]);
    expect(artifact(content)).toBe("| h |\n| --- |\n| a\\\\\\|b |");
  });

  it("leaves code text in a cell to the pipe-only code rule", () => {
    const content = tableDoc([text("c_d*e\\f|g", [{ type: "code" }])]);
    expect(artifact(content)).toBe(prompt(content));
    expect(artifact(content)).toBe("| h |\n| --- |\n| `c_d*e\\f\\|g` |");
  });

  it("keeps the prompt serializer's cell escaping", () => {
    const content = tableDoc([plain("p_q and * | \\")]);
    expect(prompt(content)).toBe("| h |\n| --- |\n| p_q and * \\| \\\\ |");
  });
});

describe("artifact block quotes", () => {
  const quoteOf = (blocks: JsonContent[]): JsonContent =>
    doc([{ type: "blockquote", content: blocks }]);

  it("writes a quote as a markdown block quote with its marks", () => {
    const content = quoteOf([
      paragraph([plain("quote "), text("b", [{ type: "bold" }])]),
    ]);
    expect(artifact(content)).toBe("> quote **b**");
  });

  it("separates two paragraphs of a quote with an empty quote line", () => {
    const content = quoteOf([paragraph([plain("a")]), paragraph([plain("b")])]);
    expect(artifact(content)).toBe("> a\n>\n> b");
  });

  it("quotes a bullet list inside a quote", () => {
    const content = quoteOf([
      bulletList([
        listItem([paragraph([plain("x")])]),
        listItem([paragraph([plain("y")])]),
      ]),
    ]);
    expect(artifact(content)).toBe("> - x\n> - y");
  });

  it("keeps the prompt serializer's user_quoted_section form", () => {
    const content = quoteOf([
      paragraph([plain("quote "), text("b", [{ type: "bold" }])]),
    ]);
    expect(prompt(content)).toBe(
      "<user_quoted_section>quote b</user_quoted_section>",
    );
  });
});

describe("prompt serializer leaves plain text raw", () => {
  it("does not escape emphasis characters", () => {
    expect(prompt(paragraphDoc([plain("a *b* c")]))).toBe("a *b* c");
  });
});

// A later paragraph's blank line belongs to traycerai/traycer#2574, which
// adds it for every caller; these pin only what stays artifact-specific.
describe("artifact list items with several blocks", () => {
  it("keeps a first block's later lines inside the item", () => {
    const list = doc([
      bulletList([
        listItem([
          {
            type: "blockquote",
            content: [paragraph([plain("a")]), paragraph([plain("b")])],
          },
        ]),
      ]),
    ]);
    expect(artifact(list)).toBe("- > a\n  >\n  > b");
  });

  it("puts every line of a later block at the item's content column", () => {
    const list = doc([
      bulletList([
        listItem([
          paragraph([plain("a")]),
          {
            type: "blockquote",
            content: [paragraph([plain("q")]), paragraph([plain("r")])],
          },
        ]),
      ]),
    ]);
    expect(artifact(list)).toBe("- a\n  > q\n  >\n  > r");
  });
});

describe("artifact hard breaks", () => {
  const hardBreak: JsonContent = { type: "hardBreak" };
  const brokenParagraph = (): JsonContent =>
    paragraph([plain("First"), hardBreak, plain("Second")]);

  it("writes a hard break as a backslash and newline in an artifact and a bare newline in a prompt", () => {
    const content = doc([brokenParagraph()]);
    expect(artifact(content)).toBe("First\\\nSecond");
    expect(prompt(content)).toBe("First\nSecond");
  });

  it("indents the line after a hard break under the bullet item's marker", () => {
    const content = doc([bulletList([listItem([brokenParagraph()])])]);
    expect(artifact(content)).toBe("- First\\\n  Second");
  });

  it("escapes a block marker at the start of the line after a hard break", () => {
    const after = (value: string): string =>
      artifact(
        doc([paragraph([plain("First"), { type: "hardBreak" }, plain(value)])]),
      );
    expect(after("# not a heading")).toBe("First\\\n\\# not a heading");
    expect(after("- x")).toBe("First\\\n\\- x");
    expect(after("> q")).toBe("First\\\n\\> q");
  });

  it("keeps one to three spaces after a hard break and escapes the marker behind them", () => {
    const after = (value: string): string =>
      artifact(
        doc([paragraph([plain("First"), { type: "hardBreak" }, plain(value)])]),
      );
    expect(after("  - x")).toBe("First\\\n  \\- x");
    expect(after("  # x")).toBe("First\\\n  \\# x");
    expect(after("   > x")).toBe("First\\\n   \\> x");
  });

  it("escapes a literal backslash before a newline in text so it is not read back as a hard break", () => {
    expect(artifactOf("a\\\nb")).toBe("a\\\\\nb");
  });

  it("writes a hard break in a task item as a backslash and newline, like any other list item", () => {
    const content = doc([
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [brokenParagraph()],
          },
        ],
      },
    ]);
    expect(artifact(content)).toBe("- [ ] First\\\n  Second");
  });

  // traycer#1563: a hard break in a task item is a backslash and newline like
  // any other list item's, and the line after it keeps its escape.
  const taskDoc = (checked: boolean, next: string): JsonContent =>
    doc([
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked },
            content: [paragraph([plain("a"), hardBreak, plain(next)])],
          },
        ],
      },
    ]);

  it("writes a hard break in a task item as a backslash and newline, and escapes the next line", () => {
    expect(artifact(taskDoc(false, "- s"))).toBe("- [ ] a\\\n  \\- s");
    expect(artifact(taskDoc(true, "# h"))).toBe("- [x] a\\\n  \\# h");
    expect(artifact(taskDoc(false, "plain"))).toBe("- [ ] a\\\n  plain");
  });

  it("still writes a plain newline for a task item's hard break in a prompt", () => {
    expect(prompt(taskDoc(false, "s"))).toBe("- [ ] a\n  s");
  });

  it("keeps the bare newline in a table cell, as the prompt serializer does", () => {
    const content = tableDoc([plain("First"), hardBreak, plain("Second")]);
    expect(artifact(content)).toBe(prompt(content));
    expect(artifact(content)).not.toContain("\\");
  });
});

describe("artifact unresolved image source text", () => {
  // What the host writes for an image it cannot resolve yet; kept raw so the
  // next read parses it as an image again and retries it.
  const verbatim = (value: string): void => {
    expect(artifactOf(value)).toBe(value);
  };

  it("writes an image whose source is not a portable name verbatim", () => {
    verbatim("![not-portable](images/not-a-64hex-name.png)");
  });

  it("writes the bracketed destination form verbatim", () => {
    verbatim("![a b](<images/a b (1).png>)");
  });

  it("writes an image with an empty alt verbatim and leaves its underscore alone", () => {
    verbatim("![](https://example.com/x_y.png)");
  });

  it("keeps it verbatim behind a bullet item's marker", () => {
    const content = doc([
      bulletList([listItem([paragraph([plain("![a](b.png)")])])]),
    ]);
    expect(artifact(content)).toBe("- ![a](b.png)");
  });

  it("escapes one text node that is an image followed by a link, which is not one image", () => {
    expect(artifactOf("![x](a) [y](b)")).toBe("!\\[x](a) \\[y](b)");
  });

  it("still escapes the text when more text follows in the same node", () => {
    expect(artifactOf("![a](b.png) tail")).toBe("!\\[a](b.png) tail");
  });

  it("still escapes the text when it carries a mark", () => {
    const content = paragraphDoc([text("![a](b.png)", [{ type: "bold" }])]);
    expect(artifact(content)).toBe("**!\\[a](b.png)**");
  });

  it("still escapes the text when the paragraph holds another text node", () => {
    const content = paragraphDoc([
      plain("![a](b.png)"),
      text("x", [{ type: "italic" }]),
    ]);
    expect(artifact(content)).toBe("!\\[a](b.png)*x*");
  });

  it("still escapes a bare destination that contains a space", () => {
    expect(artifactOf("![a](b c.png)")).toBe("!\\[a](b c.png)");
  });

  it("leaves the prompt serializer's output for the image text unchanged", () => {
    const content = paragraphDoc([plain("![not-portable](images/x_y.png)")]);
    expect(prompt(content)).toBe("![not-portable](images/x_y.png)");
  });
});

describe("artifact block quote inside nested list items", () => {
  it("writes a list inside a quote in a third-level item right after the quote marker", () => {
    const innerList = bulletList([listItem([paragraph([plain("x")])])]);
    const quote: JsonContent = { type: "blockquote", content: [innerList] };
    const content = doc([
      bulletList([
        listItem([
          paragraph([plain("a")]),
          bulletList([
            listItem([
              paragraph([plain("b")]),
              bulletList([listItem([paragraph([plain("c")]), quote])]),
            ]),
          ]),
        ]),
      ]),
    ]);
    expect(artifact(content)).toBe("- a\n  - b\n    - c\n      > - x");
  });
});

describe("artifact block markers behind leading spaces", () => {
  it("escapes in front of the marker on a later line indented one to three spaces", () => {
    expect(artifactOf("a\n  # h")).toBe("a\n  \\# h");
    expect(artifactOf("a\n  - x")).toBe("a\n  \\- x");
    expect(artifactOf("a\n   > q")).toBe("a\n   \\> q");
    expect(artifactOf("a\n  1. x")).toBe("a\n  1\\. x");
    expect(artifactOf("a\n  ===")).toBe("a\n  \\===");
  });

  it("keeps one to three leading spaces on a paragraph's first line and escapes the marker behind them", () => {
    const second = (value: string): string =>
      artifact(doc([paragraph([plain("first")]), paragraph([plain(value)])]));
    expect(second("  # h")).toBe("first\n\n  \\# h");
    expect(second("   - x")).toBe("first\n\n   \\- x");
    expect(second("  plain")).toBe("first\n\n  plain");
  });

  // The artifact form trims only the line breaks at the start of the document:
  // one to three leading spaces of the first paragraph are its own text, and
  // the parser reads them back at the document start.
  it("keeps one to three leading spaces of a paragraph that opens the document", () => {
    expect(artifactOf(" code")).toBe(" code");
    expect(artifactOf("  code")).toBe("  code");
    expect(artifactOf("   code")).toBe("   code");
  });

  it("keeps one to three leading spaces before a heading marker that opens the document, and escapes the marker", () => {
    expect(artifactOf(" # h")).toBe(" \\# h");
    expect(artifactOf("  # h")).toBe("  \\# h");
    expect(artifactOf("   # h")).toBe("   \\# h");
  });

  it("still trims leading line breaks at the start of the document", () => {
    expect(artifact(doc([paragraph([plain("\n\n  code")])]))).toBe("  code");
  });

  it("leaves the prompt serializer trimming the leading spaces of the document", () => {
    expect(prompt(paragraphDoc([plain("  code")]))).toBe("code");
    expect(prompt(paragraphDoc([plain("   # h")]))).toBe("# h");
  });

  // Four or more spaces (or a tab) open an indented code block, which nothing
  // can escape, so a paragraph's first line drops them once. The same goes for
  // the paragraph that opens the document.
  it("drops the leading whitespace of a paragraph that would make an indented code block", () => {
    expect(artifactOf("    code-looking")).toBe("code-looking");
    expect(artifactOf("\tcode-looking")).toBe("code-looking");
    const second = (value: string): string =>
      artifact(doc([paragraph([plain("first")]), paragraph([plain(value)])]));
    expect(second("    code-looking")).toBe("first\n\ncode-looking");
    expect(second("\tcode-looking")).toBe("first\n\ncode-looking");
    expect(second("  # h")).toBe("first\n\n  \\# h");
  });

  it("drops it in a bullet item's second paragraph too", () => {
    const item = (value: string): string =>
      artifact(
        doc([
          bulletList([
            listItem([paragraph([plain("a")]), paragraph([plain(value)])]),
          ]),
        ]),
      );
    expect(item("    code-looking")).toBe("- a\n\n  code-looking");
    expect(item("  # h")).toBe("- a\n\n    \\# h");
  });
});

describe("artifact hard breaks in a quote inside a task item", () => {
  it("writes the break as a backslash and newline, because the quote is not the task item's text", () => {
    const quote: JsonContent = {
      type: "blockquote",
      content: [
        paragraph([plain("First"), { type: "hardBreak" }, plain("Second")]),
      ],
    };
    const content = doc([
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [quote],
          },
        ],
      },
    ]);
    // The quote is the item's first child, so its first line follows the task
    // marker, and every quote line carries `> ` with its hard break written as
    // one.
    expect(artifact(content)).toBe("- [ ] > First\\\n  > Second");
  });
});

describe("artifact line after a hard break in a list item with four or more leading columns", () => {
  type Kind = "bullet" | "ordered" | "task";
  const item = (kind: Kind, next: string): string => {
    const content = paragraph([
      plain("First"),
      { type: "hardBreak" },
      plain(next),
    ]);
    return artifact(
      doc([
        kind === "bullet"
          ? bulletList([listItem([content])])
          : kind === "ordered"
            ? {
                type: "orderedList",
                attrs: { start: 10, type: null },
                content: [listItem([content])],
              }
            : {
                type: "taskList",
                content: [
                  {
                    type: "taskItem",
                    attrs: { checked: false },
                    content: [content],
                  },
                ],
              },
      ]),
    );
  };

  // The item's parser takes exactly four columns off a line indented four or
  // more past the item's content column, so four more are written in front
  // and the line reads back with exactly the spaces it had.
  it("writes four extra spaces in front of a line indented four or more, so the spaces are kept", () => {
    // bullet: 2 (content column) + 4 (extra) + 4 (the text's own)
    expect(item("bullet", "    code")).toBe(
      "- First\\\n" + " ".repeat(10) + "code",
    );
    // ordered 10: 4 + 4 + 4
    expect(item("ordered", "    code")).toBe(
      "10. First\\\n" + " ".repeat(12) + "code",
    );
    // task: the content column is the bullet's, 2, as for a bullet
    expect(item("task", "    code")).toBe(
      "- [ ] First\\\n" + " ".repeat(10) + "code",
    );
  });

  it("keeps five spaces", () => {
    expect(item("bullet", "     x")).toBe("- First\\\n" + " ".repeat(11) + "x");
    expect(item("ordered", "     x")).toBe(
      "10. First\\\n" + " ".repeat(13) + "x",
    );
  });

  it("keeps four spaces before a heading marker as text, which is not a heading at that depth", () => {
    expect(item("bullet", "    # h")).toBe(
      "- First\\\n" + " ".repeat(10) + "# h",
    );
  });

  it("writes a tab as it is, behind the item's indent and the four extra spaces", () => {
    expect(item("bullet", "\tcode")).toBe(
      "- First\\\n" + " ".repeat(6) + "\tcode",
    );
    expect(item("bullet", "  \tcode")).toBe(
      "- First\\\n" + " ".repeat(8) + "\tcode",
    );
  });

  it("keeps one to three leading spaces as text there, escaping the marker behind them", () => {
    expect(item("bullet", "   # h")).toBe("- First\\\n     \\# h");
  });

  it("keeps all the spaces on the line after a hard break in a top-level paragraph", () => {
    expect(
      artifact(
        doc([
          paragraph([plain("First"), { type: "hardBreak" }, plain("    code")]),
        ]),
      ),
    ).toBe("First\\\n    code");
  });

  it("leaves the prompt serializer's output for the same item unchanged", () => {
    const content = doc([
      bulletList([
        listItem([
          paragraph([plain("First"), { type: "hardBreak" }, plain("    code")]),
        ]),
      ]),
    ]);
    expect(prompt(content)).toBe("- First\n      code");
  });
});

describe("artifact paragraph ends", () => {
  const hardBreak: JsonContent = { type: "hardBreak" };

  // CommonMark has no way to write a hard break that ends a paragraph: the
  // backslash would read back as a literal one the person never typed.
  it("drops a trailing hard break", () => {
    expect(artifact(paragraphDoc([plain("First"), hardBreak]))).toBe("First");
    expect(artifact(paragraphDoc([plain("First"), hardBreak, hardBreak]))).toBe(
      "First",
    );
  });

  it("keeps a hard break in the middle and drops the trailing one", () => {
    expect(
      artifact(paragraphDoc([plain("a"), hardBreak, plain("b"), hardBreak])),
    ).toBe("a\\\nb");
  });

  // Unmarked text of only spaces and tabs renders as nothing, so a hard break
  // before it ends the paragraph's text all the same.
  it("drops a trailing hard break that is followed by only a space", () => {
    expect(artifact(paragraphDoc([plain("a"), hardBreak, plain(" ")]))).toBe(
      "a",
    );
  });

  it("drops a trailing hard break that is followed by only a tab", () => {
    expect(artifact(paragraphDoc([plain("a"), hardBreak, plain("\t")]))).toBe(
      "a",
    );
  });

  it("keeps the middle hard break when whitespace follows the trailing one", () => {
    expect(
      artifact(
        paragraphDoc([
          plain("a"),
          hardBreak,
          plain("b"),
          hardBreak,
          plain(" "),
        ]),
      ),
    ).toBe("a\\\nb");
  });

  it("drops a trailing hard break and whitespace in a list item too", () => {
    expect(
      artifact(
        doc([
          bulletList([
            listItem([paragraph([plain("a"), hardBreak, plain(" ")])]),
          ]),
        ]),
      ),
    ).toBe("- a");
  });

  it("drops a trailing hard break in a list item too", () => {
    expect(
      artifact(
        doc([bulletList([listItem([paragraph([plain("First"), hardBreak])])])]),
      ),
    ).toBe("- First");
  });

  it("leaves the prompt serializer's trailing hard break to its own trim", () => {
    expect(prompt(paragraphDoc([plain("First"), hardBreak]))).toBe("First");
  });

  // CommonMark drops the spaces and tabs that end a line, and two or more
  // before a line break would read as a hard break.
  it("drops spaces and tabs that end a paragraph", () => {
    expect(artifactOf("code  ")).toBe("code");
    expect(artifactOf("code ")).toBe("code");
    expect(artifactOf("code\t")).toBe("code");
  });

  it("keeps the spaces before a hard break, which the backslash holds in place", () => {
    expect(
      artifact(paragraphDoc([plain("First  "), hardBreak, plain("x")])),
    ).toBe("First  \\\nx");
  });

  it("writes a paragraph of only whitespace as an empty one", () => {
    expect(artifactOf("    ")).toBe("");
    expect(artifactOf("  ")).toBe("");
  });
});

describe("artifact unresolved image text: the reader decides", () => {
  const paragraphOfText = (value: string): JsonContent =>
    doc([paragraph([plain(value)])]);

  it("builds the host's text for an image from its alt and source", () => {
    expect(unresolvedArtifactImageText("a", "x.png")).toBe("![a](x.png)");
    expect(unresolvedArtifactImageText("", "x")).toBe("![](x)");
    expect(unresolvedArtifactImageText("a b", "images/a b.png")).toBe(
      "![a b](<images/a b.png>)",
    );
    expect(unresolvedArtifactImageText("a", "x(1).png")).toBe(
      "![a](<x(1).png>)",
    );
  });

  it("writes the text verbatim when the reader reads it as one image whose text it is", () => {
    const reader = vi.fn((): ArtifactImage => ({ alt: "a [b] c", src: "x" }));
    expect(artifactWith(paragraphOfText("![a [b] c](x)"), reader)).toBe(
      "![a [b] c](x)",
    );
    expect(reader).toHaveBeenCalledWith("![a [b] c](x)");
  });

  it("writes the bracketed form verbatim when the source needs it", () => {
    const reader: ArtifactImageReader = () => ({
      alt: "a",
      src: "images/a b (1).png",
    });
    expect(
      artifactWith(paragraphOfText("![a](<images/a b (1).png>)"), reader),
    ).toBe("![a](<images/a b (1).png>)");
  });

  it("escapes the text when the reader reads no image", () => {
    const reader: ArtifactImageReader = () => null;
    expect(artifactWith(paragraphOfText("![a](x)"), reader)).toBe("!\\[a](x)");
  });

  it("escapes the text when the image the reader reads has another text", () => {
    // Another alt:
    expect(
      artifactWith(paragraphOfText("![a](x)"), () => ({ alt: "b", src: "x" })),
    ).toBe("!\\[a](x)");
    // Another source:
    expect(
      artifactWith(paragraphOfText("![a](x)"), () => ({ alt: "a", src: "y" })),
    ).toBe("!\\[a](x)");
    // The same source, written bracketed where the host's text is bare:
    expect(
      artifactWith(paragraphOfText("![a](<x>)"), () => ({
        alt: "a",
        src: "x",
      })),
    ).toBe("!\\[a](\\<x>)");
    // The same source, written bare where the host's text brackets it:
    expect(
      artifactWith(paragraphOfText("![a](x y)"), () => ({
        alt: "a",
        src: "x y",
      })),
    ).toBe("!\\[a](x y)");
  });

  it("does not ask the reader about text that cannot be one image", () => {
    const reader = vi.fn((): ArtifactImage => ({ alt: "a", src: "x" }));
    const notCandidates: JsonContent[] = [
      paragraphOfText("plain text"),
      paragraphOfText("a ![a](x)"),
      paragraphOfText("![a](x) tail"),
      paragraphOfText("![a](x"),
      paragraphOfText("[a](x)"),
      paragraphOfText("!a](x)"),
      paragraphOfText("![a](x)\n![b](y)"),
      paragraphOfText("![a](x\n)"),
      // Not one unmarked text node:
      doc([paragraph([text("![a](x)", [{ type: "bold" }])])]),
      doc([paragraph([plain("![a]"), plain("(x)")])]),
    ];
    for (const content of notCandidates) {
      artifactWith(content, reader);
    }
    expect(reader).not.toHaveBeenCalled();
  });

  it("does not ask the reader inside a table cell", () => {
    const reader = vi.fn((): ArtifactImage => ({ alt: "a", src: "x" }));
    const content = doc([
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [paragraph([plain("![a](x)")])],
              },
            ],
          },
        ],
      },
    ]);
    artifactWith(content, reader);
    expect(reader).not.toHaveBeenCalled();
  });

  it("leaves the prompt serializer's output for the same text unchanged", () => {
    expect(prompt(paragraphOfText("![a [b] c](x)"))).toBe("![a [b] c](x)");
  });
});

describe("artifact empty list markers inside a block quote", () => {
  const emptyTask: JsonContent = {
    type: "taskList",
    content: [
      { type: "taskItem", attrs: { checked: false }, content: [paragraph([])] },
    ],
  };
  const emptyOrdered: JsonContent = {
    type: "orderedList",
    attrs: { start: 10, type: null },
    content: [listItem([paragraph([])])],
  };
  const quote = (inner: JsonContent): JsonContent => ({
    type: "blockquote",
    content: [inner],
  });
  // Private-use and noncharacter code points the serializer could use to hold
  // a marker's trailing space through its trim.
  const PLACEHOLDER = new RegExp(String.raw`[\uFDD0-\uFDEF\uE000-\uF8FF]`, "u");

  it("keeps the space after an empty task marker in a quote", () => {
    const md = artifact(doc([quote(emptyTask)]));
    expect(md).toBe("> - [ ] ");
    expect(md).not.toMatch(PLACEHOLDER);
  });

  it("keeps the space after an empty ordered marker in a quote", () => {
    const md = artifact(doc([quote(emptyOrdered)]));
    expect(md).toBe("> 10. ");
    expect(md).not.toMatch(PLACEHOLDER);
  });

  it("keeps the space after the marker in a nested quote", () => {
    const md = artifact(doc([quote(quote(emptyTask))]));
    expect(md).toBe("> > - [ ] ");
    expect(md).not.toMatch(PLACEHOLDER);
  });

  it("keeps the space when the quote follows a paragraph inside a list item", () => {
    const md = artifact(
      doc([
        bulletList([listItem([paragraph([plain("a")]), quote(emptyTask)])]),
      ]),
    );
    expect(md).toBe("- a\n  > - [ ] ");
    expect(md).not.toMatch(PLACEHOLDER);
  });

  it("keeps the space when the quote is a list item's first block", () => {
    const task = artifact(doc([bulletList([listItem([quote(emptyTask)])])]));
    expect(task).toBe("- > - [ ] ");
    expect(task).not.toMatch(PLACEHOLDER);
    const ordered = artifact(
      doc([bulletList([listItem([quote(emptyOrdered)])])]),
    );
    expect(ordered).toBe("- > 10. ");
    expect(ordered).not.toMatch(PLACEHOLDER);
  });
});

describe("artifact image node: the reader picks the alt spelling", () => {
  const imageDoc = (alt: string, src: string): JsonContent =>
    doc([{ type: "image", attrs: { src, alt } }]);
  // A reader that accepts exactly the listed spellings, as the image `alt`
  // and `src` they stand for.
  const accepting =
    (
      accepted: readonly string[],
      alt: string,
      src: string,
    ): ArtifactImageReader =>
    (markdown) =>
      accepted.includes(markdown) ? { alt, src } : null;

  it("writes the usual escaped spelling when the reader accepts it", () => {
    const reader = vi.fn(accepting(["![a\\[b\\]](x)"], "a[b]", "x"));
    expect(artifactWith(imageDoc("a[b]", "x"), reader)).toBe("![a\\[b\\]](x)");
    // The escaped form is asked first, and nothing else once it is accepted.
    expect(reader).toHaveBeenCalledTimes(1);
    expect(reader).toHaveBeenCalledWith("![a\\[b\\]](x)");
  });

  it("writes the brackets-only spelling when the reader rejects the escaped one and accepts it", () => {
    // Alt `a \ b`: the escaped spelling doubles the backslash.
    const reader = vi.fn(accepting(["![a \\ b](x)"], "a \\ b", "x"));
    expect(artifactWith(imageDoc("a \\ b", "x"), reader)).toBe("![a \\ b](x)");
    expect(reader.mock.calls.map((call) => call[0])).toEqual([
      "![a \\\\ b](x)",
      "![a \\ b](x)",
    ]);
  });

  it("falls to the host's own text when the reader accepts neither bracket spelling", () => {
    const text = unresolvedArtifactImageText("a ] b", "x");
    const reader = accepting([text], "a ] b", "x");
    expect(artifactWith(imageDoc("a ] b", "x"), reader)).toBe(text);
  });

  it("falls back to the escaped spelling when the reader accepts none", () => {
    expect(artifactWith(imageDoc("a \\ b", "x"), () => null)).toBe(
      "![a \\\\ b](x)",
    );
  });

  it("does not take a spelling the reader reads as another alt or source", () => {
    // Accepts the escaped spelling, but as a different alt: rejected, and the
    // brackets-only one is taken.
    const reader: ArtifactImageReader = (markdown) =>
      markdown === "![a \\\\ b](x)"
        ? { alt: "a \\\\ b", src: "x" }
        : markdown === "![a \\ b](x)"
          ? { alt: "a \\ b", src: "x" }
          : null;
    expect(artifactWith(imageDoc("a \\ b", "x"), reader)).toBe("![a \\ b](x)");
  });

  it("leaves the prompt serializer's spelling alone", () => {
    expect(prompt(imageDoc("a \\ b", "x"))).toBe("![a \\\\ b](x)");
  });
});

describe("artifact image node: an alt no spelling reads back exactly", () => {
  const imageDoc = (alt: string, src: string): JsonContent =>
    doc([{ type: "image", attrs: { src, alt } }]);

  // The alt is a lone backtick. The spellings are:
  //   1, 2, 3  ![o`](s)     (a backtick is not escaped)
  //   4, 5     ![o\`](s)    (the backtick is escaped)
  // The stub reads the first as no image and the second as an image whose alt
  // keeps the backslash, so no spelling reads back as "o`".
  const BARE = "![o`](s)";
  const ESCAPED = "![o\\`](s)";
  const KEPT_BACKSLASH = "o\\`";

  it("writes the first spelling whose read-back image is written with the same bytes again", () => {
    const reader = vi.fn<ArtifactImageReader>((markdown) =>
      markdown === ESCAPED ? { alt: KEPT_BACKSLASH, src: "s" } : null,
    );
    expect(artifactWith(imageDoc("o`", "s"), reader)).toBe(ESCAPED);
    // The image it read back is written, as its own first exact spelling, with
    // those very bytes: the alt changes once and then every pass is the same.
    expect(artifactWith(imageDoc(KEPT_BACKSLASH, "s"), reader)).toBe(ESCAPED);
  });

  it("does not take a spelling whose read-back is written differently next time", () => {
    // The reader reads every spelling as another alt, "other", and "other" is
    // written as `![other](s)`, never as the bytes tried: nothing settles.
    const reader: ArtifactImageReader = () => ({ alt: "other", src: "s" });
    expect(artifactWith(imageDoc("o`", "s"), reader)).toBe(BARE);
  });

  it("falls to the first spelling when no spelling settles, even if the reader reads none", () => {
    expect(artifactWith(imageDoc("o`", "s"), () => null)).toBe(BARE);
  });

  it("does not settle on a spelling whose read-back image has another source", () => {
    const reader: ArtifactImageReader = (markdown) =>
      markdown === ESCAPED ? { alt: KEPT_BACKSLASH, src: "other" } : null;
    expect(artifactWith(imageDoc("o`", "s"), reader)).toBe(BARE);
  });
});
