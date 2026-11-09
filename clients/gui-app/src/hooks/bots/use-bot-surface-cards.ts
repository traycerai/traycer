import { useMemo } from "react";
import type {
  BotSurfaceActionState,
  BotTaskEntry,
} from "@traycer/protocol/host/bot/schemas";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { BotSurfaceCards } from "@/components/bots/bot-surface-card-context";
import { useBotSurfaceActMutation } from "@/hooks/bots/use-bot-surface-act";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import {
  botMemberName,
  type BotMemberResolver,
} from "@/lib/bots/bot-member-names";
import type { HostRpcRegistry } from "@/lib/host";
import type { AuthProfile } from "@/stores/auth/auth-store";

/**
 * What a surface post's card reads and sends (T89): each task's open
 * surfaces and the viewer's forwarded actions from the bot's subscription,
 * and the send through the tab's host, which offers it only where that host
 * takes it.
 */
export function useBotSurfaceCards(args: {
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly hostId: string;
  readonly botId: string;
  readonly viewer: AuthProfile | null;
  readonly resolveMember: BotMemberResolver;
  readonly tasks: ReadonlyArray<BotTaskEntry>;
  readonly surfaceActions: ReadonlyArray<BotSurfaceActionState> | null;
}): BotSurfaceCards {
  const {
    client,
    hostId,
    botId,
    viewer,
    resolveMember,
    tasks,
    surfaceActions,
  } = args;
  const actSupported = useHostMethodSupport(hostId, "bot.surface.act") === true;
  const { mutateAsync: actAsync } = useBotSurfaceActMutation(client);
  return useMemo<BotSurfaceCards>(
    () => ({
      botId,
      viewerUserId: viewer?.userId ?? null,
      memberName: (userId) => botMemberName(userId, viewer, resolveMember),
      openSurfaces: (taskId) =>
        tasks.find((task) => task.taskId === taskId)?.inputNeeded ?? null,
      hostAction: (actionId) =>
        surfaceActions?.find((action) => action.actionId === actionId) ?? null,
      postActions: (messageId) =>
        surfaceActions?.filter((action) => action.messageId === messageId) ??
        [],
      act: actSupported && client !== null ? actAsync : null,
    }),
    [
      actAsync,
      actSupported,
      botId,
      client,
      resolveMember,
      surfaceActions,
      tasks,
      viewer,
    ],
  );
}
