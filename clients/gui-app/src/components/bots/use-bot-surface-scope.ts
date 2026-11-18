import { useMemo } from "react";
import type { BotTaskEntry } from "@traycer/protocol/host/bot/schemas";
import type {
  EnvironmentListResponseV11,
  EnvironmentMember,
} from "@traycer/protocol/host/environment/contracts";
import type { BotOwner } from "@/components/bots/bot-identity-context";
import type {
  BotMentionDirectory,
  BotMentioned,
} from "@/components/bots/bot-mentions-context";
import { useBotMentionTargets } from "@/components/bots/use-bot-mention-targets";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import { useAuthStore } from "@/stores/auth/auth-store";

type ListedEnvironment = EnvironmentListResponseV11["environments"][number];

/**
 * Who answers for a bot: the team of an organization's environment, with
 * its members as the directory lists them, or the viewer, whose personal
 * environment it is; `null` until the environment list names it.
 */
export function useBotOwner(
  environment: ListedEnvironment | null,
  members: ReadonlyArray<EnvironmentMember> | null,
): BotOwner | null {
  const viewer = useAuthStore((s) => s.profile);
  return useMemo((): BotOwner | null => {
    if (environment === null) return null;
    if (environment.ownerKind === "organization") {
      return {
        kind: "team",
        name: environment.label,
        members,
      };
    }
    // A personal environment the list names is the viewer's own.
    if (viewer === null) return null;
    const name = viewer.userName.trim();
    return {
      kind: "person",
      userId: viewer.userId,
      name: name.length > 0 ? name : "You",
      avatarUrl: viewer.avatarUrl ?? null,
    };
  }, [environment, members, viewer]);
}

/**
 * What a bot's text can name (decisions 137, 177): the viewer, or a member
 * the directory lists, by name; anyone else's token stays as written. A bot
 * or a task is one of the environment's. `environmentsRead` says whether the
 * environment list has answered, which decides whether the environment is
 * the viewer's personal one.
 */
export function useBotMentionDirectory(input: {
  readonly environmentId: string;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly environmentsRead: boolean;
  readonly environment: ListedEnvironment | null;
  readonly resolveMember: BotMemberResolver;
}): BotMentionDirectory {
  const { environmentId, tasks, environmentsRead, environment, resolveMember } =
    input;
  const viewer = useAuthStore((s) => s.profile);
  const mentionTargets = useBotMentionTargets({
    environmentId,
    tasks,
    personal: viewerOwnsEnvironment(!environmentsRead, environment),
  });
  return useMemo((): BotMentionDirectory => {
    const person = (userId: string): BotMentioned | null => {
      if (viewer !== null && viewer.userId === userId) {
        return {
          name: botMemberName(userId, viewer, resolveMember),
          self: true,
        };
      }
      const member = resolveMember(userId);
      if (member === null) return null;
      return { name: member.displayName ?? "member", self: false };
    };
    return {
      person,
      bots: mentionTargets.bots,
      tasks: mentionTargets.tasks,
      tasksAnswered: mentionTargets.tasksAnswered,
    };
  }, [
    mentionTargets.bots,
    mentionTargets.tasks,
    mentionTargets.tasksAnswered,
    resolveMember,
    viewer,
  ]);
}

/**
 * Whether a bot's environment is the viewer's personal one; `null` while the
 * environment list has not answered. The list holds only the viewer's own
 * environments, so its one personal entry is theirs.
 */
function viewerOwnsEnvironment(
  unread: boolean,
  environment: ListedEnvironment | null,
): boolean | null {
  if (unread) return null;
  return environment !== null && environment.ownerKind === "user";
}
