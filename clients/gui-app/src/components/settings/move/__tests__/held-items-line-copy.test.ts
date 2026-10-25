import { describe, expect, it } from "vitest";
import { heldItemsHostName } from "@/components/settings/move/held-items-line-copy";

const NOT_THE_WINDOW = { isSource: false, name: null };

describe("heldItemsHostName", () => {
  it("takes the first non-empty name", () => {
    expect(
      heldItemsHostName(["Studio Mac", "MacBook Pro"], NOT_THE_WINDOW),
    ).toBe("Studio Mac");
  });

  it("skips an empty or whitespace name", () => {
    expect(heldItemsHostName(["", "  ", "MacBook Pro"], NOT_THE_WINDOW)).toBe(
      "MacBook Pro",
    );
    expect(heldItemsHostName([null, "MacBook Pro"], NOT_THE_WINDOW)).toBe(
      "MacBook Pro",
    );
  });

  it("calls a host nothing names, other than the window's own, another computer", () => {
    expect(heldItemsHostName([null, ""], NOT_THE_WINDOW)).toBe(
      "another computer",
    );
  });

  it("falls back to the window's own host name, then this computer", () => {
    expect(heldItemsHostName([null], { isSource: true, name: "dev-box" })).toBe(
      "dev-box",
    );
    expect(heldItemsHostName([null], { isSource: true, name: "" })).toBe(
      "this computer",
    );
    expect(heldItemsHostName([null], { isSource: true, name: null })).toBe(
      "this computer",
    );
  });
});
