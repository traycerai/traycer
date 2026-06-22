import { describe, expect, it } from "vitest";
import { deriveToolInputSummary } from "@/lib/segment-summary";

describe("deriveToolInputSummary", () => {
  describe("read_file / write_file / edit_file", () => {
    it("formats path with line range", () => {
      expect(
        deriveToolInputSummary("read_file", {
          path: "src/foo.ts",
          startLine: 1,
          endLine: 50,
        }),
      ).toBe("src/foo.ts:1-50");
    });

    it("formats path with single line", () => {
      expect(
        deriveToolInputSummary("write_file", {
          path: "src/foo.ts",
          startLine: 5,
        }),
      ).toBe("src/foo.ts:5");
    });

    it("falls back to plain path", () => {
      expect(deriveToolInputSummary("edit_file", { path: "src/bar.ts" })).toBe(
        "src/bar.ts",
      );
    });

    it("accepts filePath alias", () => {
      expect(
        deriveToolInputSummary("read_file", { filePath: "src/x.ts" }),
      ).toBe("src/x.ts");
    });
  });

  describe("glob / grep", () => {
    it("returns the glob pattern", () => {
      expect(deriveToolInputSummary("glob", { pattern: "src/**/*.ts" })).toBe(
        "src/**/*.ts",
      );
    });

    it("formats grep query with optional path", () => {
      expect(
        deriveToolInputSummary("grep", {
          query: "useState",
          path: "src/",
        }),
      ).toBe("useState in src/");
    });
  });

  describe("bash / run_command", () => {
    it("returns the command string", () => {
      expect(deriveToolInputSummary("bash", { command: "bun run test" })).toBe(
        "bun run test",
      );
    });
  });

  describe("web_fetch / web_search", () => {
    it("returns the url", () => {
      expect(
        deriveToolInputSummary("web_fetch", { url: "https://example.com" }),
      ).toBe("https://example.com");
    });

    it("returns the search query", () => {
      expect(
        deriveToolInputSummary("web_search", { query: "react 19 features" }),
      ).toBe("react 19 features");
    });
  });

  describe("generic fallback", () => {
    it("picks first priority key", () => {
      expect(
        deriveToolInputSummary("custom_tool", {
          extra: "ignored",
          name: "important",
        }),
      ).toBe("important");
    });

    it("uses first string value when no priority key matches", () => {
      expect(
        deriveToolInputSummary("custom_tool", { customField: "hello" }),
      ).toBe("hello");
    });

    it("returns null for non-record, non-string inputs", () => {
      expect(deriveToolInputSummary("custom_tool", 42)).toBeNull();
      expect(deriveToolInputSummary("custom_tool", null)).toBeNull();
      expect(deriveToolInputSummary("custom_tool", [])).toBeNull();
    });

    it("accepts a bare string input", () => {
      expect(deriveToolInputSummary("custom_tool", "hi there")).toBe(
        "hi there",
      );
    });
  });

  it("collapses whitespace and truncates long inputs", () => {
    const long = "a".repeat(120);
    const result = deriveToolInputSummary("custom_tool", { name: long });
    expect(result).not.toBeNull();
    expect((result ?? "").length).toBeLessThanOrEqual(80);
    expect(result).toMatch(/…$/);
  });

  it("treats whitespace-only field values as missing (no dangling separator)", () => {
    expect(deriveToolInputSummary("bash", { command: "   " })).toBeNull();
    expect(
      deriveToolInputSummary("custom_tool", { name: "  \n\t " }),
    ).toBeNull();
    expect(deriveToolInputSummary("custom_tool", "   ")).toBeNull();
  });
});
