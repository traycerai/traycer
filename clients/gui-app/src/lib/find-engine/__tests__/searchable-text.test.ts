import { describe, expect, it } from "vitest";
import { normalizeSearchableText } from "../searchable-text";

describe("normalizeSearchableText", () => {
  it("collapses a run of two or more spaces or tabs to one space", () => {
    expect(normalizeSearchableText("A[Save  now]")).toBe("A[Save now]");
  });

  it("drops trailing spaces and tabs before a newline", () => {
    expect(normalizeSearchableText("a \t\nb")).toBe("a\nb");
  });

  it("caps three or more newlines at two", () => {
    expect(normalizeSearchableText("a\n\n\n\nb")).toBe("a\n\nb");
  });

  it("unifies CRLF line endings to LF", () => {
    expect(normalizeSearchableText("x\r\ny")).toBe("x\ny");
  });

  it("trims leading and trailing whitespace", () => {
    expect(normalizeSearchableText("  padded  ")).toBe("padded");
  });
});
