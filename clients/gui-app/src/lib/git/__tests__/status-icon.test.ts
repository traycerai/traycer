import { describe, expect, it } from "vitest";
import { statusBadgeStyle } from "../status-icon";

describe("statusBadgeStyle", () => {
  it("maps added status", () => {
    const result = statusBadgeStyle("added");
    expect(result).toEqual({ letter: "A", tone: "success", label: "Added" });
  });

  it("maps modified status", () => {
    const result = statusBadgeStyle("modified");
    expect(result).toEqual({ letter: "M", tone: "warning", label: "Modified" });
  });

  it("maps deleted status", () => {
    const result = statusBadgeStyle("deleted");
    expect(result).toEqual({
      letter: "D",
      tone: "destructive",
      label: "Deleted",
    });
  });

  it("maps renamed status", () => {
    const result = statusBadgeStyle("renamed");
    expect(result).toEqual({ letter: "R", tone: "primary", label: "Renamed" });
  });

  it("maps copied status", () => {
    const result = statusBadgeStyle("copied");
    expect(result).toEqual({ letter: "C", tone: "muted", label: "Copied" });
  });

  it("maps untracked status", () => {
    const result = statusBadgeStyle("untracked");
    expect(result).toEqual({
      letter: "A",
      tone: "success",
      label: "New file",
    });
  });

  it("maps conflicted status", () => {
    const result = statusBadgeStyle("conflicted");
    expect(result).toEqual({
      letter: "!",
      tone: "destructive",
      label: "Conflicted",
    });
  });
});
