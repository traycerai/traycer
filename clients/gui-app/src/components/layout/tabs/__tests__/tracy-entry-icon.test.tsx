/**
 * The Tracy entry's glyph through the REAL `TracyEntryIcon`: Tracy is a bot,
 * so it is drawn as the plain bot's mascot at the strip's 16px size and never
 * as the robot glyph an agent wears, bare or wearing its muted mark.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  PLAIN_BOT_ID,
  drawsRobotGlyph,
  mascotPathsAt,
  renderedMascotPaths,
} from "@/components/bots/__tests__/mascot-drawing";
import { TracyEntryIcon } from "@/components/layout/tabs/tracy-strip-entry";

afterEach(cleanup);

function mountIcon(muted: boolean): HTMLElement {
  render(<TracyEntryIcon className={undefined} muted={muted} />);
  return screen.getByTestId("tracy-entry-icon");
}

function expectPlainMascot(icon: HTMLElement): void {
  expect(renderedMascotPaths(icon)).toEqual(
    mascotPathsAt(PLAIN_BOT_ID, false, 16),
  );
  expect(drawsRobotGlyph(icon)).toBe(false);
}

describe("<TracyEntryIcon />", () => {
  it("draws the plain bot's mascot at 16px, not the robot glyph, bare", () => {
    expectPlainMascot(mountIcon(false));
    expect(screen.queryByTestId("tracy-entry-unread-count")).toBeNull();
    expect(screen.queryByTestId("tracy-entry-muted")).toBeNull();
  });

  it("keeps the mascot and wears the muted mark", () => {
    expectPlainMascot(mountIcon(true));
    expect(screen.getByTestId("tracy-entry-muted")).toBeTruthy();
  });
});
