import { useMemo } from "react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type { ListTaskLight } from "@traycer/protocol/host/epic/unary-schemas";
import type { BotMentionTarget } from "@/components/bots/bot-mentions-context";
import { useEpicGetTaskContextsForClient } from "@/hooks/epic/use-epic-get-task-contexts-query";
import { useCloudEpicTasksQueryForClient } from "@/hooks/epics/use-cloud-epic-tasks-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { taskMentionDisplayTitle } from "@/lib/composer/mentions/task-mention-helpers";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import { useStandaloneBotsStore } from "@/stores/bots/standalone-bots-store";

const NO_TASK_IDS: ReadonlyArray<string> = [];

/** The bots and tasks a bot's channel can name (decision 177). */
export interface BotMentionTargets {
  /**
   * `null` until the bot list has answered and the environment's group is
   * listed: before that a bot the list lacks is not known to be gone.
   */
  readonly bots: ReadonlyArray<BotMentionTarget> | null;
  readonly tasks: ReadonlyArray<BotMentionTarget>;
}

/**
 * A Home row as one of the environment's tasks: one the environment owns,
 * or, for the viewer's personal environment, one the viewer owns directly
 * (that environment's one member owns its tasks), read off the viewer's own
 * owner permission on the row.
 */
function isEnvironmentTask(
  row: ListTaskLight,
  environmentId: string,
  personalOwnerId: string | null,
): boolean {
  if (row.ownerEnvironmentId === environmentId) return true;
  const permission = row.epic?.permission ?? null;
  return (
    personalOwnerId !== null &&
    row.ownerEnvironmentId === undefined &&
    permission !== null &&
    permission.role === "owner" &&
    permission.accessType === "direct" &&
    permission.userId === personalOwnerId
  );
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
 *   composer's `@` read) that the environment owns (`ownerEnvironmentId`),
 *   or, in the viewer's personal environment, that the viewer owns
 *   directly. A task with no title read yet is left out.
 *
 * `personal` says whether the bot's environment is the viewer's personal
 * one, `null` while the environment list has not answered.
 */
export function useBotMentionTargets(input: {
  readonly environmentId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly personal: boolean | null;
}): BotMentionTargets {
  const { environmentId, tasks, personal } = input;
  const directory = useStandaloneBotsStore((state) => state.directory);
  const botsListed = useStandaloneBotsStore((state) => state.botsListed);
  const bots = useMemo((): ReadonlyArray<BotMentionTarget> | null => {
    if (!botsListed) return null;
    const group = directory.model.groups.find(
      (candidate) => candidate.environmentId === environmentId,
    );
    if (group === undefined) return null;
    return group.bots.map((bot) => ({ id: bot.botId, name: bot.title }));
  }, [botsListed, directory, environmentId]);

  const userId = useAuthStore((s) => s.profile?.userId ?? null);
  const cloud = useAuthStore((s) => authorizesCloudCapability(s.status));
  const streamTaskIds = useMemo(
    () => (tasks.length === 0 ? NO_TASK_IDS : tasks.map((t) => t.taskId)),
    [tasks],
  );
  // The tab's own host, which the bot's tasks are read from, whichever host
  // the app has active.
  const client = useTabHostClient();
  const contexts = useEpicGetTaskContextsForClient(
    client,
    streamTaskIds,
    userId,
    { enabled: cloud },
  );
  const home = useCloudEpicTasksQueryForClient(client, undefined, {
    enabled: true,
  });
  const personalOwnerId = personal === true ? userId : null;
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
        !isEnvironmentTask(row, environmentId, personalOwnerId) ||
        seen.has(light.id)
      ) {
        continue;
      }
      seen.add(light.id);
      targets.push({ id: light.id, name: taskMentionDisplayTitle(light) });
    }
    return targets;
  }, [
    contexts.tasksById,
    environmentId,
    home.tasks,
    personalOwnerId,
    streamTaskIds,
  ]);

  return { bots, tasks: taskTargets };
}
