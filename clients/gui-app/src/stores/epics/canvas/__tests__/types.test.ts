import { describe, expect, it } from "vitest";
import { isOpenableEpicNodeKind } from "@/stores/epics/canvas/types";

describe("isOpenableEpicNodeKind", () => {
  it("accepts all first-class openable kinds including review", () => {
    expect(isOpenableEpicNodeKind("chat")).toBe(true);
    expect(isOpenableEpicNodeKind("spec")).toBe(true);
    expect(isOpenableEpicNodeKind("ticket")).toBe(true);
    expect(isOpenableEpicNodeKind("story")).toBe(true);
    expect(isOpenableEpicNodeKind("review")).toBe(true);
  });

  it("rejects non-openable kinds", () => {
    expect(isOpenableEpicNodeKind("terminal")).toBe(false);
    expect(isOpenableEpicNodeKind("workspace")).toBe(false);
    expect(isOpenableEpicNodeKind("not-a-kind")).toBe(false);
  });
});
