/**
 * A bot's picture: its mascot drawn straight in a squircle box, with no tile
 * behind it and no clip over it, from the bot's id alone. Every surface draws
 * one bot the same way, and a rename changes nothing. A person is still
 * initials or a photo in a circle.
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
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOT_APPEARANCE_UNRECOGNISED,
  BOT_UNRECOGNISED_MARK,
  type BotAppearance,
  type BotDirectoryRecord,
  type BotListResponse,
} from "@traycer/protocol/host/bot/schemas";
import { BotLooksContext, botLooksOf } from "@/hooks/bots/use-bot-appearance";
import {
  DEFAULT_MASCOT_RAMP,
  DEFAULT_MASCOT_SHAPE,
  MASCOT_AT_REST,
  MASCOT_WORKING_BEATS,
  botMascot,
  drawMascotMark,
  mascotRampAt,
  type MascotPose,
} from "@/lib/bots/mascot-mark";
import {
  AvatarStack,
  BotAvatar,
  ExpressiveBotAvatar,
  PersonAvatar,
  NamedBotAvatar,
} from "@/components/bots/bot-avatars";
import { BotIdentityContext } from "@/components/bots/bot-identity-context";
import { avatarShape } from "@/components/bots/__tests__/avatar-shape";
import {
  EMPTY_DIRECTORY_STATE,
  ONE_TEAM_MAIN_BOT_DIRECTORY,
  TEAM_MAIN_BOT_ID as DIRECTORY_MAIN_BOT_ID,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

const PERSONAL_MAIN_BOT_ID = "bot_019YFRXBQ551DN29WCTHKM3CEP";
const TEAM_A_MAIN_BOT_ID = "bot_0RVWRHPMH8WPT9KW1NGKJB319D";
const TEAM_S_MAIN_BOT_ID = "bot_0YVZD4PHYFAZS1MCR0D9GABAGV";

interface DrawnAvatar {
  /** One path per colour layer, darkest first. */
  readonly paths: string[];
  readonly fills: string[];
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
    const paths = [...mascotOf(avatar).querySelectorAll("path")];
    return {
      paths: paths.map((path) => path.getAttribute("d") ?? ""),
      fills: paths.map((path) => path.getAttribute("fill") ?? ""),
    };
  });
}

/** The paths the mascot of `look` is drawn as at the `sm` size, in `pose`. */
function pathsOf(
  botId: string,
  look: BotAppearance | null,
  pose: MascotPose,
): string[] {
  return drawMascotMark(botMascot(botId, look, false), 24, pose).layers.map(
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

function botRow(
  botId: string,
  appearance: BotAppearance | undefined,
): BotDirectoryRecord {
  return {
    botId,
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

afterEach(() => {
  cleanup();
  useStandaloneBotsStore.setState(EMPTY_DIRECTORY_STATE);
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
      expect(avatar.textContent).toBe("");
    },
  );

  it("draws a bot's mascot with nothing behind or over it, which a person's picture has", () => {
    render(
      <>
        <NamedBotAvatar botId={TEAM_S_MAIN_BOT_ID} size="sm" />
        <PersonAvatar
          userId="user_1"
          name="Ada Lovelace"
          avatarUrl={null}
          size="sm"
        />
      </>,
    );

    const bot = screen.getByTestId("bot-avatar");
    expect(bot.querySelector('[data-slot="avatar-fallback"]')).toBeNull();
    expect(bot.querySelector('[data-slot="avatar-edge"]')).toBeNull();
    expect(mascotOf(bot).parentElement).toBe(bot);
    for (const node of [bot, ...bot.querySelectorAll<HTMLElement>("*")]) {
      expect(node.getAttribute("style") ?? "", node.tagName).not.toMatch(
        /background|--avatar-fill/,
      );
    }
    expect(
      fallbackOf(screen.getByTestId("person-avatar")).style.getPropertyValue(
        "--avatar-fill",
      ),
    ).not.toBe("");
  });

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

    expect(personal.fills).not.toEqual(team.fills);
  });

  it("draws two bots of one name in different environments with different mascots and colours", () => {
    const [teamA, teamS] = sideBySide([TEAM_A_MAIN_BOT_ID, TEAM_S_MAIN_BOT_ID]);

    expect(teamA.paths).not.toEqual(teamS.paths);
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

  function looking(appearance: BotAppearance | undefined): ReactElement {
    return (
      <BotLooksContext
        value={botLooksOf({
          bots: [botRow(BOT_ID, appearance)],
          mainBotIds: null,
        })}
      >
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

    expect(drawn()[0].paths).toEqual(pathsOf(BOT_ID, null, MASCOT_AT_REST));
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

    expect(chosen.paths).toEqual(pathsOf(BOT_ID, chosenLook, MASCOT_AT_REST));
    expect(chosen.paths).not.toEqual(derived.paths);
    expect(chosen.fills).toEqual(derived.fills);
  });

  it("draws the colour the person chose and keeps the bot's own mascot", () => {
    render(looking(BARE));
    const [derived] = drawn();
    cleanup();
    render(looking({ ...BARE, color: 3 }));
    const [chosen] = drawn();

    expect(chosen.fills).toEqual(
      drawMascotMark(
        { ...botMascot(BOT_ID, null, false), ramp: mascotRampAt(3) },
        24,
        MASCOT_AT_REST,
      ).layers.map((layer) => layer.fill),
    );
    expect(chosen.fills).not.toEqual(derived.fills);
    expect(chosen.paths).toEqual(derived.paths);
  });

  it("draws the default mascot for a mark it cannot read, in the bot's own colours", () => {
    render(looking(BARE));
    const [derived] = drawn();
    cleanup();
    render(looking({ ...BARE, mark: BOT_UNRECOGNISED_MARK }));
    const [unreadable] = drawn();

    const expected = drawMascotMark(
      { ...botMascot(BOT_ID, null, false), shape: DEFAULT_MASCOT_SHAPE },
      24,
      MASCOT_AT_REST,
    ).layers;
    expect(unreadable.paths).toEqual(expected.map((layer) => layer.path));
    expect(unreadable.fills).toEqual(expected.map((layer) => layer.fill));
    expect(unreadable.paths).not.toEqual(derived.paths);
  });

  it("draws the default colours for a colour it cannot read, in the bot's own mascot", () => {
    render(looking({ ...BARE, color: BOT_APPEARANCE_UNRECOGNISED }));
    const [unreadable] = drawn();

    expect(unreadable.fills).toEqual(
      drawMascotMark(
        { ...botMascot(BOT_ID, null, false), ramp: DEFAULT_MASCOT_RAMP },
        24,
        MASCOT_AT_REST,
      ).layers.map((layer) => layer.fill),
    );
    expect(unreadable.paths).toEqual(pathsOf(BOT_ID, null, MASCOT_AT_REST));
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

describe("an environment's main bot's picture", () => {
  const BOT_ID = TEAM_S_MAIN_BOT_ID;

  function inSurface(mainBotIds: BotListResponse["mainBotIds"]): ReactElement {
    return (
      <BotLooksContext
        value={botLooksOf({
          bots: [botRow(BOT_ID, undefined)],
          mainBotIds,
        })}
      >
        <NamedBotAvatar botId={BOT_ID} size="sm" />
      </BotLooksContext>
    );
  }

  it("is the plain default mascot where the surface's list names the bot as main", () => {
    render(inSurface({ "env-1": BOT_ID }));

    expect(drawn()[0].paths).toEqual(
      drawMascotMark(
        botMascot(BOT_ID, null, true),
        24,
        MASCOT_AT_REST,
      ).layers.map((layer) => layer.path),
    );
  });

  it("is the bot's own mascot where the surface's list names no main bot", () => {
    render(inSurface(null));
    const [own] = drawn();
    cleanup();
    render(inSurface({ "env-1": "bot_other" }));

    expect(own.paths).toEqual(pathsOf(BOT_ID, null, MASCOT_AT_REST));
    expect(drawn()[0]).toEqual(own);
  });

  it("is the plain default mascot where the app's directory names the bot as main, with no surface list", () => {
    const ownPaths = (): string[] =>
      pathsOf(DIRECTORY_MAIN_BOT_ID, null, MASCOT_AT_REST);
    render(<NamedBotAvatar botId={DIRECTORY_MAIN_BOT_ID} size="sm" />);
    expect(drawn()[0].paths).toEqual(ownPaths());
    cleanup();

    act(() => {
      useStandaloneBotsStore.setState({
        directory: ONE_TEAM_MAIN_BOT_DIRECTORY,
      });
    });
    render(<NamedBotAvatar botId={DIRECTORY_MAIN_BOT_ID} size="sm" />);

    expect(drawn()[0].paths).toEqual(
      drawMascotMark(
        botMascot(DIRECTORY_MAIN_BOT_ID, null, true),
        24,
        MASCOT_AT_REST,
      ).layers.map((layer) => layer.path),
    );
    expect(drawn()[0].paths).not.toEqual(ownPaths());
  });

  it("is the bot's own mascot where the surface's list names another main bot, whatever the app's directory says", () => {
    act(() => {
      useStandaloneBotsStore.setState({
        directory: ONE_TEAM_MAIN_BOT_DIRECTORY,
      });
    });
    render(
      <BotLooksContext
        value={botLooksOf({
          bots: [botRow(DIRECTORY_MAIN_BOT_ID, undefined)],
          mainBotIds: { "env-1": "bot_other" },
        })}
      >
        <NamedBotAvatar botId={DIRECTORY_MAIN_BOT_ID} size="sm" />
      </BotLooksContext>,
    );

    expect(drawn()[0].paths).toEqual(
      pathsOf(DIRECTORY_MAIN_BOT_ID, null, MASCOT_AT_REST),
    );
  });
});

describe("a bot's picture while it works", () => {
  const WORKING: MascotPose = { expression: "working", beat: 0 };

  function working(): ReactElement {
    return (
      <InBotContext title="Team Tracy">
        <ExpressiveBotAvatar size="sm" expression="working" />
      </InBotContext>
    );
  }

  /** The narrow stub of the reduced-motion preference the clock reads. */
  function stubReducedMotion(reduced: boolean): void {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: reduced && query === "(prefers-reduced-motion: reduce)",
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }));
  }

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("moves its eyes a beat every 500 ms and comes back round", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    render(working());
    expect(drawn()[0].paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, WORKING),
    );

    act(() => {
      vi.advanceTimersByTime(499);
    });
    expect(drawn()[0].paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, WORKING),
    );
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(drawn()[0].paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, { ...WORKING, beat: 1 }),
    );
    expect(drawn()[0].paths).not.toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, WORKING),
    );
    act(() => {
      vi.advanceTimersByTime(500 * (MASCOT_WORKING_BEATS - 1));
    });
    expect(drawn()[0].paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, WORKING),
    );
  });

  it("keeps its eyes still for a person who asked for reduced motion", () => {
    vi.useFakeTimers();
    stubReducedMotion(true);
    render(working());
    const before = drawn()[0].paths;

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(drawn()[0].paths).toEqual(before);
  });

  it("stops its eyes on the first beat when reduced motion is turned on while it works", () => {
    vi.useFakeTimers();
    const preference = {
      matches: false,
      listeners: new Set<() => void>(),
    };
    vi.stubGlobal("matchMedia", (query: string) => ({
      get matches() {
        return preference.matches;
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, listener: () => void) => {
        preference.listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: () => void) => {
        preference.listeners.delete(listener);
      },
      dispatchEvent: () => false,
    }));
    render(working());
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(drawn()[0].paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, { ...WORKING, beat: 1 }),
    );

    act(() => {
      preference.matches = true;
      for (const listener of preference.listeners) listener();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(drawn()[0].paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, WORKING),
    );
  });

  it("starts no timer for a bot that is idle or away", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    const setInterval = vi.spyOn(window, "setInterval");
    render(
      <InBotContext title="Team Tracy">
        <>
          <ExpressiveBotAvatar size="sm" expression="idle" />
          <ExpressiveBotAvatar size="sm" expression="away" />
        </>
      </InBotContext>,
    );
    const before = drawn().map((avatar) => avatar.paths);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(setInterval).not.toHaveBeenCalled();
    expect(drawn().map((avatar) => avatar.paths)).toEqual(before);
  });

  it("draws its eyes shut when away, unlike when idle", () => {
    render(
      <InBotContext title="Team Tracy">
        <>
          <ExpressiveBotAvatar size="sm" expression="idle" />
          <ExpressiveBotAvatar size="sm" expression="away" />
        </>
      </InBotContext>,
    );

    const [idle, away] = drawn();
    expect(idle.paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, MASCOT_AT_REST),
    );
    expect(away.paths).toEqual(
      pathsOf(TEAM_S_MAIN_BOT_ID, null, { expression: "away", beat: 0 }),
    );
    expect(away.paths).not.toEqual(idle.paths);
  });
});
