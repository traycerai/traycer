import type { BotActivity } from "@traycer/protocol/host/bot/schemas";
import { replyingSessionOf } from "@/hooks/bots/use-bot-activity";
import { formatUsd } from "@/lib/usage-analytics/cost-format";
import { stoppedAnswersOf } from "@/lib/voice/queue-sources";

/**
 * What `status` says about one bot (Tracy Bots voice, VT4), composed from
 * what the app already reads: the `bot.subscribe` snapshot (what it is
 * answering now, what stopped), the Activity data (its tasks, the agents
 * working, the tasks it finished this week) and the usage summary
 * the bot's settings open (what it cost). Ends with the offered follow-up.
 */
export interface BotStatusFacts {
  readonly botTitle: string;
  /** `null` while the bot's stream has not said. */
  readonly activity: BotActivity | null;
  /** Tasks it still runs. */
  readonly tasks: number;
  /**
   * Whether anything of the bot's is running now: agents in its tasks, or
   * chats under it. A whether, not a count: the Activity rows group agents
   * by task, so their number is not what the person would hear as agents.
   */
  readonly working: boolean;
  /** Tasks that ended in the week before now. */
  readonly finishedThisWeek: number;
  /** What the bot cost in the usage window; `null` when the host cannot say. */
  readonly costUsd: number | null;
  /** The window `costUsd` covers, in days. */
  readonly costWindowDays: number;
}

export const STATUS_FOLLOW_UP = "Want me to open it?";

export function composeBotStatus(facts: BotStatusFacts): string {
  const sentences: string[] = [];
  const bot = facts.botTitle;
  const replying = replyingSessionOf(facts.activity);
  if (replying !== null) {
    sentences.push(
      replying.step === null
        ? `${bot} is answering now.`
        : `${bot} is answering now: ${replying.step}.`,
    );
  } else if (facts.activity !== null && facts.activity.trunk !== null) {
    sentences.push(`${bot} is not answering anything right now.`);
  }
  if (facts.tasks > 0) {
    sentences.push(
      facts.working
        ? `It runs ${count(facts.tasks, "task", "tasks")}, with work going on now.`
        : `It runs ${count(facts.tasks, "task", "tasks")}.`,
    );
  } else if (facts.working) {
    sentences.push("It has work going on now.");
  }
  const stopped = stoppedAnswersOf(facts.activity);
  if (stopped.length > 0) {
    sentences.push(
      `${count(stopped.length, "answer", "answers")} stopped before ${stopped.length === 1 ? "it was" : "they were"} done.`,
    );
  }
  if (facts.finishedThisWeek > 0) {
    sentences.push(
      `This week it finished ${count(facts.finishedThisWeek, "task", "tasks")}.`,
    );
  }
  if (facts.costUsd !== null) {
    sentences.push(
      `Its usage came to about ${formatUsd(facts.costUsd)} in the last ${facts.costWindowDays} days.`,
    );
  }
  if (sentences.length === 0) {
    sentences.push(`Nothing is known about ${bot} yet.`);
  }
  sentences.push(STATUS_FOLLOW_UP);
  return sentences.join(" ");
}

function count(value: number, one: string, many: string): string {
  return `${value} ${value === 1 ? one : many}`;
}
