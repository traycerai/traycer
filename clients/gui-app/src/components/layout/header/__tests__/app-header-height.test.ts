import { describe, expect, it } from "vitest";
import {
  APP_HEADER_HEIGHT,
  APP_HEADER_HEIGHT_CLASS,
  BELOW_APP_HEADER_TOP_CLASS,
} from "@/components/layout/header/app-header-height";

// Tailwind's default spacing step; `h-10` is `calc(var(--spacing) * 10)`.
const SPACING_STEP_REM = 0.25;

describe("app header height", () => {
  it("keeps the CSS length in step with the height and offset classes", () => {
    const heightSteps = Number(APP_HEADER_HEIGHT_CLASS.replace(/^h-/, ""));
    const topSteps = Number(BELOW_APP_HEADER_TOP_CLASS.replace(/^top-/, ""));

    expect(topSteps).toBe(heightSteps);
    expect(APP_HEADER_HEIGHT).toBe(`${heightSteps * SPACING_STEP_REM}rem`);
  });
});
