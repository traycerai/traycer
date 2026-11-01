import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  botOnboardingReadV10,
  botOnboardingReadV11,
  botOnboardingReadV12,
} from "@traycer/protocol/host/bot/contracts";

const BOT_A = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";

const V10_RESPONSE = {
  github: {
    state: "ok",
    installingAdmin: null,
    repositories: [],
    callerCanConnect: true,
  },
  unlocked: false,
  choice: null,
  catalog: [],
};

const entry = hostRpcRegistry["bot.onboarding.read"][1];

describe("bot.onboarding.read@1.1 setup", () => {
  it("is frozen between 1.0 and the 1.2 head", () => {
    expect(entry.latestMinor).toBe(2);
    expect(entry.versions[2].contract).toBe(botOnboardingReadV12);
    expect(entry.versions[1].contract).toBe(botOnboardingReadV11);
    expect(entry.versions[0].contract).toBe(botOnboardingReadV10);
  });

  it("upgrades a 1.0 response to no setup, which offers none", () => {
    const upgrade = entry.versions[1].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.0 to 1.1 upgrade path");
    const v10Response = botOnboardingReadV10.responseSchema.parse(V10_RESPONSE);

    expect(upgrade.upgradeResponse(v10Response)).toEqual({
      ...V10_RESPONSE,
      setup: null,
    });
  });

  it("freezes 1.0 at the rows alone, dropping a setup it never carried", () => {
    expect(
      botOnboardingReadV10.responseSchema.parse({
        ...V10_RESPONSE,
        setup: { botId: BOT_A, title: "Tracy" },
      }),
    ).toEqual(V10_RESPONSE);
  });

  it("requires setup, accepting a bot id with a title or null", () => {
    expect(
      botOnboardingReadV11.responseSchema.safeParse(V10_RESPONSE).success,
    ).toBe(false);
    expect(
      botOnboardingReadV11.responseSchema.parse({
        ...V10_RESPONSE,
        setup: null,
      }).setup,
    ).toBeNull();
    expect(
      botOnboardingReadV11.responseSchema.parse({
        ...V10_RESPONSE,
        setup: { botId: BOT_A, title: "Tracy" },
      }).setup,
    ).toEqual({ botId: BOT_A, title: "Tracy" });
  });

  it("rejects a setup whose bot id is not a bot id or whose title is empty", () => {
    for (const setup of [
      { botId: "not-a-bot", title: "Tracy" },
      { botId: BOT_A, title: "" },
    ]) {
      expect(
        botOnboardingReadV11.responseSchema.safeParse({
          ...V10_RESPONSE,
          setup,
        }).success,
      ).toBe(false);
    }
  });
});

describe("bot.onboarding.read@1.2 setup state", () => {
  const NEEDS_HOST = {
    botId: BOT_A,
    title: "Tracy",
    state: "needs_host",
    arrival: null,
  } as const;

  it("upgrades a 1.1 setup to one still to be set up, and no setup to none", () => {
    const upgrade = entry.versions[2].upgradeFromPreviousVersion;
    if (upgrade === null) throw new Error("expected a 1.1 to 1.2 upgrade path");

    expect(
      upgrade.upgradeResponse(
        botOnboardingReadV11.responseSchema.parse({
          ...V10_RESPONSE,
          setup: { botId: BOT_A, title: "Tracy" },
        }),
      ).setup,
    ).toEqual(NEEDS_HOST);
    expect(
      upgrade.upgradeResponse(
        botOnboardingReadV11.responseSchema.parse({
          ...V10_RESPONSE,
          setup: null,
        }),
      ).setup,
    ).toBeNull();
  });

  it("freezes 1.1 at a setup's bot and title, dropping its state", () => {
    expect(
      botOnboardingReadV11.responseSchema.parse({
        ...V10_RESPONSE,
        setup: { ...NEEDS_HOST, state: "live", arrival: { kind: "cloud" } },
      }).setup,
    ).toEqual({ botId: BOT_A, title: "Tracy" });
  });

  it("requires a setup's state and arrival, and accepts only the states and arrivals it names", () => {
    const parse = (setup: object) =>
      botOnboardingReadV12.responseSchema.safeParse({ ...V10_RESPONSE, setup })
        .success;
    expect(parse(NEEDS_HOST)).toBe(true);
    expect(
      parse({ ...NEEDS_HOST, state: "live", arrival: { kind: "cloud" } }),
    ).toBe(true);
    expect(parse({ botId: BOT_A, title: "Tracy" })).toBe(false);
    expect(parse({ ...NEEDS_HOST, state: "ready" })).toBe(false);
    expect(parse({ ...NEEDS_HOST, arrival: { kind: "machine" } })).toBe(false);
  });
});
