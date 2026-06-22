import { describe, expect, it } from "vitest";
import { backoffFor, jitteredBackoffFor } from "../backoff";

describe("backoffFor", () => {
  it("returns the initial delay for the first attempt", () => {
    expect(backoffFor(0, 100, 1_000)).toBe(100);
  });

  it("doubles each attempt up to the ceiling", () => {
    expect(backoffFor(1, 100, 1_000)).toBe(200);
    expect(backoffFor(2, 100, 1_000)).toBe(400);
    expect(backoffFor(3, 100, 1_000)).toBe(800);
    expect(backoffFor(4, 100, 1_000)).toBe(1_000);
    expect(backoffFor(99, 100, 1_000)).toBe(1_000);
  });
});

describe("jitteredBackoffFor", () => {
  it("scales the base delay into [0.5, 1) of the schedule", () => {
    // random = 0 → exactly half the base; random → 1 → the full base.
    expect(jitteredBackoffFor(2, 100, 1_000, () => 0)).toBe(200);
    expect(jitteredBackoffFor(2, 100, 1_000, () => 0.5)).toBe(300);
    expect(jitteredBackoffFor(2, 100, 1_000, () => 0.999)).toBe(400);
  });

  it("never exceeds the ceiling base", () => {
    expect(jitteredBackoffFor(99, 100, 1_000, () => 0.999)).toBeLessThanOrEqual(
      1_000,
    );
  });
});
