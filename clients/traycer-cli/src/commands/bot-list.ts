import type { BotRecord } from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import { CliError, CLI_ERROR_CODES } from "../runner/errors";
import {
  listBots,
  listEnvironments,
  openLocalStreamClient,
  readBotSnapshot,
  type BotSnapshot,
} from "../internal/bot-host";
import type { CommandFn } from "../runner/runner";

/** One bot as `traycer bot list` reports it. */
export interface BotListRow {
  readonly botId: string;
  readonly title: string;
  /** Null when no host runs the bot until a member claims it onto one. */
  readonly boundHostId: string | null;
  readonly boundToThisHost: boolean;
  /**
   * Null when this bot could not be read, or when the host it was read from
   * does not know the count (`readFailed` tells the two apart).
   */
  readonly openRequestCount: number | null;
  /** This bot could not be read; the other bots still are. */
  readonly readFailed: boolean;
}

/** One environment and its bots, in the order the host lists environments. */
export interface BotListGroup {
  readonly environmentId: string;
  readonly label: string;
  readonly bots: readonly BotListRow[];
}

/**
 * `traycer bot list` - every bot in every environment the person belongs to,
 * grouped by environment, each with the host it runs on and its open
 * requests. There is no default environment: personal and every team are
 * listed side by side, an environment with no bots included.
 *
 * The open-request count is the `bot.subscribe` snapshot's, read once per
 * bot; the conversation rows stay authoritative and the count is a hint.
 */
export function buildBotListCommand(): CommandFn {
  return async () => {
    const [environments, bots] = await Promise.all([
      listEnvironments(),
      listBots(),
    ]);
    const { client, endpoint } = await openLocalStreamClient();
    // Every read settles (each has its own deadline) before the client
    // closes, so no subscription outlives the command.
    let settled: readonly PromiseSettledResult<BotListRow | null>[];
    try {
      settled = await Promise.allSettled(
        bots.map(async (bot): Promise<BotListRow | null> => {
          let snapshot: BotSnapshot | null;
          try {
            snapshot = await readBotSnapshot(client, bot.botId);
          } catch (error) {
            // A host without bots fails the whole command with one line; any
            // other failure is this bot's alone.
            if (
              error instanceof CliError &&
              error.code === CLI_ERROR_CODES.HOST_UNSUPPORTED
            ) {
              throw error;
            }
            return toRow(bot, null, true, endpoint.hostId);
          }
          // Deleted between the list and the read: not a bot any more.
          if (snapshot === null) return null;
          return toRow(
            snapshot.bot,
            snapshot.openRequestCount,
            false,
            endpoint.hostId,
          );
        }),
      );
    } finally {
      client.close("bot-list-settled");
    }
    const rows = settled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });
    const listed = rows.filter((row): row is BotListRow => row !== null);
    const groups = groupByEnvironment(environments, listed, bots);
    return {
      data: { environments: groups },
      human: renderBotList(groups),
      // Every bot is printed either way; a bot that could not be read makes
      // the run a failure a script can see.
      exitCode: listed.some((row) => row.readFailed) ? 1 : 0,
    };
  };
}

function toRow(
  bot: BotRecord,
  openRequestCount: number | null,
  readFailed: boolean,
  thisHostId: string,
): BotListRow {
  return {
    botId: bot.botId,
    title: bot.title,
    boundHostId: bot.boundHostId,
    boundToThisHost: bot.boundHostId === thisHostId,
    openRequestCount,
    readFailed,
  };
}

/**
 * Every environment the host lists, in its order, then any environment a bot
 * names that the list did not (shown by id, so no bot is dropped).
 */
export function groupByEnvironment(
  environments: readonly EnvironmentDescriptor[],
  rows: readonly BotListRow[],
  bots: readonly BotRecord[],
): readonly BotListGroup[] {
  const environmentOf = new Map(
    bots.map((bot) => [bot.botId, bot.environmentId] as const),
  );
  const rowsIn = (environmentId: string): readonly BotListRow[] =>
    rows.filter((row) => environmentOf.get(row.botId) === environmentId);
  const known = new Set(environments.map((env) => env.environmentId));
  const unknown = [
    ...new Set(
      rows
        .map((row) => environmentOf.get(row.botId))
        .filter((id): id is string => id !== undefined && !known.has(id)),
    ),
  ];
  return [
    ...environments.map((env) => ({
      environmentId: env.environmentId,
      label: env.label,
      bots: rowsIn(env.environmentId),
    })),
    ...unknown.map((environmentId) => ({
      environmentId,
      label: environmentId,
      bots: rowsIn(environmentId),
    })),
  ];
}

export function renderBotList(groups: readonly BotListGroup[]): string {
  if (groups.length === 0) return "You belong to no environments yet.";
  return groups
    .map((group) => {
      const lines =
        group.bots.length === 0
          ? ["  no bots"]
          : group.bots.map(
              (bot) =>
                `  ${bot.title}  ${bot.botId}  host ${bot.boundHostId ?? "none"}${bot.boundToThisHost ? " (this host)" : ""}  ${describeOpenRequests(bot)}`,
            );
      return [group.label, ...lines].join("\n");
    })
    .join("\n\n");
}

function describeOpenRequests(bot: BotListRow): string {
  if (bot.readFailed) return `could not read ${bot.title}`;
  if (bot.openRequestCount === null) return "open requests unknown";
  return formatOpenRequests(bot.openRequestCount);
}

function formatOpenRequests(count: number): string {
  return count === 1 ? "1 open request" : `${count} open requests`;
}
