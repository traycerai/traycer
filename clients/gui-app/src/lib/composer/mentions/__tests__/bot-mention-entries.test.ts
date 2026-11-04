import { describe, expect, it } from "vitest";
import {
  ONE_PERSONAL_MAIN_BOT_DIRECTORY,
  PERSONAL_MAIN_BOT_ID,
  TEAM_MAIN_BOT_ID,
  TWO_MAIN_BOTS_DIRECTORY,
} from "@/lib/home-bots/__tests__/standalone-bots-fixtures";
import { botMentionEntriesFromDirectory } from "../bot-mention-entries";

describe("botMentionEntriesFromDirectory", () => {
  it("names a team's bot by its team while the person sees more than one main bot", () => {
    expect(
      botMentionEntriesFromDirectory(TWO_MAIN_BOTS_DIRECTORY).map((entry) => [
        entry.botId,
        entry.label,
      ]),
    ).toEqual([
      [PERSONAL_MAIN_BOT_ID, "Tracy"],
      [TEAM_MAIN_BOT_ID, "Tracy · traycerai"],
    ]);
  });

  it("describes each bot by its environment and carries its trunk agent", () => {
    expect(
      botMentionEntriesFromDirectory(TWO_MAIN_BOTS_DIRECTORY),
    ).toMatchObject([
      {
        botId: PERSONAL_MAIN_BOT_ID,
        trunkChatId: `trunk-${PERSONAL_MAIN_BOT_ID}`,
        description: "Personal",
      },
      {
        botId: TEAM_MAIN_BOT_ID,
        trunkChatId: `trunk-${TEAM_MAIN_BOT_ID}`,
        description: "traycerai",
      },
    ]);
  });

  it("leaves the name bare when the person sees a single main bot", () => {
    expect(
      botMentionEntriesFromDirectory(ONE_PERSONAL_MAIN_BOT_DIRECTORY).map(
        (entry) => entry.label,
      ),
    ).toEqual(["Tracy"]);
  });

  it("does not list a team whose main bot is still to be set up", () => {
    const entries = botMentionEntriesFromDirectory({
      ...ONE_PERSONAL_MAIN_BOT_DIRECTORY,
      setups: [
        {
          environmentId: "env-team",
          teamName: "traycerai",
          botId: TEAM_MAIN_BOT_ID,
          title: "Tracy",
        },
      ],
    });

    expect(entries.map((entry) => entry.botId)).toEqual([PERSONAL_MAIN_BOT_ID]);
  });
});
