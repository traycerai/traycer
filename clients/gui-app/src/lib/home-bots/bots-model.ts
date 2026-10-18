import type {
  BotRecord,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { EnvironmentDescriptor } from "@traycer/protocol/host/environment/contracts";
import type { BotSubscriptionSnapshot } from "@/hooks/bots/use-bot-subscription";

/**
 * The Home bots section's data contract (Tracy Bots), built by pure functions
 * from the reads the section makes: `environment.list` and `bot.list` for the
 * groups, and each row's own `bot.subscribe` snapshot for its live facts.
 *
 * EVERY environment is a group, side by side and in the list's order (the
 * personal one first, then one per team), whether or not it holds a bot: the
 * create form lives inside each group, so an empty environment is still a
 * place the reader can act. There is no default and no "current" environment
 * anywhere here. A bot whose environment the list does not name (the user
 * left that team) is kept, under a group labelled by its id, rather than
 * dropped from a page that says it lists every bot.
 */
export interface HomeBotRowModel {
  readonly botId: string;
  readonly title: string;
  readonly environmentId: string;
  /** The host the bot's trunk runs on, from the cloud row; the snapshot's
   * `boundHost` restates it and wins when present, being the fresher read.
   * `null` when no host runs the bot until a member claims it onto one. */
  readonly boundHostId: string | null;
  readonly harness: string;
  readonly model: string;
  /**
   * The stream's open-request hint, `null` when unknown. The conversation's
   * own rows are authoritative for what is open.
   */
  readonly openRequestCount: number | null;
  /** Tasks the bot is still tracking, `null` until a snapshot arrives. */
  readonly tasksTracking: number | null;
  /** The soonest periodic check-in due across the tracked tasks. */
  readonly nextCheckinAt: number | null;
  /** The most recent consumed check-in across the tracked tasks. */
  readonly lastCheckinAt: number | null;
  /** Whether the serving host is the bound one, `null` before a snapshot. */
  readonly boundHere: boolean | null;
}

export interface HomeBotsGroup {
  readonly environmentId: string;
  readonly label: string;
  readonly ownerKind: EnvironmentDescriptor["ownerKind"] | null;
  /** False for the trailing group of bots whose environment is not listed:
   * nothing can be created into an environment the user is not in. */
  readonly canCreate: boolean;
  /** Live (unarchived) bots of this environment, by title. */
  readonly bots: ReadonlyArray<BotRecord>;
}

export interface HomeBotsModel {
  readonly groups: ReadonlyArray<HomeBotsGroup>;
  readonly botCount: number;
}

export interface HomeBotsModelInput {
  readonly environments: ReadonlyArray<EnvironmentDescriptor>;
  readonly bots: ReadonlyArray<BotRecord>;
}

export const EMPTY_HOME_BOTS_MODEL: HomeBotsModel = Object.freeze({
  groups: [],
  botCount: 0,
});

/** The tracked tasks' check-in facts, folded to what one row can show. */
export function foldTaskCheckins(tasks: ReadonlyArray<BotTaskEntry>): {
  readonly tracking: number;
  readonly nextAt: number | null;
  readonly lastAt: number | null;
} {
  let tracking = 0;
  let nextAt: number | null = null;
  let lastAt: number | null = null;
  for (const task of tasks) {
    if (task.state !== "tracking") continue;
    tracking += 1;
    if (task.nextAt !== null && (nextAt === null || task.nextAt < nextAt)) {
      nextAt = task.nextAt;
    }
    if (
      task.lastCheckinAt !== null &&
      (lastAt === null || task.lastCheckinAt > lastAt)
    ) {
      lastAt = task.lastCheckinAt;
    }
  }
  return { tracking, nextAt, lastAt };
}

export function buildHomeBotRow(
  bot: BotRecord,
  snapshot: BotSubscriptionSnapshot | null,
): HomeBotRowModel {
  // Two reads of the same bot, each possibly stale: the `bot.list` record
  // and the stream's last snapshot. A claim made from another host bumps
  // `hostEpoch`, so the read carrying the higher epoch is the fresher one
  // for the bound host and the title; on a tie the snapshot wins, being the
  // live reading. Neither is authoritative by its channel alone - a stream
  // that opened before the claim keeps restating the old host.
  const snapshotWins =
    snapshot !== null && snapshot.bot.hostEpoch >= bot.hostEpoch;
  const live = snapshotWins ? snapshot.bot : bot;
  const checkins = snapshot === null ? null : foldTaskCheckins(snapshot.tasks);
  return {
    botId: bot.botId,
    title: live.title,
    environmentId: live.environmentId,
    boundHostId: snapshotWins ? snapshot.boundHost.hostId : bot.boundHostId,
    harness: live.harness,
    model: live.model,
    openRequestCount: snapshot?.openRequestCount ?? null,
    tasksTracking: checkins?.tracking ?? null,
    nextCheckinAt: checkins?.nextAt ?? null,
    lastCheckinAt: checkins?.lastAt ?? null,
    boundHere: snapshot?.boundHost.isThisHost ?? null,
  };
}

/**
 * What a Home row says about a bot (Tracy Bots): working, idle, or paused -
 * never which machine it runs on. Paused means the bot's host cannot be
 * reached, and is said only on evidence this client has:
 * - no host runs the bot;
 * - the bound host is one of the reader's own and cannot be dialled now;
 * - the bound host is in no list the reader can see: not theirs, and not a
 *   machine of the bot's environment (another member's machine, whose
 *   reachability this account cannot observe - the tab's `bot.open` answers
 *   the same).
 * A machine of the environment the reader cannot dial (a team machine
 * another member added) has unknown reachability here; the row says idle
 * and opening the tab decides. So does an environment whose machine list
 * has not answered (`environmentHostIds` null), and a host directory that
 * has not answered (`connectableResolved` false): until then the reader's
 * own machines are not known, so nothing about them is evidence.
 */
export type HomeBotState = "working" | "idle" | "paused";

export function homeBotState(input: {
  readonly working: boolean;
  readonly boundHostId: string | null;
  /** Hosts in the reader's own directory. */
  readonly directoryHostIds: ReadonlySet<string>;
  /** Of those, the ones this client can dial now. */
  readonly connectableHostIds: ReadonlySet<string>;
  /** Whether the directory has answered; until it has, the two sets above
   * are empty for want of an answer, not because there are no hosts. */
  readonly connectableResolved: boolean;
  /** The machines of the bot's environment the reader may see beyond their
   * own (empty for a personal environment, which has none), or null while a
   * team environment's list has not answered. */
  readonly environmentHostIds: ReadonlySet<string> | null;
}): HomeBotState {
  const { boundHostId } = input;
  if (boundHostId === null) return "paused";
  if (input.working) return "working";
  if (!input.connectableResolved) return "idle";
  if (input.directoryHostIds.has(boundHostId)) {
    return input.connectableHostIds.has(boundHostId) ? "idle" : "paused";
  }
  if (input.environmentHostIds === null) return "idle";
  return input.environmentHostIds.has(boundHostId) ? "idle" : "paused";
}

function compareBots(a: BotRecord, b: BotRecord): number {
  const byTitle = a.title.localeCompare(b.title);
  return byTitle !== 0 ? byTitle : a.botId.localeCompare(b.botId);
}

export function buildHomeBotsModel(input: HomeBotsModelInput): HomeBotsModel {
  const botsByEnvironment = new Map<string, BotRecord[]>();
  for (const bot of input.bots) {
    if (bot.archivedAt !== null) continue;
    const rows = botsByEnvironment.get(bot.environmentId);
    if (rows === undefined) botsByEnvironment.set(bot.environmentId, [bot]);
    else rows.push(bot);
  }
  const groups: HomeBotsGroup[] = input.environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    ownerKind: environment.ownerKind,
    canCreate: true,
    bots: (botsByEnvironment.get(environment.environmentId) ?? []).sort(
      compareBots,
    ),
  }));
  const listed = new Set(input.environments.map((e) => e.environmentId));
  for (const [environmentId, bots] of botsByEnvironment) {
    if (listed.has(environmentId)) continue;
    groups.push({
      environmentId,
      label: environmentId,
      ownerKind: null,
      canCreate: false,
      bots: bots.sort(compareBots),
    });
  }
  let botCount = 0;
  for (const group of groups) botCount += group.bots.length;
  return { groups, botCount };
}
