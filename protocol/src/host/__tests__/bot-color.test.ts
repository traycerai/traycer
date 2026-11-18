import { describe, expect, it } from "vitest";
import {
  BOT_COLOR_HEX_PATTERN,
  BOT_COLOR_LINE_UP,
  BOT_DEFAULT_COLOR,
  botCreationColor,
  isBotColorHex,
} from "@traycer/protocol/host/bot/colors";
import {
  BOT_APPEARANCE_UNRECOGNISED,
  botAppearanceChoiceSchema,
  botAppearanceSchema,
  botUpdateAppearanceRequestSchema,
} from "@traycer/protocol/host/bot/schemas";

const BOT = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOT_A_SAVED_COLOUR = [
  3,
  24,
  -1,
  1.5,
  "#F04C4C",
  "#f44",
  "#f04c4",
  "#f04c4c0",
  "f04c4c",
  "red",
  "unrecognised",
  "",
  true,
] as const;

describe("a bot's colour line-up", () => {
  it("is nine colours, each a saved colour, each once under one name", () => {
    expect(BOT_COLOR_LINE_UP).toHaveLength(9);
    for (const { hex } of BOT_COLOR_LINE_UP) {
      expect(BOT_COLOR_HEX_PATTERN.test(hex)).toBe(true);
    }
    expect(new Set(BOT_COLOR_LINE_UP.map(({ hex }) => hex)).size).toBe(9);
    expect(new Set(BOT_COLOR_LINE_UP.map(({ name }) => name)).size).toBe(9);
  });

  it("holds the default colour, the teal", () => {
    expect(BOT_DEFAULT_COLOR).toBe("#93bdc8");
    expect(BOT_COLOR_LINE_UP.map(({ hex }) => hex)).toContain(
      BOT_DEFAULT_COLOR,
    );
  });

  it("tells a saved colour from anything else", () => {
    for (const { hex } of BOT_COLOR_LINE_UP)
      expect(isBotColorHex(hex)).toBe(true);
    expect(isBotColorHex("#0a0b0c")).toBe(true);
    for (const other of [...NOT_A_SAVED_COLOUR, null, undefined]) {
      expect(isBotColorHex(other)).toBe(false);
    }
  });
});

describe("the colour a new bot is created with", () => {
  it.each([
    ["", "#ed4f9d"],
    ["a", "#ed4f9d"],
    ["request-1", "#f08f4c"],
    ["request-2", "#ed4f9d"],
    ["request-3", "#93bdc8"],
    ["3f2b8c1e-6a4d-4e0b-9c7a-1d5e8f2a6b34", "#ed4f9d"],
    ["héllo", "#f04c4c"],
    ["日本語", "#7e4cf0"],
    ["🤖", "#ed4f9d"],
  ])("gives the key %j the colour %s", (key, hex) => {
    expect(botCreationColor(key)).toBe(hex);
  });

  it("is always one of the line-up, the same for the same key, and reaches every colour", () => {
    const hexes = BOT_COLOR_LINE_UP.map(({ hex }) => hex);
    const seen = new Set<string>();
    for (let at = 0; at < 400; at += 1) {
      const key = `request-key-${String(at)}`;
      const colour = botCreationColor(key);

      expect(hexes).toContain(colour);
      expect(botCreationColor(key)).toBe(colour);
      seen.add(colour);
    }
    expect(seen.size).toBe(9);
  });
});

describe("a colour on the wire, as it is written", () => {
  const request = botUpdateAppearanceRequestSchema;
  const choice = botAppearanceChoiceSchema;
  const FULL_CHOICE = { mark: null, eyewear: null, accessory: null } as const;

  it("accepts a hex colour and null, on a request and as a choice", () => {
    for (const color of ["#f04c4c", "#0a0b0c", null]) {
      expect(request.parse({ botId: BOT, color }).color).toBe(color);
      expect(choice.parse({ ...FULL_CHOICE, color }).color).toBe(color);
    }
  });

  it.each(NOT_A_SAVED_COLOUR)(
    "refuses %j as a colour, on a request and as a choice",
    (color) => {
      expect(request.safeParse({ botId: BOT, color }).success).toBe(false);
      expect(choice.safeParse({ ...FULL_CHOICE, color }).success).toBe(false);
    },
  );

  it("strips the colour the bot was created with, which no request or choice carries", () => {
    const asked = request.parse({
      botId: BOT,
      color: "#f04c4c",
      createdColor: "#4c8af0",
    });
    const chosen = choice.parse({
      ...FULL_CHOICE,
      color: null,
      createdColor: "#4c8af0",
    });

    expect(asked).toEqual({ botId: BOT, color: "#f04c4c" });
    expect("createdColor" in asked).toBe(false);
    expect("createdColor" in chosen).toBe(false);
  });
});

describe("a colour as it is read", () => {
  const read = (extra: object) =>
    botAppearanceSchema.parse({ mark: null, color: null, ...extra });

  it("reads a hex and null as written", () => {
    expect(read({ color: "#4c8af0" }).color).toBe("#4c8af0");
    expect(read({ color: null }).color).toBeNull();
  });

  it.each([3, 24, 1.5, "#F04C4C", "#f44", "red", {}, true])(
    "reads %j as a colour this reader cannot read",
    (color) => {
      expect(read({ color }).color).toBe(BOT_APPEARANCE_UNRECOGNISED);
    },
  );

  it("reads the colour a bot was created with when it is a hex, and none otherwise", () => {
    expect(read({ createdColor: "#7e4cf0" }).createdColor).toBe("#7e4cf0");
    expect(read({ createdColor: null }).createdColor).toBeNull();
    expect(read({}).createdColor).toBeUndefined();
    for (const junk of [3, "red", "#ABCDEF", "unrecognised", {}]) {
      expect(read({ createdColor: junk }).createdColor).toBeNull();
    }
  });
});
