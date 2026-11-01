import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { HomeBotsGroup, HomeBotsModel } from "@/lib/home-bots/bots-model";

export const PERSONAL_MAIN_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAV";
export const TEAM_MAIN_BOT_ID = "bot_01ARZ3NDEKTSV4RRFFQ69G5FAW";

export function tracyRecord(botId: string, environmentId: string): BotRecord {
  return {
    botId,
    environmentId,
    createdByUserId: "user-1",
    title: "Tracy",
    harness: "claude",
    model: "claude-opus-5-5",
    effort: null,
    profile: null,
    trunkChatId: `trunk-${botId}`,
    boundHostId: "host-1",
    hostEpoch: 0,
    createdAt: 1,
    archivedAt: null,
    directive: null,
    replyMode: "direct",
    appConversationChatId: null,
  };
}

function mainBotGroup(
  botId: string,
  environmentId: string,
  label: string,
  ownerKind: "user" | "organization",
): HomeBotsGroup {
  return {
    environmentId,
    label,
    ownerKind,
    canCreate: true,
    bots: [tracyRecord(botId, environmentId)],
    mainBotId: botId,
  };
}

const PERSONAL_GROUP = mainBotGroup(
  PERSONAL_MAIN_BOT_ID,
  "env-me",
  "Personal",
  "user",
);

/** A person with their personal Tracy and the team traycerai's. */
export const TWO_MAIN_BOTS_MODEL: HomeBotsModel = {
  groups: [
    PERSONAL_GROUP,
    mainBotGroup(TEAM_MAIN_BOT_ID, "env-team", "traycerai", "organization"),
  ],
  botCount: 2,
};

/** A person with only their personal Tracy. */
export const ONE_MAIN_BOT_MODEL: HomeBotsModel = {
  groups: [PERSONAL_GROUP],
  botCount: 1,
};
