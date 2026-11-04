import { useMemo } from "react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type { BotMentionTarget } from "@/components/bots/bot-mentions-context";
import { useEpicGetTaskContexts } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useCloudEpicTasksQuery } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { taskMentionDisplayTitle } from "@/lib/composer/mentions/task-mention-helpers";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

const NO_TASK_IDS: ReadonlyArray<string> = [];

/** The bots and tasks a bot's channel can name (decision 177). */
export interface BotMentionTargets {
  /** `null` while the bots directory has not answered. */
  readonly bots: ReadonlyArray<BotMentionTarget> | null;
  readonly tasks: ReadonlyArray<BotMentionTarget>;
  /** The cloud's own first page of Home and the stream's task contexts have answered. */
  readonly tasksSettled: boolean;
}

/**
 * What a bot's channel can name besides its people, from the bot's own
 * environment only:
 *
 * - its live bots, from the standalone bots directory (the one every
 *   standalone name reads), by title as Home's group for the environment
 *   lists them;
 * - its tasks: the ones the bot's stream lists (`tasks`), titled by their
 *   contexts as the bot's task list titles them, then the tasks on Home's
 *   task list (`epic.listTasks`' first page, the cache Home and the agent
 *   composer's `@` read) that the environment owns (`ownerEnvironmentId`).
 *   A task with no title read yet is left out.
 */
export function useBotMentionTargets(input: {
  readonly environmentId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
}): BotMentionTargets {
  const { environmentId, tasks } = input;
  const directory = useStandaloneBotsStore((state) => state.directory);
  const settled = useStandaloneBotsStore((state) => state.settled);
  const bots = useMemo((): ReadonlyArray<BotMentionTarget> | null => {
    const group = directory.model.groups.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (group === undefined) return settled ? [] : null;
    return group.bots.map((bot) => ({ id: bot.botId, name: bot.title }));
  }, [directory, environmentId, settled]);

  const userId = useAuthStore((s) => s.profile?.userId ?? null);
  const cloud = useAuthStore((s) => authorizesCloudCapability(s.status));
  const streamTaskIds = useMemo(
    () => (tasks.length === 0 ? NO_TASK_IDS : tasks.map((t) => t.taskId)),
    [tasks],
  );
  const contexts = useEpicGetTaskContexts(streamTaskIds, userId, {
    enabled: cloud,
  });
  const home = useCloudEpicTasksQuery(undefined, { enabled: true });
  const taskTargets = useMemo((): ReadonlyArray<BotMentionTarget> => {
    const seen = new Set<string>();
    const targets: BotMentionTarget[] = [];
    for (const taskId of streamTaskIds) {
      const light = contexts.tasksById.get(taskId)?.epic?.light ?? null;
      if (light === null || seen.has(taskId)) continue;
      seen.add(taskId);
      targets.push({ id: taskId, name: taskMentionDisplayTitle(light) });
    }
    for (const row of home.tasks) {
      const light = row.epic?.light ?? null;
      if (
        light === null ||
        row.ownerEnvironmentId !== environmentId ||
        seen.has(light.id)
      ) {
        continue;
      }
      seen.add(light.id);
      targets.push({ id: light.id, name: taskMentionDisplayTitle(light) });
    }
    return targets;
  }, [contexts.tasksById, environmentId, home.tasks, streamTaskIds]);

  // Settled only on the cloud's own first page: a cached page or a local
  // snapshot whose cloud half is pending may lack a task the cloud lists, and
  // one whose cloud half is unavailable, or a read that failed, will not
  // bring it. Until then a task the directory lacks stays as written.
  const tasksSettled =
    !home.firstPagePending &&
    home.firstPageError === null &&
    !home.presentsCachedPage &&
    !home.isCloudPagePending &&
    home.completeness?.cloudPage !== "unavailable" &&
    !contexts.isPending &&
    contexts.error === null;

  return { bots, tasks: taskTargets, tasksSettled };
}
