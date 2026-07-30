import { describe, expect, it } from "vitest";
import { absent, indeterminate, observed } from "../evidence";

describe("evidence constructors", () => {
  it("builds an observed evidence value", () => {
    expect(observed<number, "cause-a">(42)).toEqual({
      kind: "observed",
      value: 42,
    });
  });

  it("builds an absent evidence value", () => {
    expect(absent<number, "cause-a">()).toEqual({ kind: "absent" });
  });

  it("builds an indeterminate evidence value with its cause", () => {
    expect(indeterminate<number, "cause-a">("cause-a")).toEqual({
      kind: "indeterminate",
      cause: "cause-a",
    });
  });
});
