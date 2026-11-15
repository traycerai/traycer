import {
  useMutation,
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
  BotUpdateAppearanceRequest,
  BotUpdateAppearanceResponse,
  BotUpdateReplyModeRequest,
  BotUpdateResponse,
  BotUpdateRunSettingsRequest,
  BotUpdateTitleRequest,
} from "@traycer/protocol/host/bot/schemas";
import type {
  BotConversationSendRequest,
  BotConversationSendResponse,
} from "@traycer/protocol/host/bot/conversation-schemas";
import {
  HostRpcError,
  type RequiredHostMethodVersion,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { finalRefusalOf } from "@traycer-clients/shared/host-transport/retrying-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { BotSetupRow } from "@traycer-clients/shared/host-client/bot-setup";
import { useHostBinding, type HostRpcRegistry } from "@/lib/host";
import { resolveNamedHostClient } from "@/lib/host/binding-host-client";
import { useHostMutation } from "@/hooks/host/use-host-query";
import {
  BOT_CONVERSATION_ANSWER_SET_VERSION,
  BOT_CONVERSATION_ANSWER_VERSION,
  BOT_CONVERSATION_CALL_VERSION,
  BOT_CONVERSATION_RETRY_VERSION,
} from "@/hooks/bots/use-bot-send-version";
import { botMutationKeys, hostQueryKeys } from "@/lib/query-keys";
import { toastFromHostError } from "@/lib/host-error-toast";
import { isFollowReadOf } from "@/hooks/bots/use-bot-thread-follow";
import { applyBotSettingsToViews } from "@/hooks/bots/use-bot-subscription";
import { botSetupError } from "@/hooks/bots/bot-setup-error";
import { pressSignIn, type PressSignIn } from "@/hooks/bots/bot-write-sign-in";

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
 * The run settings, the reply mode and the delete are the exceptions to the
 * client argument: they are the app's own calls to the server on the
 * person's sign-in, with no host in the path, so they need no host, the
 * bot's included.
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

/**
 * Archives the bot. A repeat answers `deleted: false`, which is a success.
 * Every list is read again, and a surface showing the bot leaves it when
 * the list no longer carries it.
 */
export function useBotDeleteMutation(): UseMutationResult<
  BotDeleteResponse | null,
  Error,
  BotDeleteRequest
> {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  return useMutation({
    mutationKey: botMutationKeys.delete(),
    mutationFn: async (request) => {
      if (binding === null) throw botSetupError({ kind: "no_response" });
      const signIn = pressSignIn(binding.auth);
      const result = await binding.auth.deleteBot(request);
      if (!signIn.isCurrent()) return null;
      if (result.kind !== "ok") throw botSetupError(result);
      return { deleted: result.deleted };
    },
    onSuccess: (answer) => {
      if (answer === null) return;
      invalidateBotLists(queryClient);
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

/**
 * The harness, model, effort and profile the bot's next turn runs on. The
 * answer is laid over every view of the bot this app holds, since no host
 * re-sends one for a change it did not make, and every list is read again.
 * `null` is a write whose sign-in ended before the answer (`pressSignIn`):
 * nothing is laid over, read again or said.
 */
export function useBotUpdateRunSettingsMutation(): UseMutationResult<
  BotRunSettingsWrite | null,
  Error,
  BotUpdateRunSettingsRequest
> {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  return useMutation({
    mutationKey: botMutationKeys.updateRunSettings(),
    mutationFn: async (request) => {
      if (binding === null) throw botSetupError({ kind: "no_response" });
      const signIn = pressSignIn(binding.auth);
      const result = await binding.auth.updateBotRunSettings(request);
      if (!signIn.isCurrent()) return null;
      if (result.kind !== "ok") throw botSetupError(result);
      return { bot: result.bot, signIn };
    },
    onSuccess: (written) => {
      if (written === null) return;
      applyBotSettingsToViews(queryClient, written.bot);
      invalidateBotLists(queryClient);
    },
  });
}

/**
 * A run-settings write the server took, with the sign-in it was pressed
 * under: a later step on its answer (the fallback's retry) asks that sign-in
 * first.
 */
export interface BotRunSettingsWrite {
  readonly bot: BotSetupRow;
  readonly signIn: PressSignIn;
}

export function useBotUpdateReplyModeMutation(): UseMutationResult<
  BotSetupRow | null,
  Error,
  BotUpdateReplyModeRequest
> {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  return useMutation({
    mutationKey: botMutationKeys.updateReplyMode(),
    mutationFn: async (request) => {
      if (binding === null) throw botSetupError({ kind: "no_response" });
      const signIn = pressSignIn(binding.auth);
      const result = await binding.auth.updateBotReplyMode(request);
      if (!signIn.isCurrent()) return null;
      if (result.kind !== "ok") throw botSetupError(result);
      return result.bot;
    },
    onSuccess: (bot) => {
      if (bot === null) return;
      applyBotSettingsToViews(queryClient, bot);
      invalidateBotLists(queryClient);
    },
  });
}

/**
 * The bot's icon, colour, what it wears or its channel background, each key
 * left out kept and each `null` cleared. No toast, and no list read of its
 * own: `useBotLookSaver` sends these in order and keeps the lists.
 */
export function useBotUpdateAppearanceMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotUpdateAppearanceResponse,
  HostRpcError,
  BotUpdateAppearanceRequest
> {
  return useHostMutation<HostRpcRegistry, "bot.updateAppearance">({
    client,
    method: "bot.updateAppearance",
    mapVariables: (variables) => variables,
    options: { mutationKey: botMutationKeys.updateAppearance() },
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
 * below {@link BOT_CONVERSATION_RETRY_VERSION}, a question card's answer by
 * one below {@link BOT_CONVERSATION_ANSWER_VERSION}, a card's answers sent
 * together by one below {@link BOT_CONVERSATION_ANSWER_SET_VERSION}, and a
 * call's words by one below {@link BOT_CONVERSATION_CALL_VERSION}.
 *
 * A send may change a thread, so the channel's thread list is read again on
 * the host the send went through. So is a card's answers sent together that
 * the bot's host does not take (`E_BOT_ANSWER_SETS_UNSUPPORTED`): the list
 * says what that host takes, and a card answers each question on its own
 * once it says so.
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
    requiredHostMethodVersion: conversationSendVersion,
    mapVariables: (variables) => variables,
    options: {
      mutationKey: botMutationKeys.conversationSend(),
      onMutate: () => ({ hostId: client?.getActiveHostId() ?? null }),
      onSuccess: (_response, variables, context) => {
        invalidateAfterConversationSend(
          queryClient,
          variables.botId,
          context.hostId,
        );
      },
      onError: (error, _variables, context) => {
        const hostId = context?.hostId ?? null;
        const refusal = finalRefusalOf(error);
        if (
          hostId !== null &&
          refusal instanceof HostRpcError &&
          refusal.code === "E_BOT_ANSWER_SETS_UNSUPPORTED"
        ) {
          void queryClient.invalidateQueries({
            queryKey: hostQueryKeys.methodScope(hostId, "bot.thread.list"),
          });
        }
      },
    },
  });
}

/** A call's send, the host it goes to and the account whose call it is. */
export interface BotCallSendVariables {
  readonly hostId: string;
  /** The account signed in when the call started; `null` owns no call. */
  readonly account: string | null;
  readonly request: BotConversationSendRequest;
}

/**
 * A call's words (Call Tracy), each to the host named with it rather than
 * to a host the hook follows: a call's last words still go to its own host
 * after another call has started on a different one.
 *
 * A send leaves only under the account whose call it is. The check runs in
 * the client resolver, in the same synchronous step as the dispatch (no
 * `prepareRequest` stands between them), against the request context that
 * dispatch carries; a switch after it aborts the captured authority in
 * HostClient. Any other account, or none, refuses the send.
 */
export function useBotCallSendMutation(): UseMutationResult<
  BotConversationSendResponse,
  HostRpcError,
  BotCallSendVariables,
  BotConversationSendContext
> {
  const queryClient = useQueryClient();
  const binding = useHostBinding();
  return useHostMutation<
    HostRpcRegistry,
    "bot.conversation.send",
    BotConversationSendContext,
    BotCallSendVariables
  >({
    client: (variables) => {
      const client = resolveNamedHostClient(binding, variables.hostId);
      if (
        client !== null &&
        (variables.account === null ||
          client.getRequestContextUserId() !== variables.account)
      ) {
        throw new Error("The call's account is no longer signed in.");
      }
      return client;
    },
    method: "bot.conversation.send",
    requiredHostMethodVersion: (variables) =>
      conversationSendVersion(variables.request),
    mapVariables: (variables) => variables.request,
    options: {
      mutationKey: botMutationKeys.conversationSend(),
      onMutate: (variables) => ({ hostId: variables.hostId }),
      onSuccess: (_response, variables, context) => {
        invalidateAfterConversationSend(
          queryClient,
          variables.request.botId,
          context.hostId,
        );
      },
    },
  });
}

/** The send line a request needs: a retry, an answer, a call's words and a card's answers together came later. */
function conversationSendVersion(
  variables: BotConversationSendRequest,
): RequiredHostMethodVersion | null {
  if (variables.spoken === true || variables.origin !== undefined) {
    return {
      method: "bot.conversation.send",
      version: BOT_CONVERSATION_CALL_VERSION,
    };
  }
  if (variables.answers !== undefined) {
    return {
      method: "bot.conversation.send",
      version: BOT_CONVERSATION_ANSWER_SET_VERSION,
    };
  }
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
}

function invalidateAfterConversationSend(
  queryClient: QueryClient,
  botId: string,
  hostId: string | null,
): void {
  // The send follows the person to its thread (decision 137).
  void queryClient.invalidateQueries({
    predicate: (query) => isFollowReadOf(query.queryKey, botId),
  });
  if (hostId === null) return;
  void queryClient.invalidateQueries({
    queryKey: hostQueryKeys.methodScope(hostId, "bot.thread.list"),
  });
}
