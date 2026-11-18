import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import {
  useQueryClient,
  type QueryKey,
  type UseQueryResult,
  type UseMutationResult,
  type MutateOptions,
} from "@tanstack/react-query";
import type {
  BotReadCursorAdvanceRequest,
  BotReadCursorAdvanceResponse,
  BotReadCursorReadResponse,
} from "@traycer/protocol/host/bot/schemas";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostMutation, useHostQuery } from "@/hooks/host/use-host-query";
import { useHostQueries } from "@/hooks/host/use-host-queries";
import { useHostMethodSupport } from "@/hooks/host/use-host-supports-method";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";
import { useBotNotificationLevelsQuery } from "@/hooks/bots/use-bot-notification-level";
import { channelBold } from "@/lib/bots/bot-read-cursor";
import { botMutationKeys, hostQueryKeys } from "@/lib/query-keys";

import { currentBotLifetime, useBotLifetime } from "@/lib/bots/bot-lifetime";

const READ_METHOD = "bot.readCursor.read" as const;

/**
 * How far the person has read each of a bot's conversations, beside each
 * one's newest row (`bot.readCursor.read`, decision 139): what bold is
 * drawn from. The cursors are the PERSON's and live in the cloud, so the key
 * carries the viewer, as the notification levels do. Polled while the window
 * is visible, so a read on another device clears the bold here, and read
 * again when the window comes back; a bot's subscription reads it again as
 * its rows land.
 */
export function useBotReadCursorQuery(
  client: HostClient<HostRpcRegistry> | null,
  botId: string,
  enabled: boolean,
): UseQueryResult<BotReadCursorReadResponse, HostRpcError> {
  const params = useMemo(() => ({ botId }), [botId]);
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery<HostRpcRegistry, typeof READ_METHOD>({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: READ_METHOD,
    params,
    options: {
      enabled: enabled && viewerUserId.length > 0,
      poll: true,
      refetchOnWindowFocus: true,
    },
  });
}

/** Whether `queryKey` is a read-cursor read of `botId`, on any host scope. */
export function isReadCursorReadOf(queryKey: QueryKey, botId: string): boolean {
  return (
    hostQueryKeys.matchesMethodOnAnyHost(queryKey, READ_METHOD) &&
    queryKey.some(
      (part) =>
        typeof part === "object" &&
        part !== null &&
        "botId" in part &&
        part.botId === botId,
    )
  );
}

/** A batch may supply its own requester/component retirement signal. */
export type BotReadCursorAdvanceVariables =
  | BotReadCursorAdvanceRequest
  | (BotReadCursorAdvanceRequest & { readonly signal: AbortSignal | null });
interface CapturedAdvance {
  readonly request: BotReadCursorAdvanceRequest;
  readonly signal: AbortSignal;
  readonly publicVariables: BotReadCursorAdvanceVariables;
  readonly client: HostClient<HostRpcRegistry> | null;
  readonly clientIsCurrent: () => boolean;
  readonly dispose: () => void;
  readonly viewer: string;
  readonly lifetime: number;
}
function advanceIsCurrent(variables: CapturedAdvance): boolean {
  return (
    variables.lifetime === currentBotLifetime() &&
    !variables.signal.aborted &&
    variables.clientIsCurrent()
  );
}

/**
 * Cursor writes and cache updates belong to the viewer who initiated them.
 * Earned reads survive navigation, including while queued before dispatch.
 * The lifetime is an account epoch, not a fence for deleted bots; a cursor
 * write does not recreate its target. Any future mark-unread or rewind must
 * be ordered against already-sent forward advances.
 */
export function useBotReadCursorAdvanceMutation(
  client: HostClient<HostRpcRegistry> | null,
): UseMutationResult<
  BotReadCursorAdvanceResponse,
  HostRpcError,
  BotReadCursorAdvanceVariables
> {
  const queryClient = useQueryClient();
  const viewer = useCloudChatViewerId();
  const lifetime = useBotLifetime();
  const currentClient = useRef({ client });
  useLayoutEffect(() => {
    if (currentClient.current.client !== client)
      currentClient.current = { client };
  }, [client]);
  const mutation = useHostMutation<
    HostRpcRegistry,
    "bot.readCursor.advance",
    unknown,
    CapturedAdvance
  >({
    client: (variables) => variables.client,
    method: "bot.readCursor.advance",
    mapVariables: (variables) => variables.request,
    signalFor: (variables) => {
      if (!advanceIsCurrent(variables))
        throw new DOMException("Read action retired", "AbortError");
      return variables.signal;
    },
    options: {
      mutationKey: botMutationKeys.advanceReadCursor(),
      onSettled: (_data, _error, variables) => variables.dispose(),
      onSuccess: async ({ cursor }, variables) => {
        if (!advanceIsCurrent(variables)) return;
        const { request } = variables;
        const filter = {
          predicate: (query: { readonly queryKey: QueryKey }) =>
            isReadCursorReadOf(query.queryKey, request.botId) &&
            query.queryKey.at(-1) === variables.viewer,
        };
        await queryClient.cancelQueries(filter);
        if (!advanceIsCurrent(variables)) return;
        queryClient.setQueriesData<BotReadCursorReadResponse>(
          filter,
          (cached) => {
            if (cached === undefined) return cached;
            const held = Object.hasOwn(cached.cursors, request.conversationId)
              ? cached.cursors[request.conversationId]
              : null;
            if (held !== null && held.seq >= cursor.seq) return cached;
            return {
              ...cached,
              cursors: { ...cached.cursors, [request.conversationId]: cursor },
            };
          },
        );
      },
    },
  });
  const capture = useCallback(
    (variables: BotReadCursorAdvanceVariables): CapturedAdvance => {
      // Keep earned reads alive after navigation, but retire them immediately
      // when this requester changes authority, before the auth store updates.
      const scope = currentClient.current;
      const authority = new AbortController();
      const unsubscribe = client?.onChange((event) => {
        if (event.reason === "auth-changed") authority.abort();
      });
      const supplied = "signal" in variables ? variables.signal : null;
      // The mobile WebView floor predates AbortSignal.any.
      const forwardAbort = (): void => authority.abort(supplied?.reason);
      if (supplied?.aborted) forwardAbort();
      else supplied?.addEventListener("abort", forwardAbort, { once: true });
      return {
        request: {
          botId: variables.botId,
          conversationId: variables.conversationId,
          messageId: variables.messageId,
          seq: variables.seq,
        },
        publicVariables: variables,
        client,
        clientIsCurrent: () =>
          currentClient.current === scope && scope.client === client,
        dispose: () => {
          unsubscribe?.();
          supplied?.removeEventListener("abort", forwardAbort);
        },
        signal: authority.signal,
        viewer,
        lifetime,
      };
    },
    [client, viewer, lifetime],
  );
  const { mutate, mutateAsync } = mutation;
  const publicMutate = useCallback(
    (
      variables: BotReadCursorAdvanceVariables,
      options: AdvanceOptions | undefined,
    ) => mutate(capture(variables), capturedOptions(options)),
    [capture, mutate],
  );
  const publicMutateAsync = useCallback(
    (
      variables: BotReadCursorAdvanceVariables,
      options: AdvanceOptions | undefined,
    ) => mutateAsync(capture(variables), capturedOptions(options)),
    [capture, mutateAsync],
  );
  const methods = { mutate: publicMutate, mutateAsync: publicMutateAsync };
  if (mutation.isIdle) return { ...mutation, ...methods, variables: undefined };
  return {
    ...mutation,
    ...methods,
    variables: mutation.variables.publicVariables,
  };
}

type AdvanceOptions = MutateOptions<
  BotReadCursorAdvanceResponse,
  HostRpcError,
  BotReadCursorAdvanceVariables
>;

/** Per-call callbacks see the caller's variables, never the private authority capture. */
function capturedOptions(
  options: AdvanceOptions | undefined,
):
  | MutateOptions<BotReadCursorAdvanceResponse, HostRpcError, CapturedAdvance>
  | undefined {
  if (options === undefined) return undefined;
  return {
    onSuccess: (data, variables, result, context) =>
      options.onSuccess?.(data, variables.publicVariables, result, context),
    onError: (error, variables, result, context) =>
      options.onError?.(error, variables.publicVariables, result, context),
    onSettled: (...args) => {
      const [data, error, variables, result, context] = args;
      options.onSettled?.(
        data,
        error,
        variables.publicVariables,
        result,
        context,
      );
    },
  };
}

/** Whether the tab's host reads and advances the person's read cursors. */
export function useBotReadCursorSupported(hostId: string | null): boolean {
  const read = useHostMethodSupport(hostId, READ_METHOD) === true;
  const advance =
    useHostMethodSupport(hostId, "bot.readCursor.advance") === true;
  return read && advance;
}

/**
 * The person's read cursors on a bot, through the tab's host; `null` on a
 * host that cannot read and advance them, where bold stays the
 * notification indicators'.
 */
export function useBotReadCursors(
  botId: string,
  hostId: string,
): UseQueryResult<BotReadCursorReadResponse, HostRpcError> | null {
  const supported = useBotReadCursorSupported(hostId);
  const read = useBotReadCursorQuery(useTabHostClient(), botId, supported);
  return supported ? read : null;
}

/**
 * Whether a bot's channel is bold, as its read cursor says; `null` where
 * the host keeps no cursors, or has not answered yet, and the caller keeps
 * the notification indicators' bold.
 */
export function useBotChannelBold(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  botId: string,
  channelId: string | null,
): boolean | null {
  const supported = useBotReadCursorSupported(hostId) && channelId !== null;
  const read = useBotReadCursorQuery(client, botId, supported).data;
  const levelsSupported =
    useHostMethodSupport(hostId, "bot.notificationLevel.read") === true;
  const levels = useBotNotificationLevelsQuery(
    client,
    botId,
    supported && levelsSupported,
  ).data?.levels;
  if (!supported || read === undefined) return null;
  return channelBold(read, channelId, levels);
}

/** One of the person's bots, by its channel. */
export type BotChannelRef = {
  readonly botId: string;
  readonly channelId: string | null;
};

/**
 * Whether any of `bots`' channels is bold, as their read cursors say: one
 * read per bot, shared with each bot's own row. `null` where the host keeps
 * no cursors, or none has answered yet.
 */
export function useAnyBotChannelBold(
  client: HostClient<HostRpcRegistry> | null,
  hostId: string | null,
  bots: readonly BotChannelRef[],
): boolean | null {
  const supported = useBotReadCursorSupported(hostId);
  const levelsSupported =
    useHostMethodSupport(hostId, "bot.notificationLevel.read") === true;
  const viewerUserId = useCloudChatViewerId();
  const channels = useMemo(
    () => bots.filter((bot) => bot.channelId !== null),
    [bots],
  );
  const readRequests = useMemo(
    () =>
      channels.map((bot) => ({
        method: READ_METHOD,
        params: { botId: bot.botId },
      })),
    [channels],
  );
  const levelRequests = useMemo(
    () =>
      channels.map((bot) => ({
        method: "bot.notificationLevel.read" as const,
        params: { botId: bot.botId },
      })),
    [channels],
  );
  // Keyed as each bot's own read is, so a row and the entry share one read.
  const enabled = supported && viewerUserId.length > 0;
  const reads = useHostQueries<HostRpcRegistry, typeof READ_METHOD>({
    client,
    requests: readRequests,
    cacheKeyIdentity: viewerUserId,
    options: { enabled, poll: true, refetchOnWindowFocus: true },
  });
  const levels = useHostQueries<HostRpcRegistry, "bot.notificationLevel.read">({
    client,
    requests: levelRequests,
    cacheKeyIdentity: viewerUserId,
    options: {
      enabled: enabled && levelsSupported,
      refetchOnWindowFocus: true,
    },
  });
  if (!supported) return null;
  let answered = false;
  for (const [index, bot] of channels.entries()) {
    const read = reads[index]?.data;
    if (read === undefined || bot.channelId === null) continue;
    answered = true;
    if (channelBold(read, bot.channelId, levels[index]?.data?.levels)) {
      return true;
    }
  }
  return answered ? false : null;
}
