import { describe, expect, it } from "vitest";
import { findModelBlock, isModelBlocked } from "../is-model-blocked";

const kimiK3 = { harnessId: "kimi", model: "kimi-code/k3" };

describe("isModelBlocked", () => {
  it("matches an exact model block", () => {
    expect(
      isModelBlocked(kimiK3, [
        { harnessId: "kimi", model: "kimi-code/k3" },
      ]),
    ).toBe(true);
  });

  it("matches a whole-provider block", () => {
    expect(
      isModelBlocked(kimiK3, [{ harnessId: "kimi", model: null }]),
    ).toBe(true);
  });

  it("ignores a block on a different harness", () => {
    expect(
      isModelBlocked(kimiK3, [{ harnessId: "omp", model: "kimi-code/k3" }]),
    ).toBe(false);
  });

  it("matches a token inside a compound slug", () => {
    expect(
      isModelBlocked(
        { harnessId: "omp", model: "verboo-ultra/kimi-k3" },
        [{ harnessId: "omp", model: "kimi" }],
      ),
    ).toBe(true);
  });

  it("returns the matching block entry", () => {
    const block = {
      harnessId: "kimi",
      model: "kimi-code/k3",
      note: "out of balance",
    };
    expect(findModelBlock(kimiK3, [block])).toBe(block);
  });
});
