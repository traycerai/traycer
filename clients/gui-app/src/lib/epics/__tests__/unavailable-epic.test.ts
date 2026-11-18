import { describe, expect, it } from "vitest";
import { isUnavailableEpicCode } from "@/lib/epics/unavailable-epic";

describe("isUnavailableEpicCode", () => {
  it("routes availability by protocol code rather than diagnostic text", () => {
    expect(isUnavailableEpicCode("NOT_FOUND")).toBe(true);
    expect(isUnavailableEpicCode("UNAUTHORIZED")).toBe(false);
  });
});
