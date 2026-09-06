import type { UseQueryResult } from "@tanstack/react-query";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  HostRpcError,
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostQuery } from "@/hooks/host/use-host-query";
import type { HostRpcRegistry } from "@/lib/host";

/** How the caller names the work whose destinations it is asking about. */
export type FallbackTargetSelector = RequestOfMethod<
  HostRpcRegistry,
  "chat.fallback.listTargets"
>["selector"];

export type FallbackTargetsResult = UseQueryResult<
  ResponseOfMethod<HostRpcRegistry, "chat.fallback.listTargets">,
  HostRpcError
>;

/**
 * What the destination menu may offer, computed by the ENGINE.
 *
 * A QUERY and not a mutation, and safely so: `chat.fallback.listTargets` is
 * read-only by contract - no probe, no gauge write, no record write - which is
 * what makes it legal to call on every menu open and to refetch freely.
 *
 * Three things are deliberate here.
 *
 * **`enabled` is the menu's open state.** The list is a snapshot of a world
 * that moves (a gauge refreshes, a sibling chat takes the account), so it is
 * fetched when the menu opens rather than held warm behind every card. That is
 * also why `staleTime` is zero: a menu reopened a minute later must not paint
 * rows from the last time it was open.
 *
 * **The selector is part of the cache identity**, through `params`. The grace
 * card and the error card can ask about the same chat in the same second and
 * mean different things - one names a live traversal, the other a failed
 * attempt - and a key that collapsed them would show one surface the other's
 * answer.
 *
 * **A refusal is not an error.** `outcome` is `no_active_traversal`,
 * `traversal_advanced`, `attempt_not_latest` or `state_unreadable` in a
 * SUCCESSFUL response with empty lists, exactly as the action verbs answer a
 * lost race rather than failing the call. The caller renders those; only a
 * transport failure reaches `isError`.
 */
export function useFallbackListTargets(
  client: HostClient<HostRpcRegistry> | null,
  input: {
    readonly epicId: string;
    readonly chatId: string;
    readonly selector: FallbackTargetSelector;
    readonly enabled: boolean;
  },
): FallbackTargetsResult {
  return useHostQuery<HostRpcRegistry, "chat.fallback.listTargets">({
    cacheKeyIdentity: undefined,
    client,
    method: "chat.fallback.listTargets",
    params: {
      epicId: input.epicId,
      chatId: input.chatId,
      selector: input.selector,
    },
    options: {
      enabled: input.enabled,
      subscribed: input.enabled,
      staleTime: 0,
    },
  });
}
