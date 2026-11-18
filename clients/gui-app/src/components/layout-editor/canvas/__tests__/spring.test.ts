import { describe, expect, it } from "vitest";
import {
  MAX_SPRING_STEP_SECONDS,
  RING_SPRING,
  Spring,
} from "@/components/layout-editor/canvas/spring";

const FRAME = 1 / 60;

function run(spring: Spring, frames: number): number[] {
  const path: number[] = [];
  for (let frame = 0; frame < frames; frame += 1) path.push(spring.step(FRAME));
  return path;
}

describe("the critically damped stepper", () => {
  it("arrives without ever passing the target", () => {
    const spring = new Spring(0, RING_SPRING.response, RING_SPRING.zeta);
    spring.setTarget(100);

    const path = run(spring, 120);

    expect(Math.max(...path)).toBeLessThanOrEqual(100);
    expect(path.at(-1)).toBeCloseTo(100, 1);
    // Monotonic: a critically damped spring has no wobble to hide.
    for (let index = 1; index < path.length; index += 1)
      expect(path[index]).toBeGreaterThanOrEqual(path[index - 1] ?? 0);
  });

  it("is unsettled while travelling and settled once arrived", () => {
    const spring = new Spring(0, RING_SPRING.response, RING_SPRING.zeta);
    spring.setTarget(100);
    spring.step(FRAME);

    expect(spring.settled()).toBe(false);

    run(spring, 120);

    expect(spring.settled()).toBe(true);
  });

  it("stays stable when a dropped frame hands it a long step", () => {
    const spring = new Spring(0, RING_SPRING.response, RING_SPRING.zeta);
    spring.setTarget(100);

    // The loop clamps at this value, which is the largest step the integrator
    // is asked to take.
    for (let frame = 0; frame < 120; frame += 1)
      spring.step(MAX_SPRING_STEP_SECONDS);

    expect(spring.value).toBeCloseTo(100, 1);
  });

  it("snaps with no momentum left to carry", () => {
    const spring = new Spring(0, RING_SPRING.response, RING_SPRING.zeta);
    spring.setTarget(100);
    run(spring, 10);

    spring.snap(40);

    expect(spring.value).toBe(40);
    expect(spring.settled()).toBe(true);
    expect(spring.step(FRAME)).toBe(40);
  });
});
