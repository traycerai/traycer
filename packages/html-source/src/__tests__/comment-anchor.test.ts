import { describe, expect, it } from "vitest";

import { commentAnchorStatus } from "../index";

// A comment anchor outlives edits to the file it points into, so the status is
// recomputed from the current bytes: it answers whether the thing the comment
// was written about can still be found, never where it moved to.

const SOURCE = [
  `<main data-tid="root">`,
  `<h1 data-tid="title">Launch  plan</h1>`,
  `<p data-tid="body">Ship &amp; measure the <b>new</b>\n   onboarding flow.</p>`,
  `</main>`,
].join("");

describe("commentAnchorStatus", () => {
  it("treats an artifact anchor as present whatever the source holds", () => {
    expect(commentAnchorStatus("", { kind: "artifact" })).toBe("present");
    expect(commentAnchorStatus(SOURCE, { kind: "artifact" })).toBe("present");
  });

  describe("element anchors", () => {
    it("is present when exactly one element carries the tid", () => {
      expect(
        commentAnchorStatus(SOURCE, { kind: "element", elementId: "title" }),
      ).toBe("present");
    });

    it("is missing when no element carries the tid", () => {
      expect(
        commentAnchorStatus(SOURCE, { kind: "element", elementId: "gone" }),
      ).toBe("missing");
    });

    it("is missing when the tid is duplicated, because it no longer names one element", () => {
      const duplicated = `<p data-tid="dup">a</p><p data-tid="dup">b</p>`;
      expect(
        commentAnchorStatus(duplicated, { kind: "element", elementId: "dup" }),
      ).toBe("missing");
    });
  });

  describe("text anchors", () => {
    function textAnchor(elementId: string, quotedText: string) {
      return { kind: "text", elementId, quotedText } as const;
    }

    it("is present when the element's text contains the quote", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("body", "measure the")),
      ).toBe("present");
    });

    it("compares decoded text, so an entity in the source matches its character", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("body", "Ship & measure")),
      ).toBe("present");
      expect(
        commentAnchorStatus(SOURCE, textAnchor("body", "Ship &amp; measure")),
      ).toBe("missing");
    });

    it("matches a quote that spans inline elements", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("body", "the new onboarding")),
      ).toBe("present");
    });

    it("ignores differences in whitespace runs on both sides and trims the quote", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("title", "Launch plan")),
      ).toBe("present");
      expect(
        commentAnchorStatus(SOURCE, textAnchor("title", "  Launch \n plan  ")),
      ).toBe("present");
      expect(
        commentAnchorStatus(SOURCE, textAnchor("body", "new onboarding")),
      ).toBe("present");
    });

    it("is missing when the quote is empty or only whitespace", () => {
      expect(commentAnchorStatus(SOURCE, textAnchor("body", ""))).toBe(
        "missing",
      );
      expect(commentAnchorStatus(SOURCE, textAnchor("body", " \n\t "))).toBe(
        "missing",
      );
    });

    it("is missing when the quote is no longer in the element's text", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("body", "retire the flow")),
      ).toBe("missing");
    });

    it("is missing when the element is gone or its tid is duplicated", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("gone", "Launch plan")),
      ).toBe("missing");
      const duplicated = `<p data-tid="dup">same words</p><p data-tid="dup">same words</p>`;
      expect(
        commentAnchorStatus(duplicated, textAnchor("dup", "same words")),
      ).toBe("missing");
    });

    it("stays present when the quote moves to another place inside the element", () => {
      const before = `<p data-tid="p">Alpha beta gamma</p>`;
      const after = `<p data-tid="p">Gamma first, then <i>alpha</i> and beta, ending with Alpha beta gamma</p>`;
      const quote = textAnchor("p", "Alpha beta gamma");
      expect(commentAnchorStatus(before, quote)).toBe("present");
      expect(commentAnchorStatus(after, quote)).toBe("present");
    });

    it("does not look for the quote outside its own element", () => {
      expect(
        commentAnchorStatus(SOURCE, textAnchor("title", "onboarding flow")),
      ).toBe("missing");
    });
  });
});
