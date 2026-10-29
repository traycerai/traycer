import { describe, expect, it } from "vitest";
import { hostRpcRegistry } from "@traycer/protocol/host/index";
import {
  botOnboardingReadV10,
  botOnboardingReadV11,
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
  it("is the registry head, above the frozen 1.0", () => {
    expect(entry.latestMinor).toBe(1);
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
