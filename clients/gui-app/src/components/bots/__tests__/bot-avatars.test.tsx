/**
 * A bot's picture: a creature mark on a swatch, both from the bot's id
 * alone. Every surface draws one bot the same way, and a rename changes
 * nothing. A person is
 * still initials or a photo in a circle.
 *
 * The ids are real derived main-bot ids, `personalAssistantBotId(envId)` in
 * the internal repository's `bot-schemas.ts`: the personal assistant of
 * `env_personal`, and the team main bots of `env_team_a` and `env_team_s`.
 * `env_team_s` was found by deriving `env_team_b`, `env_team_c`, ... in turn
 * and keeping the first whose FNV-1a hash lands on `env_team_a`'s hash mod 12
 * (the original 12-swatch palette) and off it mod 24, so the two
 * "Team Tracy" bots shared one swatch then and differ now.
 */
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  BotAppearance,
  BotDirectoryRecord,
} from "@traycer/protocol/host/bot/schemas";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";
import {
  chosenCreatureMark,
  creatureMark,
  creatureSheet,
  drawCreatureMark,
} from "@/lib/bots/creature-mark";
import {
  botSwatchAt,
  derivedBotSwatchIndex,
} from "@/lib/providers/profile-accent-color";
import {
  AvatarStack,
  BotAvatar,
  PersonAvatar,
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
        <PersonAvatar
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

    const people = screen.getAllByTestId("person-avatar");
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

describe("a bot's chosen look", () => {
  const BOT_ID = TEAM_S_MAIN_BOT_ID;
  const BARE: BotAppearance = { mark: null, swatch: null, background: null };

  function row(appearance: BotAppearance | undefined): BotDirectoryRecord {
    return {
      botId: BOT_ID,
      environmentId: "env-1",
      createdByUserId: "user-1",
      title: "Team Tracy",
      harness: "claude",
      model: "model-a",
      effort: null,
      profile: null,
      directive: null,
      replyMode: "thread",
      appConversationChatId: null,
      trunkChatId: "trunk-1",
      boundHostId: "host-1",
      hostEpoch: 0,
      createdAt: 1_000,
      archivedAt: null,
      ...(appearance === undefined ? {} : { appearance }),
    };
  }

  function looking(appearance: BotAppearance | undefined): ReactElement {
    return (
      <BotLooksContext value={botLooksOf([row(appearance)])}>
        <NamedBotAvatar botId={BOT_ID} size="sm" />
      </BotLooksContext>
    );
  }

  /** The avatar's markup and custom properties, less the clip path's generated id. */
  function markup(): string {
    return screen
      .getByTestId("bot-avatar")
      .outerHTML.replace(/avatar-squircle-[\w-]+/g, "avatar-squircle-ID");
  }

  /** A swatch other than the bot's own, of the given ink. */
  function otherSwatch(ink: "dark" | "light"): number {
    const own = derivedBotSwatchIndex(BOT_ID);
    const found = Array.from({ length: 24 }, (_, index) => index).find(
      (index) => index !== own && botSwatchAt(index).ink === ink,
    );
    if (found === undefined) throw new Error("no such swatch");
    return found;
  }

  it("draws the derivation when nothing is chosen, as when the bot names no look at all", () => {
    render(looking(undefined));
    const bare = markup();
    cleanup();
    render(looking(BARE));

    expect(markup()).toBe(bare);
  });

  it("draws the bot's own creature from its id when no mark is chosen", () => {
    render(looking(BARE));

    expect(drawn()[0].path).toBe(
      drawCreatureMark(creatureMark(BOT_ID), 24).path,
    );
  });

  it("draws the creature the person chose, regrown from its family and seed", () => {
    const choice = creatureSheet(BOT_ID)[5];
    render(looking(BARE));
    const [derived] = drawn();
    cleanup();
    render(
      looking({
        ...BARE,
        mark: { kind: "creature", family: choice.family, seed: choice.seed },
      }),
    );
    const [chosen] = drawn();

    expect(chosen.path).toBe(
      drawCreatureMark(chosenCreatureMark(BOT_ID, choice), 24).path,
    );
    expect(chosen.path).not.toBe(derived.path);
    expect(chosen.swatch).toBe(derived.swatch);
  });

  it.each(["dark", "light"] as const)(
    "draws the swatch the person chose, in %s ink, and keeps the bot's own creature",
    (ink) => {
      const index = otherSwatch(ink);
      render(looking(BARE));
      const [derived] = drawn();
      cleanup();
      render(looking({ ...BARE, swatch: index }));
      const [chosen] = drawn();

      expect(chosen.swatch).toBe(botSwatchAt(index).color);
      expect(chosen.ink).toBe(ink);
      expect(chosen.swatch).not.toBe(derived.swatch);
      expect(chosen.path).toBe(derived.path);
    },
  );

  it.each([
    [
      "a creature",
      { ...BARE, mark: { kind: "creature", family: "crest", seed: 9 } },
    ],
    ["a swatch", { ...BARE, swatch: 17 }],
    [
      "all three",
      {
        mark: { kind: "creature", family: "ears", seed: 4 },
        swatch: 3,
        background: 20,
      },
    ],
  ] as const)(
    "is drawn exactly as the derivation again once %s is cleared",
    (_name, chosen) => {
      render(looking(BARE));
      const derived = markup();
      cleanup();

      const { rerender } = render(looking(chosen));
      expect(markup()).not.toBe(derived);
      rerender(looking(BARE));

      expect(markup()).toBe(derived);
    },
  );
});
