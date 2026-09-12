import { describe, expect, it } from "vitest";
import {
  PIP_HEADLESS_CSS_HEIGHT,
  PIP_HEADLESS_CSS_WIDTH,
  pipHeadlessFrameBudget,
} from "@/lib/browser-view/pip/pip-headless-stream";

describe("pipHeadlessFrameBudget", () => {
  it("asks for the mirror's real pixel count on a 2x display", () => {
    const budget = pipHeadlessFrameBudget(2);
    expect(budget.maxWidth).toBe(PIP_HEADLESS_CSS_WIDTH * 2);
    expect(budget.maxHeight).toBe(PIP_HEADLESS_CSS_HEIGHT * 2);
    expect(budget.deviceScaleFactor).toBe(2);
  });

  it("leaves a 1x display at its own extent", () => {
    const budget = pipHeadlessFrameBudget(1);
    expect(budget.maxWidth).toBe(PIP_HEADLESS_CSS_WIDTH);
    expect(budget.deviceScaleFactor).toBe(1);
  });

  it("caps a 3x panel at 2x, where a further step buys nothing at this size", () => {
    const budget = pipHeadlessFrameBudget(3);
    expect(budget.deviceScaleFactor).toBe(2);
    expect(budget.maxWidth).toBe(PIP_HEADLESS_CSS_WIDTH * 2);
  });

  it("never reports below 1x, including for a nonsense ratio", () => {
    expect(pipHeadlessFrameBudget(0).deviceScaleFactor).toBe(1);
    expect(pipHeadlessFrameBudget(Number.NaN).deviceScaleFactor).toBe(1);
  });

  it("keeps the quantizer well above the retired fixed value", () => {
    // 50 was low enough to be visible on page text in a mirror.
    expect(pipHeadlessFrameBudget(2).quality).toBeGreaterThan(50);
  });
});
