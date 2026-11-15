import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import {
  defaultMascotDrawing,
  mascotPathsAt,
  renderedMascotDrawing,
} from "@/components/bots/__tests__/mascot-drawing";
import { botCategoryIcon } from "@/lib/composer/mentions/mention-entry-display";

afterEach(cleanup);

const SOME_BOT_ID = "bot_0YVZD4PHYFAZS1MCR0D9GABAGV";

describe("botCategoryIcon", () => {
  it("draws the default 16px mascot for the Tracy category", () => {
    const { container } = render(botCategoryIcon());

    expect(renderedMascotDrawing(container)).toEqual(defaultMascotDrawing(16));
  });

  it("still draws the default mascot inside a bot's surface, not that bot's own", () => {
    const { container } = render(
      <BotIdentityContext.Provider
        value={{ botId: SOME_BOT_ID, title: "Team Tracy", owner: null }}
      >
        {botCategoryIcon()}
      </BotIdentityContext.Provider>,
    );

    expect(renderedMascotDrawing(container)).toEqual(defaultMascotDrawing(16));
    expect(renderedMascotDrawing(container).paths).not.toEqual(
      mascotPathsAt(SOME_BOT_ID, false, 16),
    );
  });
});
