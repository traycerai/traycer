import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptorV11 } from "@traycer/protocol/host/environment/contracts";

/**
 * The bots a call can be placed to (Call Tracy, P11): every bot with its
 * environment's label, read by the dial's bot list. A bot is in it when its
 * environment is one the person belongs to and it is not archived.
 */
export interface DirectoryBot {
  readonly botId: string;
  readonly title: string;
  readonly environmentId: string;
  readonly environmentLabel: string;
}

export function directoryBots(
  environments: ReadonlyArray<EnvironmentDescriptorV11>,
  bots: ReadonlyArray<BotRecord>,
): ReadonlyArray<DirectoryBot> {
  const labels = new Map(
    environments.map((environment) => [
      environment.environmentId,
      environment.label,
    ]),
  );
  const listed: DirectoryBot[] = [];
  for (const bot of bots) {
    if (bot.archivedAt !== null) continue;
    const environmentLabel = labels.get(bot.environmentId);
    if (environmentLabel === undefined) continue;
    listed.push({
      botId: bot.botId,
      title: bot.title,
      environmentId: bot.environmentId,
      environmentLabel,
    });
  }
  return listed;
}
