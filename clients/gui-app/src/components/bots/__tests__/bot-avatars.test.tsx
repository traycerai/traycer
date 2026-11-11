/**
 * A bot's picture: a mascot on a tile of its colour, both from the bot's id
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
 * "Team Tracy" bots shared one colour then and differ now.
 */
import type { ReactElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  BOT_APPEARANCE_UNRECOGNISED,
  BOT_UNRECOGNISED_MARK,
  type BotAppearance,
  type BotDirectoryRecord,
} from "@traycer/protocol/host/bot/schemas";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";
import {
  DEFAULT_MASCOT_RAMP,
  DEFAULT_MASCOT_SHAPE,
  botMascot,
  drawMascotMark,
  mascotRampAt,
} from "@/lib/bots/mascot-mark";
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
  /** One path per colour layer, darkest first. */
  readonly paths: string[];
  readonly fills: string[];
  readonly tile: string;
  readonly tileDark: string;
}

function fallbackOf(avatar: HTMLElement): HTMLElement {
  const fallback = avatar.querySelector<HTMLElement>(
    '[data-slot="avatar-fallback"]',
  );
  if (fallback === null) throw new Error("the avatar drew no fallback");
  return fallback;
}

function mascotOf(avatar: HTMLElement): SVGSVGElement {
  const mascot = avatar.querySelector<SVGSVGElement>(
    '[data-slot="bot-mascot"]',
  );
  if (mascot === null) throw new Error("the avatar drew no mascot");
  return mascot;
}

function drawn(): DrawnAvatar[] {
  return screen.getAllByTestId("bot-avatar").map((avatar) => {
    const fallback = fallbackOf(avatar);
    const paths = [...mascotOf(avatar).querySelectorAll("path")];
    return {
      paths: paths.map((path) => path.getAttribute("d") ?? ""),
      fills: paths.map((path) => path.getAttribute("fill") ?? ""),
      tile: fallback.style.getPropertyValue("--avatar-fill"),
      tileDark: fallback.style.getPropertyValue("--avatar-fill-dark"),
    };
  });
}

/** The paths the mascot of `look` is drawn as at the `sm` size. */
function pathsOf(botId: string, look: BotAppearance | null): string[] {
  return drawMascotMark(botMascot(botId, look), 24).layers.map(
    (layer) => layer.path,
  );
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
    "is %s drawn as a hidden mascot in a squircle, with no initials",
    (_entry, element) => {
      render(element);

      const avatar = screen.getByTestId("bot-avatar");
      expect(avatarShape(avatar)).toBe("squircle");
      expect(mascotOf(avatar).getAttribute("aria-hidden")).toBe("true");
      expect(fallbackOf(avatar).textContent).toBe("");
    },
  );

  it("is a person's initials in a circle, with no mascot", () => {
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
      expect(person.querySelector('[data-slot="bot-mascot"]')).toBeNull();
    }
  });

  it("draws the personal main bot and a team's main bot in different colours", () => {
    const [personal, team] = sideBySide([
      PERSONAL_MAIN_BOT_ID,
      TEAM_A_MAIN_BOT_ID,
    ]);

    expect(personal.tile).not.toBe(team.tile);
    expect(personal.fills).not.toEqual(team.fills);
  });

  it("draws two bots of one name in different environments with different mascots and colours", () => {
    const [teamA, teamS] = sideBySide([TEAM_A_MAIN_BOT_ID, TEAM_S_MAIN_BOT_ID]);

    expect(teamA.paths).not.toEqual(teamS.paths);
    expect(teamA.tile).not.toBe(teamS.tile);
    expect(teamA.fills).not.toEqual(teamS.fills);
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

  it("keeps a bot's mascot and colours through a rename", () => {
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
  const BARE: BotAppearance = { mark: null, color: null, background: null };

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

  it("draws the derivation when nothing is chosen, as when the bot names no look at all", () => {
    render(looking(undefined));
    const bare = markup();
    cleanup();
    render(looking(BARE));

    expect(markup()).toBe(bare);
  });

  it("draws the bot's own mascot from its id when no mark is chosen", () => {
    render(looking(BARE));

    expect(drawn()[0].paths).toEqual(pathsOf(BOT_ID, null));
  });

  it("draws the mascot the person chose and keeps the bot's own colours", () => {
    render(looking(BARE));
    const [derived] = drawn();
    cleanup();
    const chosenLook: BotAppearance = {
      ...BARE,
      mark: { kind: "mascot", shape: "ghost" },
    };
    render(looking(chosenLook));
    const [chosen] = drawn();

    expect(chosen.paths).toEqual(pathsOf(BOT_ID, chosenLook));
    expect(chosen.paths).not.toEqual(derived.paths);
    expect(chosen.tile).toBe(derived.tile);
  });

  it("draws the colour the person chose and keeps the bot's own mascot", () => {
    render(looking(BARE));
    const [derived] = drawn();
    cleanup();
    render(looking({ ...BARE, color: 3 }));
    const [chosen] = drawn();

    expect(chosen.tile).toBe(mascotRampAt(3).tile.light);
    expect(chosen.tileDark).toBe(mascotRampAt(3).tile.dark);
    expect(chosen.fills).toEqual(
      drawMascotMark(
        { shape: botMascot(BOT_ID, null).shape, ramp: mascotRampAt(3) },
        24,
      ).layers.map((layer) => layer.fill),
    );
    expect(chosen.tile).not.toBe(derived.tile);
    expect(chosen.paths).toEqual(derived.paths);
  });

  it("draws the default mascot for a mark it cannot read, in the bot's own colours", () => {
    render(looking(BARE));
    const [derived] = drawn();
    cleanup();
    render(looking({ ...BARE, mark: BOT_UNRECOGNISED_MARK }));
    const [unreadable] = drawn();

    expect(unreadable.paths).toEqual(
      drawMascotMark(
        { shape: DEFAULT_MASCOT_SHAPE, ramp: botMascot(BOT_ID, null).ramp },
        24,
      ).layers.map((layer) => layer.path),
    );
    expect(unreadable.paths).not.toEqual(derived.paths);
    expect(unreadable.tile).toBe(derived.tile);
  });

  it("draws the default colours for a colour it cannot read, in the bot's own mascot", () => {
    render(looking({ ...BARE, color: BOT_APPEARANCE_UNRECOGNISED }));
    const [unreadable] = drawn();

    expect(unreadable.tile).toBe(DEFAULT_MASCOT_RAMP.tile.light);
    expect(unreadable.paths).toEqual(pathsOf(BOT_ID, null));
  });

  it.each([
    ["a mascot", { ...BARE, mark: { kind: "mascot", shape: "flame" } }],
    ["a colour", { ...BARE, color: 17 }],
    [
      "all three",
      {
        mark: { kind: "mascot", shape: "cat" },
        color: 3,
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
