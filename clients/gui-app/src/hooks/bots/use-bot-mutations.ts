import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteRequest,
  BotDeleteResponse,
  BotOpenRequest,
  BotOpenResponse,
  BotUpdateReplyModeRequest,
  BotUpdateResponse,
  BotUpdateRunSettingsRequest,
  BotUpdateTitleRequest,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  BOT_CONVERSATION_ANSWER_VERSION,
  BOT_CONVERSATION_RETRY_VERSION,
} from "@/hooks/bots/use-bot-send-version";
import { botMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { isFollowReadOf } from "@/hooks/bots/use-bot-thread-follow";

/**
 * The `bot.*` writes (Tracy Bots). Every hook takes the client that carries the
 * request as an ARGUMENT: a create goes to the host the bot will be bound to,
 * an open goes to the host serving the tab, which may claim the bot, and a
 * conversation send or a settings write goes through the tab's host. None of them may fall back to the app-wide host on their
 * own - that is the substitution the tab-host rule exists to prevent.
 *
 * The bot tab's Settings writes (rename, model, delete) carry no toast: the
 * panel states a refusal inline, under the control that made the call.
 *
 * Each write invalidates `bot.list` on EVERY host scope rather than on one:
 * the list is cloud-backed and identical everywhere, so a create on host B
 * makes host A's cached list stale too.
 */
export function invalidateBotLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list"),
  });
}

export function useBotCreateMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<BotCreateResponse, HostRpcError, BotCreateRequest> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.create">({
    client,
    method: "bot.create",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.create(),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
      onError: (error) => toastFromHostError(error, "Couldn't create the bot."),
    },
  });
}

export function useBotDeleteMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<BotDeleteResponse, HostRpcError, BotDeleteRequest> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.delete">({
    client,
    method: "bot.delete",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.delete(),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
    },
  });
}

export function useBotUpdateTitleMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<BotUpdateResponse, HostRpcError, BotUpdateTitleRequest> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.updateTitle">({
    client,
    method: "bot.updateTitle",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.updateTitle(),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
    },
  });
}

export function useBotUpdateRunSettingsMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotUpdateResponse,
  HostRpcError,
  BotUpdateRunSettingsRequest
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.updateRunSettings">({
    client,
    method: "bot.updateRunSettings",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.updateRunSettings(),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
    },
  });
}

export function useBotUpdateReplyModeMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotUpdateResponse,
  HostRpcError,
  BotUpdateReplyModeRequest
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.updateReplyMode">({
    client,
    method: "bot.updateReplyMode",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.updateReplyMode(),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
    },
  });
}

/**
 * Opens the bot on the host behind `client`: that host answers whether
 * it serves the bot, whether another host does, or why none can now, and
 * claims the bot onto itself when its bound host cannot be reached. The tab
 * follows the answer; the person never picks the host. No toast: the tab
 * states every outcome, a failure included, in place.
 */
export function useBotOpenMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<BotOpenResponse, HostRpcError, BotOpenRequest> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.open">({
    client,
    method: "bot.open",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.open(),
      // A claim moves the bot's bound host, and a not-found answer means the
      // bot is gone: either way every cached list is stale.
      onSettled: () => {
        invalidateBotLists(queryClient);
      },
    },
  });
}

/** The host a send went through, captured before it left. */
interface BotConversationSendContext {
  readonly hostId: string | null;
}

/**
 * One member's message: a post on the channel (`threadId: null`) or a reply
 * in a thread. Accepted whether or not the bound
 * host is reachable: `delivery: "queued"` means the message waits in the
 * cross-host mailbox and the row appears when the bound host drains it. No
 * toast on error - the composer states the refusal inline, under the field.
 * A retry or an edit's replacement is refused before it leaves by a host
 * below {@link BOT_CONVERSATION_RETRY_VERSION}, and a question card's answer
 * by one below {@link BOT_CONVERSATION_ANSWER_VERSION}.
 *
 * A send may change a thread, so the channel's thread list is read again on
 * the host the send went through.
 */
export function useBotConversationSendMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotConversationSendResponse,
  HostRpcError,
  BotConversationSendRequest,
  BotConversationSendContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "bot.conversation.send",
    BotConversationSendContext
  >({
    client,
    method: "bot.conversation.send",
    requiredHostMethodVersion: (variables) => {
      if (variables.answer !== null) {
        return {
          method: "bot.conversation.send",
          version: BOT_CONVERSATION_ANSWER_VERSION,
        };
      }
      return variables.redeliver === null && variables.supersedes === null
        ? null
        : {
            method: "bot.conversation.send",
            version: BOT_CONVERSATION_RETRY_VERSION,
          };
    },
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.conversationSend(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_response, variables, context) => {
        // The send follows the person to its thread (decision 137).
        void queryClient.invalidateQueries({
          predicate: (query) => isFollowReadOf(query.queryKey, variables.botId),
        });
        if (context.hostId === null) return;
        void queryClient.invalidateQueries({
          queryKey: hostQueryKeys.methodScope(
            context.hostId,
            "bot.thread.list",
          ),
        });
      },
    },
  });
}
