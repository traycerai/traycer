import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type {
  BotAppearance,
  BotMascotShape,
  BotUpdateAppearanceRequest,
} from "@traycer/protocol/host/bot/schemas";
import {
  BotLooksContext,
  botLooksOf,
  useBotLook,
} from "@/hooks/bots/use-bot-appearance";
import {
  NO_BOT_LOOK_SAVE,
  useBotLookSaveStore,
} from "@/stores/bots/bot-look-save-store";
import { tracyRecord } from "@/lib/home-bots/__tests__/standalone-bots-fixtures";

const BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const HASH = "a".repeat(64);

const lookOf = (mark: BotAppearance["mark"]): BotAppearance => ({
  mark,
  color: null,
  eyewear: null,
  accessory: null,
});

/** The bot's look as the surface's list holds it, with `chosen` waiting to be saved. */
function lookWhile(
  held: BotAppearance | null,
  chosen: Omit<BotUpdateAppearanceRequest, "botId">,
): BotAppearance | null {
  useBotLookSaveStore.setState({
    saves: { [BOT]: { ...NO_BOT_LOOK_SAVE, chosen } },
  });
  const record =
    held === null
      ? tracyRecord(BOT, "env-1")
      : { ...tracyRecord(BOT, "env-1"), appearance: held };
  const wrapper = (props: { readonly children: ReactNode }): ReactNode => (
    <BotLooksContext value={botLooksOf({ bots: [record], mainBotIds: null })}>
      {props.children}
    </BotLooksContext>
  );
  return renderHook(() => useBotLook(BOT), { wrapper }).result.current;
}

afterEach(() => {
  cleanup();
  useBotLookSaveStore.setState(useBotLookSaveStore.getInitialState(), true);
});

describe("the look a chosen icon is drawn as while it is saved", () => {
  const PICTURE = { kind: "picture", sha256: HASH } as const;

  it.each<[string, BotAppearance | null, BotMascotShape | null]>([
    ["a held mascot", lookOf({ kind: "mascot", shape: "cat" }), "cat"],
    [
      "a held picture that kept a shape",
      lookOf({ kind: "picture", sha256: "b".repeat(64), mascotShape: "ghost" }),
      "ghost",
    ],
    [
      "a held picture that kept none",
      lookOf({ kind: "picture", sha256: "b".repeat(64), mascotShape: null }),
      null,
    ],
    [
      "a held icon this client cannot read",
      lookOf({ kind: "unrecognised" }),
      null,
    ],
    ["no icon held", lookOf(null), null],
    ["no look held at all", null, null],
  ])("keeps the shape of %s beside a chosen picture", (_name, held, shape) => {
    const look = lookWhile(held, { mark: PICTURE });

    expect(look?.mark).toEqual({ ...PICTURE, mascotShape: shape });
  });

  it("draws a chosen mascot as chosen, over a held picture too", () => {
    const mascot = { kind: "mascot", shape: "sun" } as const;

    expect(
      lookWhile(lookOf({ kind: "picture", sha256: HASH, mascotShape: "cat" }), {
        mark: mascot,
      })?.mark,
    ).toEqual(mascot);
    expect(
      lookWhile(lookOf({ kind: "mascot", shape: "cat" }), { mark: mascot })
        ?.mark,
    ).toEqual(mascot);
  });

  it("draws a cleared icon as none, and leaves the held mark when none was chosen", () => {
    const held = lookOf({ kind: "mascot", shape: "cat" });

    expect(lookWhile(held, { mark: null })?.mark).toBeNull();
    expect(lookWhile(held, { eyewear: "visor" })?.mark).toEqual(held.mark);
  });
});
