import { describe, expect, it } from "vitest";

import type { JsonContent } from "../registry";
import { jsonContentToMarkdown } from "../json-content-serializer";

/**
 * GFM table-cell escaping must be mark-aware.
 *
 * A cell used to be escaped AFTER it was rendered: every `\` doubled, every
 * `|` became `\|`. Outside inline code that is the ordinary CommonMark escape
 * and the parser undoes it. Inside inline code CommonMark processes no
 * escapes, so the doubled backslash came back doubled and doubled again on
 * the next disk → doc → disk pass. One artifact row with three regex
 * backslashes in a code span reached 3 × 2^21 characters after ~40 agent
 * appends and blocked the host's event loop inside the markdown lexer for
 * good. Code text therefore keeps its backslashes and escapes only the pipe.
 *
 * The parser (marked's `splitCells`) treats a pipe as escaped when an ODD
 * number of backslashes precede it and then strips exactly one backslash from
 * each `\|`, which is why a pipe after an odd backslash run inside code gets
 * one extra backslash: GFM cannot represent a literal `\|` inside code, so
 * that one case is lossy by design, but it converges instead of splitting the
 * cell or growing.
 */

function text(
  value: string,
  marks: { type: string; attrs?: Record<string, unknown> }[] | undefined,
): JsonContent {
  return marks
    ? { type: "text", text: value, marks }
    : { type: "text", text: value };
}

function cell(content: JsonContent[], header: boolean): JsonContent {
  return {
    type: header ? "tableHeader" : "tableCell",
    content: [{ type: "paragraph", content }],
  };
}

// One header row (`h`) and one body row holding `content` in its only cell.
function tableDoc(content: JsonContent[]): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          { type: "tableRow", content: [cell([text("h", undefined)], true)] },
          { type: "tableRow", content: [cell(content, false)] },
        ],
      },
    ],
  };
}

function paragraphDoc(content: JsonContent[]): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph", content }],
  };
}

function toMarkdown(content: JsonContent): string {
  return jsonContentToMarkdown(content, {
    mentionFormat: "llm",
    platform: "POSIX",
  });
}

function bodyRow(markdown: string): string {
  const rows = markdown.split("\n");
  expect(rows).toHaveLength(3);
  expect(rows[0]).toBe("| h |");
  expect(rows[1]).toBe("| --- |");
  return rows[2];
}

describe("table cell escaping inside inline code", () => {
  it("keeps backslashes inside an inline code cell exactly as stored", () => {
    const doc = tableDoc([
      text("grep ", undefined),
      text("\\.tuple\\)", [{ type: "code" }]),
      text(" found 1", undefined),
    ]);

    expect(bodyRow(toMarkdown(doc))).toBe("| grep `\\.tuple\\)` found 1 |");
  });

  it("escapes a pipe inside inline code without touching its backslashes", () => {
    const doc = tableDoc([text("a|b\\c", [{ type: "code" }])]);

    expect(bodyRow(toMarkdown(doc))).toBe("| `a\\|b\\c` |");
  });

  it("keeps the escaped pipe's backslash parity odd after a backslash run inside code", () => {
    // One backslash before the pipe: `\|` alone would read as an even run and
    // split the cell, so one more is added.
    expect(
      bodyRow(toMarkdown(tableDoc([text("a\\|b", [{ type: "code" }])]))),
    ).toBe("| `a\\\\\\|b` |");
    // Two backslashes before the pipe already leave `\|` as an odd run.
    expect(
      bodyRow(toMarkdown(tableDoc([text("a\\\\|b", [{ type: "code" }])]))),
    ).toBe("| `a\\\\\\|b` |");
    // Adjacent pipes are each escaped on their own.
    expect(
      bodyRow(toMarkdown(tableDoc([text("a||b", [{ type: "code" }])]))),
    ).toBe("| `a\\|\\|b` |");
  });

  it("escapes plain cell text the CommonMark way around the code span", () => {
    const doc = tableDoc([
      text("see\\ ", undefined),
      text("x|y", [{ type: "code" }]),
      text(" done|", undefined),
    ]);

    expect(bodyRow(toMarkdown(doc))).toBe("| see\\\\ `x\\|y` done\\| |");
  });
});

describe("table cell escaping outside inline code (unchanged)", () => {
  it("doubles backslashes and escapes pipes in plain cell text", () => {
    expect(bodyRow(toMarkdown(tableDoc([text("a\\b|c", undefined)])))).toBe(
      "| a\\\\b\\|c |",
    );
  });

  it("keeps a trailing backslash from escaping the pipe it precedes", () => {
    expect(bodyRow(toMarkdown(tableDoc([text("a\\|", undefined)])))).toBe(
      "| a\\\\\\| |",
    );
  });

  it("escapes plain text inside a bold span in a cell", () => {
    expect(
      bodyRow(toMarkdown(tableDoc([text("a|b", [{ type: "bold" }])]))),
    ).toBe("| **a\\|b** |");
  });
});

describe("controls: the same code text outside a table is not escaped", () => {
  it("leaves an inline code span in a paragraph alone", () => {
    const doc = paragraphDoc([
      text("grep ", undefined),
      text("\\.tuple\\)|x", [{ type: "code" }]),
    ]);

    expect(toMarkdown(doc)).toBe("grep `\\.tuple\\)|x`");
  });

  it("leaves a fenced code block alone", () => {
    const doc: JsonContent = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "" },
          content: [text("grep '\\.tuple\\)' | wc -l", undefined)],
        },
      ],
    };

    expect(toMarkdown(doc)).toBe("```\ngrep '\\.tuple\\)' | wc -l\n```");
  });
});
