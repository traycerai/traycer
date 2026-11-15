/**
 * The Tracy tab's icon on its FIRST render, as every strip placement renders
 * the tab's `icon`: Tracy is a bot, so it is the default 16px mascot,
 * never the robot glyph, with nothing to wait for.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import {
  defaultMascotDrawing,
  drawsRobotGlyph,
  renderedMascotDrawing,
} from "@/components/bots/__tests__/mascot-drawing";
import { tracyTabModule } from "@/stores/tabs/kinds/tracy";

afterEach(cleanup);

it("draws the default mascot at 16px on first render, not the robot glyph", () => {
  const { icon: Icon } = tracyTabModule.build({
    hostId: "host-1",
    botId: null,
  });
  if (Icon === null) throw new Error("the Tracy tab has no icon");

  const { container } = render(<Icon className={undefined} />);

  expect(renderedMascotDrawing(container)).toEqual(defaultMascotDrawing(16));
  expect(drawsRobotGlyph(container)).toBe(false);
});
