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
 * also why `staleTime` is zero: every open re-asks, rather than reusing the
 * last open's answer as fresh.
 *
 * What `staleTime: 0` does NOT do - and this doc used to say it did - is keep
 * the previous open's rows off the screen. A stale entry is refetched AND
 * returned: within `gcTime` a reopen resolves `status: "success"` with the old
 * `data` on the very first render, and only `isFetching` says a newer answer is
 * on its way. So the "must not paint rows from the last time it was open" rule
 * is a RENDER gate, not a cache setting, and it lives at the consumer -
 * `MenuBody` in `fallback-destination-menu.tsx`, whose `isPending` branch is
 * false in exactly that state.
 *
 * `gcTime: 0` is not the alternative and is deliberately not set here: under
 * StrictMode's double mount a zero-`gcTime` query is evicted between the paired
 * mounts while its fetch is in flight, the completion lands observer-less, and
 * the menu spins forever (`use-link-login-code-query.ts` carries the same note
 * for the same reason).
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
