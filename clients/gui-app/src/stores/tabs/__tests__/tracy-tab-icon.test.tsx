/**
 * The Tracy tab's icon, as every strip placement renders the tab's `icon`:
 * Tracy is a bot, so it is the plain bot's 16px mascot, never the robot glyph.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  PLAIN_BOT_ID,
  drawsRobotGlyph,
  mascotPathsAt,
  renderedMascotPaths,
} from "@/components/bots/__tests__/mascot-drawing";
import { tracyTabModule } from "@/stores/tabs/kinds/tracy";

afterEach(cleanup);

it("draws the plain bot's mascot at 16px, not the robot glyph", async () => {
  const { icon: Icon } = tracyTabModule.build({
    hostId: "host-1",
    botId: null,
  });
  if (Icon === null) throw new Error("the Tracy tab has no icon");

  // The picture loads apart from the tab kind; loaded here first, so the
  // wait below is for React to draw it and not for the import.
  await import("@/components/bots/tracy-entry-picture");
  const { container } = render(<Icon className={undefined} />);

  await waitFor(() =>
    expect(renderedMascotPaths(container)).toEqual(
      mascotPathsAt(PLAIN_BOT_ID, false, 16),
    ),
  );
  expect(drawsRobotGlyph(container)).toBe(false);
});
