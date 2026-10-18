import {
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import type {
  BotClaimAuthorityRequest,
  BotClaimAuthorityResponse,
  BotCreateRequest,
  BotCreateResponse,
  BotDeleteRequest,
  BotDeleteResponse,
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
import { botMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";

/**
 * The `bot.*` writes (Tracy Bots). Every hook takes the client that carries the
 * request as an ARGUMENT: a create goes to the host the bot will be bound to,
 * a claim goes to the host that is claiming, a conversation send goes to the
 * tab's bound host. None of them may fall back to the app-wide host on their
 * own - that is the substitution the tab-host rule exists to prevent.
 *
 * Each write invalidates `bot.list` on EVERY host scope rather than on one:
 * the list is cloud-backed and identical everywhere, so a create on host B
 * makes host A's cached list stale too.
 */
type BotMutationContext = { readonly hostId: string | null };

function invalidateBotLists(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({
    predicate: (query) =>
      hostQueryKeys.matchesMethodOnAnyHost(query.queryKey, "bot.list"),
  });
}

export function useBotCreateMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotCreateResponse,
  HostRpcError,
  BotCreateRequest,
  BotMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.create", BotMutationContext>({
    client,
    method: "bot.create",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.create(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
      onError: (error) => toastFromHostError(error, "Couldn't create the bot."),
    },
  });
}

export function useBotDeleteMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotDeleteResponse,
  HostRpcError,
  BotDeleteRequest,
  BotMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<HostRpcRegistry, "bot.delete", BotMutationContext>({
    client,
    method: "bot.delete",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.delete(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
      onError: (error) => toastFromHostError(error, "Couldn't delete the bot."),
    },
  });
}

export function useBotUpdateTitleMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotUpdateResponse,
  HostRpcError,
  BotUpdateTitleRequest,
  BotMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "bot.updateTitle",
    BotMutationContext
  >({
    client,
    method: "bot.updateTitle",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.updateTitle(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
      onError: (error) => toastFromHostError(error, "Couldn't rename the bot."),
    },
  });
}

export function useBotUpdateRunSettingsMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotUpdateResponse,
  HostRpcError,
  BotUpdateRunSettingsRequest,
  BotMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "bot.updateRunSettings",
    BotMutationContext
  >({
    client,
    method: "bot.updateRunSettings",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.updateRunSettings(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't change the bot's model."),
    },
  });
}

/**
 * Rebinds the bot to the host behind `client` - the serving host supplies its
 * own id. The bot row and every chat under it move together, so the caller's
 * bot tab (bound to the previous host) is replaced by one bound here.
 */
export function useBotClaimAuthorityMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotClaimAuthorityResponse,
  HostRpcError,
  BotClaimAuthorityRequest,
  BotMutationContext
> {
  const queryClient = useQueryClient();
  return useHostMutation<
    HostRpcRegistry,
    "bot.claimAuthority",
    BotMutationContext
  >({
    client,
    method: "bot.claimAuthority",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.claimAuthority(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: () => {
        invalidateBotLists(queryClient);
      },
      onError: (error) =>
        toastFromHostError(error, "Couldn't move the bot to this host."),
    },
  });
}

/**
 * One human message into a conversation. Accepted whether or not the bound
 * host is reachable: `delivery: "queued"` means the message waits in the
 * cross-host mailbox and the row appears when the bound host drains it. No
 * toast on error - the composer states the refusal inline, under the field.
 */
export function useBotConversationSendMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotConversationSendResponse,
  HostRpcError,
  BotConversationSendRequest,
  BotMutationContext
> {
  return useHostMutation<
    HostRpcRegistry,
    "bot.conversation.send",
    BotMutationContext
  >({
    client,
    method: "bot.conversation.send",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.conversationSend(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
    },
  });
}
