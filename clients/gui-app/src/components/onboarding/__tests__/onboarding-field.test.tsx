import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { OnboardingField } from "@/components/onboarding/onboarding-field";

// jsdom has no WebGL - `getContext` returns null here exactly as it does on a
// machine with no GL at all, which is the branch worth pinning: the tour must
// still mount, and the static grid must take the canvas's place.
describe("OnboardingField", () => {
  afterEach(() => {
    cleanup();
  });

  it("falls back to the static dot grid when there is no WebGL context", () => {
    const { container } = render(<OnboardingField welcoming />);
    expect(container.querySelector("canvas")).toBeNull();
    const grid = container.querySelector(".onboarding-dot-grid");
    expect(grid).not.toBeNull();
    expect(grid?.getAttribute("aria-hidden")).toBe("true");
  });
});
