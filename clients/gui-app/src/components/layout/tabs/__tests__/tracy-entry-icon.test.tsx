/**
 * The Tracy entry's glyph through the REAL `TracyEntryIcon`: Tracy is a bot,
 * so it is drawn as the default mascot at the strip's 16px size and never
 * as the robot glyph an agent wears, bare or wearing its muted mark.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultMascotDrawing,
  drawsRobotGlyph,
  renderedMascotDrawing,
} from "@/components/bots/__tests__/mascot-drawing";
import { TracyEntryIcon } from "@/components/layout/tabs/tracy-strip-entry";

afterEach(cleanup);

function mountIcon(muted: boolean): HTMLElement {
  render(<TracyEntryIcon className={undefined} muted={muted} />);
  return screen.getByTestId("tracy-entry-icon");
}

function expectPlainMascot(icon: HTMLElement): void {
  expect(renderedMascotDrawing(icon)).toEqual(defaultMascotDrawing(16));
  expect(drawsRobotGlyph(icon)).toBe(false);
}

describe("<TracyEntryIcon />", () => {
  it("draws the default mascot at 16px, not the robot glyph, bare", () => {
    expectPlainMascot(mountIcon(false));
    expect(screen.queryByTestId("tracy-entry-muted")).toBeNull();
  });

  it("keeps the mascot and wears the muted mark", () => {
    expectPlainMascot(mountIcon(true));
    expect(screen.getByTestId("tracy-entry-muted")).toBeTruthy();
  });
});
