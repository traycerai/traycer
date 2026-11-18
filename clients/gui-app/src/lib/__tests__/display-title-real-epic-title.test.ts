import { describe, expect, it } from "vitest";
import { isRealEpicTitle } from "@/lib/display-title";

describe("isRealEpicTitle", () => {
  it("is false for null", () => {
    expect(isRealEpicTitle(null)).toBe(false);
  });

  it("is false for undefined", () => {
    expect(isRealEpicTitle(undefined)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isRealEpicTitle("")).toBe(false);
  });

  it("is false for whitespace only", () => {
    expect(isRealEpicTitle("   ")).toBe(false);
  });

  it("is false for the GUI's Untitled task fallback", () => {
    expect(isRealEpicTitle("Untitled task")).toBe(false);
  });

  it("is false for the GUI's Untitled task fallback padded with whitespace", () => {
    expect(isRealEpicTitle(" Untitled task ")).toBe(false);
  });

  it("is false for the host's Untitled placeholder", () => {
    expect(isRealEpicTitle("Untitled")).toBe(false);
  });

  it("is true for an ordinary real title", () => {
    expect(isRealEpicTitle("Fix login bug")).toBe(true);
  });

  it("is true for a title that merely contains the fallback as a substring", () => {
    expect(isRealEpicTitle("Untitled tasks")).toBe(true);
  });

  it("is true for a differently-cased placeholder, since the check is case-sensitive", () => {
    expect(isRealEpicTitle("untitled")).toBe(true);
  });
});
