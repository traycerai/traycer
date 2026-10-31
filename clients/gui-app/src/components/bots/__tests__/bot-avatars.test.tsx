/**
 * A bot's picture (Tracy Bots, T97): two bots side by side never draw the
 * same initials on the same swatch when their names or swatches tell them
 * apart, and every surface draws one bot the same way.
 *
 * The ids are real derived main-bot ids, `personalAssistantBotId(envId)` in
 * the internal repository's `bot-schemas.ts`: the personal assistant of
 * `env_personal`, and the team main bots of `env_team_a` and `env_team_s`.
 * `env_team_s` was found by deriving `env_team_b`, `env_team_c`, ... in turn
 * and keeping the first whose FNV-1a hash lands on `env_team_a`'s hash mod 12
 * (the 12 swatches bots drew from before T97) and off it mod 24, so the two
 * "Team Tracy" bots shared one swatch then and differ now.
 */
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BotAvatar, NamedBotAvatar } from "@/components/bots/bot-avatars";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";

const PERSONAL_MAIN_BOT_ID = "bot_019YFRXBQ551DN29WCTHKM3CEP";
const TEAM_A_MAIN_BOT_ID = "bot_0RVWRHPMH8WPT9KW1NGKJB319D";
const TEAM_S_MAIN_BOT_ID = "bot_0YVZD4PHYFAZS1MCR0D9GABAGV";

interface DrawnAvatar {
  readonly initials: string;
  readonly swatch: string;
  readonly ink: string;
}

function drawn(): DrawnAvatar[] {
  return screen.getAllByTestId("bot-avatar").map((avatar) => {
    const fallback = avatar.querySelector<HTMLElement>(
      '[data-slot="avatar-fallback"]',
    );
    if (fallback === null) throw new Error("the avatar drew no initials");
    return {
      initials: fallback.textContent,
      swatch: fallback.style.getPropertyValue("--swatch"),
      ink: fallback.classList.contains("text-white") ? "light" : "dark",
    };
  });
}

function sideBySide(
  bots: ReadonlyArray<{ readonly botId: string; readonly title: string }>,
): DrawnAvatar[] {
  render(
    <>
      {bots.map((bot) => (
        <NamedBotAvatar
          key={bot.botId}
          botId={bot.botId}
          title={bot.title}
          size="sm"
        />
      ))}
    </>,
  );
  return drawn();
}

afterEach(() => {
  cleanup();
});

describe("a bot's picture", () => {
  it("draws the personal main bot and a team's main bot with different initials and swatches", () => {
    const [personal, team] = sideBySide([
      { botId: PERSONAL_MAIN_BOT_ID, title: "Tracy" },
      { botId: TEAM_A_MAIN_BOT_ID, title: "Team Tracy" },
    ]);

    expect(personal.initials).toBe("TR");
    expect(team.initials).toBe("TT");
    expect(personal.swatch).not.toBe(team.swatch);
  });

  it("draws two bots of one name in different environments on different swatches", () => {
    const [teamA, teamS] = sideBySide([
      { botId: TEAM_A_MAIN_BOT_ID, title: "Team Tracy" },
      { botId: TEAM_S_MAIN_BOT_ID, title: "Team Tracy" },
    ]);

    // One hue in its two tones: the light swatch takes dark initials, the
    // deep one white.
    expect(teamA).toEqual({ initials: "TT", swatch: "#f97316", ink: "dark" });
    expect(teamS).toEqual({ initials: "TT", swatch: "#c2410c", ink: "light" });
  });

  it("draws one bot the same in a sidebar row as on its own surface's header and message rows", () => {
    function OnItsSurface(): ReactElement {
      return (
        <BotIdentityContext.Provider
          value={{
            botId: TEAM_S_MAIN_BOT_ID,
            title: "Team Tracy",
            owner: null,
          }}
        >
          <BotAvatar size="sm" />
        </BotIdentityContext.Provider>
      );
    }
    render(
      <>
        <NamedBotAvatar
          botId={TEAM_S_MAIN_BOT_ID}
          title="Team Tracy"
          size="sm"
        />
        <OnItsSurface />
      </>,
    );

    const [row, surface] = drawn();
    expect(row).toEqual(surface);
  });

  it("keeps a bot's swatch through a rename", () => {
    const [before] = sideBySide([
      { botId: TEAM_A_MAIN_BOT_ID, title: "Team Tracy" },
    ]);
    cleanup();
    const [after] = sideBySide([{ botId: TEAM_A_MAIN_BOT_ID, title: "Ops" }]);

    expect(after.initials).toBe("OP");
    expect(after.swatch).toBe(before.swatch);
  });
});
