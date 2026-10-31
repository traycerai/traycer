/**
 * A bot's picture (Tracy Bots, T97, T111): a creature mark on a swatch, both
 * from the bot's id alone. Two bots side by side never draw the same mark on
 * the same swatch, every surface draws one bot the same way, and a rename
 * changes nothing. A person is still initials or a photo in a circle.
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
import {
  AvatarStack,
  BotAvatar,
  MemberAvatar,
  NamedBotAvatar,
} from "@/components/bots/bot-avatars";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { avatarShape } from "@/components/bots/__tests__/avatar-shape";

const PERSONAL_MAIN_BOT_ID = "bot_019YFRXBQ551DN29WCTHKM3CEP";
const TEAM_A_MAIN_BOT_ID = "bot_0RVWRHPMH8WPT9KW1NGKJB319D";
const TEAM_S_MAIN_BOT_ID = "bot_0YVZD4PHYFAZS1MCR0D9GABAGV";

interface DrawnAvatar {
  readonly path: string;
  readonly swatch: string;
  readonly ink: string;
}

function fallbackOf(avatar: HTMLElement): HTMLElement {
  const fallback = avatar.querySelector<HTMLElement>(
    '[data-slot="avatar-fallback"]',
  );
  if (fallback === null) throw new Error("the avatar drew no fallback");
  return fallback;
}

function creatureOf(avatar: HTMLElement): SVGSVGElement {
  const creature = avatar.querySelector<SVGSVGElement>(
    '[data-slot="bot-creature"]',
  );
  if (creature === null) throw new Error("the avatar drew no creature");
  return creature;
}

function drawn(): DrawnAvatar[] {
  return screen.getAllByTestId("bot-avatar").map((avatar) => {
    const fallback = fallbackOf(avatar);
    const paths = creatureOf(avatar).querySelectorAll("path");
    if (paths.length !== 1) throw new Error("the creature is not one path");
    return {
      path: paths[0].getAttribute("d") ?? "",
      swatch: fallback.style.getPropertyValue("--swatch"),
      ink: fallback.classList.contains("text-white") ? "light" : "dark",
    };
  });
}

function sideBySide(botIds: readonly string[]): DrawnAvatar[] {
  render(
    <>
      {botIds.map((botId) => (
        <NamedBotAvatar key={botId} botId={botId} size="sm" />
      ))}
    </>,
  );
  return drawn();
}

function InBotContext(props: {
  readonly title: string;
  readonly children: ReactElement;
}): ReactElement {
  return (
    <BotIdentityContext.Provider
      value={{ botId: TEAM_S_MAIN_BOT_ID, title: props.title, owner: null }}
    >
      {props.children}
    </BotIdentityContext.Provider>
  );
}

afterEach(() => {
  cleanup();
});

describe("a bot's picture", () => {
  it.each([
    [
      "a named bot",
      <NamedBotAvatar key="named" botId={TEAM_S_MAIN_BOT_ID} size="sm" />,
    ],
    [
      "the surface's bot",
      <InBotContext key="surface" title="Team Tracy">
        <BotAvatar size="sm" />
      </InBotContext>,
    ],
    [
      "a stack's bot entry",
      <InBotContext key="stack" title="Team Tracy">
        <AvatarStack
          identities={[{ kind: "bot" }]}
          max={3}
          size="sm"
          label="Members"
          testId="members"
        />
      </InBotContext>,
    ],
  ])(
    "is %s drawn as a hidden creature in a squircle, with no initials",
    (_entry, element) => {
      render(element);

      const avatar = screen.getByTestId("bot-avatar");
      expect(avatarShape(avatar)).toBe("squircle");
      expect(creatureOf(avatar).getAttribute("aria-hidden")).toBe("true");
      expect(fallbackOf(avatar).textContent).toBe("");
    },
  );

  it("is a person's initials in a circle, with no creature", () => {
    render(
      <>
        <MemberAvatar
          userId="user_1"
          name="Ada Lovelace"
          avatarUrl={null}
          size="sm"
        />
        <AvatarStack
          identities={[
            {
              kind: "person",
              userId: "user_2",
              name: "Grace Hopper",
              avatarUrl: null,
            },
          ]}
          max={3}
          size="sm"
          label="Members"
          testId="members"
        />
      </>,
    );

    const people = screen.getAllByTestId("chat-sender-avatar");
    expect(people.map((person) => fallbackOf(person).textContent)).toEqual([
      "AL",
      "GH",
    ]);
    for (const person of people) {
      expect(avatarShape(person)).toBe("circle");
      expect(person.querySelector('[data-slot="bot-creature"]')).toBeNull();
    }
  });

  it("draws the personal main bot and a team's main bot with different creatures and swatches", () => {
    const [personal, team] = sideBySide([
      PERSONAL_MAIN_BOT_ID,
      TEAM_A_MAIN_BOT_ID,
    ]);

    expect(personal.path).not.toBe(team.path);
    expect(personal.swatch).not.toBe(team.swatch);
  });

  it("draws two bots of one name in different environments on different swatches with different creatures", () => {
    const [teamA, teamS] = sideBySide([TEAM_A_MAIN_BOT_ID, TEAM_S_MAIN_BOT_ID]);

    // One hue in its two tones: the light swatch takes dark ink, the deep one
    // white.
    expect(teamA).toMatchObject({ swatch: "#f97316", ink: "dark" });
    expect(teamS).toMatchObject({ swatch: "#c2410c", ink: "light" });
    expect(teamA.path).not.toBe(teamS.path);
  });

  it("draws one bot the same in a sidebar row as on its own surface's header and message rows", () => {
    render(
      <>
        <NamedBotAvatar botId={TEAM_S_MAIN_BOT_ID} size="sm" />
        <InBotContext title="Team Tracy">
          <BotAvatar size="sm" />
        </InBotContext>
      </>,
    );

    const [row, surface] = drawn();
    expect(row).toEqual(surface);
  });

  it("keeps a bot's creature, swatch and ink through a rename", () => {
    // The surface's identity is the one place a bot's title reaches its
    // picture.
    render(
      <InBotContext title="Team Tracy">
        <BotAvatar size="sm" />
      </InBotContext>,
    );
    const [before] = drawn();
    cleanup();
    render(
      <InBotContext title="Ops">
        <BotAvatar size="sm" />
      </InBotContext>,
    );
    const [after] = drawn();

    expect(after).toEqual(before);
  });
});
