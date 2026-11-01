import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import {
  EMPTY_HOME_BOTS_MODEL,
  type HomeBotsGroup,
} from "@/lib/home-bots/bots-model";
import type { StandaloneBotsDirectory } from "@/lib/home-bots/standalone-bot-name";

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

const TEAM_GROUP = mainBotGroup(
  TEAM_MAIN_BOT_ID,
  "env-team",
  "traycerai",
  "organization",
);

/** A person with their personal Tracy and the team traycerai's. */
export const TWO_MAIN_BOTS_DIRECTORY: StandaloneBotsDirectory = {
  model: { groups: [PERSONAL_GROUP, TEAM_GROUP], botCount: 2 },
  setups: [],
};

/** A person whose only main bot is their team's. */
export const ONE_TEAM_MAIN_BOT_DIRECTORY: StandaloneBotsDirectory = {
  model: { groups: [TEAM_GROUP], botCount: 1 },
  setups: [],
};

/** A person whose only main bot is their personal Tracy. */
export const ONE_PERSONAL_MAIN_BOT_DIRECTORY: StandaloneBotsDirectory = {
  model: { groups: [PERSONAL_GROUP], botCount: 1 },
  setups: [],
};

/** No directory: what the store starts from. */
export const EMPTY_DIRECTORY_STATE = {
  directory: { model: EMPTY_HOME_BOTS_MODEL, setups: [] },
  settled: false,
};
