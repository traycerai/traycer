import type {
  BotTaskCadence,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import {
  findBot,
  formatBotTime,
  listBots,
  openLocalStreamClient,
  readBotSnapshot,
} from "../internal/bot-host";
import { cliError, CLI_ERROR_CODES } from "../runner/errors";
import type { CommandFn } from "../runner/runner";

/**
 * `traycer bot checkins <bot> [--task <id>]` - the tasks a bot follows, with
 * how often it checks in on each, whether it still does, and when it last
 * did. Read from one `bot.subscribe` snapshot, which any of the person's hosts
 * serves.
 */
export function buildBotCheckinsCommand(opts: {
  readonly bot: string;
  readonly taskId: string | null;
}): CommandFn {
  return async () => {
    const bot = findBot(await listBots(), opts.bot);
    const { client } = await openLocalStreamClient();
    const snapshot = await readBotSnapshot(client, bot.botId).finally(() => {
      client.close("bot-checkins-settled");
    });
    if (snapshot === null) {
      throw cliError({
        code: CLI_ERROR_CODES.NOT_FOUND,
        message: `traycer: the bot '${bot.title}' was deleted.`,
        details: null,
        exitCode: 1,
      });
    }
    const tasks =
      opts.taskId === null
        ? snapshot.tasks
        : snapshot.tasks.filter((task) => task.taskId === opts.taskId);
    if (opts.taskId !== null && tasks.length === 0) {
      throw cliError({
        code: CLI_ERROR_CODES.NOT_FOUND,
        message: `traycer: ${snapshot.bot.title} does not follow task ${opts.taskId}.`,
        details: null,
        exitCode: 1,
      });
    }
    return {
      data: { botId: snapshot.bot.botId, tasks },
      human: renderCheckins(snapshot.bot.title, tasks),
      exitCode: 0,
    };
  };
}

export function renderCheckins(
  title: string,
  tasks: readonly BotTaskEntry[],
): string {
  if (tasks.length === 0) return `${title} follows no tasks.`;
  const lines = tasks.map(
    (task) =>
      `  ${task.taskId}  ${formatCadence(task.cadence)}  ${formatState(task)}  last check-in ${task.lastCheckinAt === null ? "never" : formatBotTime(task.lastCheckinAt)}${task.nextAt === null ? "" : `  next ${formatBotTime(task.nextAt)}`}`,
  );
  return [`${title}`, ...lines].join("\n");
}

function formatCadence(cadence: BotTaskCadence): string {
  switch (cadence.kind) {
    case "every":
      return `every ${formatSeconds(cadence.seconds)}`;
    case "on-completion":
      return "when finished";
    case "none":
      return "no check-ins";
  }
}

function formatState(task: BotTaskEntry): string {
  if (task.state === "tracking") return "following";
  switch (task.endedReason) {
    case "by-bot":
      return "stopped by the bot";
    case "deleted":
      return "stopped: task deleted";
    case "archived":
      return "stopped: task archived";
    case "completed":
      return "stopped: task finished";
    case null:
      return "stopped";
  }
}

/** Seconds as the largest whole unit that divides them: 3600 -> 1h, 90 -> 90s. */
function formatSeconds(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
