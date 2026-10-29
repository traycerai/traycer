import type { UseMutationResult } from "@tanstack/react-query";
import type {
  BotNotificationsStopRequest,
  BotNotificationsStopResponse,
  BotTaskActionRequest,
  BotTaskRunNowResponse,
  BotTaskSetPausedRequest,
  BotTaskSetPausedResponse,
  BotTaskStopResponse,
} from "@traycer/protocol/host/bot/task-action-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { botMutationKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * What a member does to a bot's automations and notification watches from
 * its Activity page (Tracy Bots T92). Each goes through the tab's host, which
 * the page offers them on only while it runs the bot, and is refused before
 * it leaves by a host without the method. Nothing to invalidate: the bot's
 * stream sends the row as the host now holds it.
 */
export function useBotTaskRunNowMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotTaskRunNowResponse,
  HostRpcError,
  BotTaskActionRequest
> {
  return useHostMutation<HostRpcRegistry, "bot.task.runNow">({
    client,
    method: "bot.task.runNow",
    mapVariables: (variables) => variables,
    requiredHostMethodVersion: () => ({
      method: "bot.task.runNow",
      version: { major: 1, minor: 0 },
    }),
    options: {
      mutationKey: botMutationKeys.taskRunNow(),
      onError: (error) =>
        toastFromHostError(error, "Couldn't run the automation."),
    },
  });
}

export function useBotTaskSetPausedMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotTaskSetPausedResponse,
  HostRpcError,
  BotTaskSetPausedRequest
> {
  return useHostMutation<HostRpcRegistry, "bot.task.setPaused">({
    client,
    method: "bot.task.setPaused",
    mapVariables: (variables) => variables,
    requiredHostMethodVersion: () => ({
      method: "bot.task.setPaused",
      version: { major: 1, minor: 0 },
    }),
    options: {
      mutationKey: botMutationKeys.taskSetPaused(),
      onError: (error, variables) =>
        toastFromHostError(
          error,
          variables.paused
            ? "Couldn't pause the automation."
            : "Couldn't resume the automation.",
        ),
    },
  });
}

export function useBotTaskStopMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<BotTaskStopResponse, HostRpcError, BotTaskActionRequest> {
  return useHostMutation<HostRpcRegistry, "bot.task.stop">({
    client,
    method: "bot.task.stop",
    mapVariables: (variables) => variables,
    requiredHostMethodVersion: () => ({
      method: "bot.task.stop",
      version: { major: 1, minor: 0 },
    }),
    options: {
      mutationKey: botMutationKeys.taskStop(),
      onError: (error) =>
        toastFromHostError(error, "Couldn't stop the automation."),
    },
  });
}

export function useBotNotificationsStopMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotNotificationsStopResponse,
  HostRpcError,
  BotNotificationsStopRequest
> {
  return useHostMutation<HostRpcRegistry, "bot.notifications.stop">({
    client,
    method: "bot.notifications.stop",
    mapVariables: (variables) => variables,
    requiredHostMethodVersion: () => ({
      method: "bot.notifications.stop",
      version: { major: 1, minor: 0 },
    }),
    options: {
      mutationKey: botMutationKeys.notificationsStop(),
      onError: (error) =>
        toastFromHostError(error, "Couldn't stop watching notifications."),
    },
  });
}
