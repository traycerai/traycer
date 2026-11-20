import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import {
  drawsColouredMascot,
  expectedTracyGlyph,
  renderedTracyGlyphs,
} from "@/components/bots/__tests__/mascot-drawing";
import { botCategoryIcon } from "@/lib/composer/mentions/mention-entry-display";

afterEach(cleanup);

const SOME_BOT_ID = "bot_0YVZD4PHYFAZS1MCR0D9GABAGV";

function expectMutedTracyGlyph(container: HTMLElement): void {
  expect(renderedTracyGlyphs(container)).toEqual([expectedTracyGlyph(16)]);
  expect(drawsColouredMascot(container)).toBe(false);
  expect(
    container
      .querySelector('[data-testid="tracy-glyph"]')
      ?.classList.contains("text-muted-foreground"),
  ).toBe(true);
}

describe("botCategoryIcon", () => {
  it("draws the muted 16px Tracy glyph for the Tracy category", () => {
    const { container } = render(botCategoryIcon());

    expectMutedTracyGlyph(container);
  });

  it("is still the glyph inside a bot's surface, not that bot's coloured mascot", () => {
    const { container } = render(
      <BotIdentityContext.Provider
        value={{ botId: SOME_BOT_ID, title: "Team Tracy", owner: null }}
      >
        {botCategoryIcon()}
      </BotIdentityContext.Provider>,
    );

    expectMutedTracyGlyph(container);
  });
});
