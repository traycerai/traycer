/**
 * The Tracy entry's glyph through the REAL `TracyEntryIcon`: Tracy is a bot,
 * so it is drawn as the one-colour Tracy glyph at the strip's 16px size, with
 * no coloured mascot and never the robot glyph an agent wears, bare or wearing its muted mark.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  drawsColouredMascot,
  drawsRobotGlyph,
  expectedTracyGlyph,
  renderedTracyGlyphs,
} from "@/components/bots/__tests__/mascot-drawing";
import { TracyEntryIcon } from "@/components/layout/tabs/tracy-strip-entry";

afterEach(cleanup);

function mountIcon(muted: boolean): HTMLElement {
  render(<TracyEntryIcon className={undefined} muted={muted} />);
  return screen.getByTestId("tracy-entry-icon");
}

function expectTracyGlyph(icon: HTMLElement): void {
  expect(renderedTracyGlyphs(icon)).toEqual([expectedTracyGlyph(16)]);
  expect(drawsColouredMascot(icon)).toBe(false);
  expect(drawsRobotGlyph(icon)).toBe(false);
}

describe("<TracyEntryIcon />", () => {
  it("draws the Tracy glyph at 16px, not the robot glyph, bare", () => {
    expectTracyGlyph(mountIcon(false));
    expect(screen.queryByTestId("tracy-entry-muted")).toBeNull();
  });

  it("keeps the glyph and wears the muted mark", () => {
    expectTracyGlyph(mountIcon(true));
    expect(screen.getByTestId("tracy-entry-muted")).toBeTruthy();
  });
});
