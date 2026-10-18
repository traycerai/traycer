import { describe, expect, it } from "vitest";
import { splitForMiddleTruncation } from "@/lib/middle-truncation";

describe("splitForMiddleTruncation", () => {
  it("keeps the distinguishing end whole and lets the rest shrink", () => {
    expect(splitForMiddleTruncation("Q3-report-final-v12.pdf", 8)).toEqual({
      head: "Q3-report-final",
      tail: "-v12.pdf",
    });
  });

  it("puts a text no longer than the tail all in the tail", () => {
    expect(splitForMiddleTruncation("a.md", 8)).toEqual({
      head: "",
      tail: "a.md",
    });
  });

  it("never cuts an emoji in two", () => {
    const { head, tail } = splitForMiddleTruncation("chart 👩🏽‍💻 v2", 4);
    expect(`${head}${tail}`).toBe("chart 👩🏽‍💻 v2");
    expect(tail).toBe("👩🏽‍💻 v2");
  });
});
