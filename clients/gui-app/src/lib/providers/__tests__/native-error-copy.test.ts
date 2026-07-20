import { describe, expect, it } from "vitest";
import { nativeErrorMessage } from "@/lib/providers/native-error-copy";

describe("nativeErrorMessage", () => {
  it("prefers non-empty detail over code copy", () => {
    expect(nativeErrorMessage("duplicate_name", "  already there  ")).toBe(
      "already there",
    );
  });

  it("falls back to code copy when detail is empty", () => {
    expect(nativeErrorMessage("unsupported_action", null)).toBe(
      "This action is not supported for this provider.",
    );
    expect(nativeErrorMessage("unsupported_scope", "   ")).toBe(
      "This action is not supported for the selected scope.",
    );
  });
});
