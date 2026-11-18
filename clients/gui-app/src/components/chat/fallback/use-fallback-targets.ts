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
 * **`enabled` is whether the chooser can act.** `RoutingDestinationPicker`
 * opens on the listing's recommended account, so the answer has to be there
 * before the popover is: it is read while the chooser is mounted for a reader
 * who can steer, not only while it is open. The list is still a snapshot of a
 * world that moves (a gauge refreshes, a sibling chat takes the account), so
 * the chooser asks again on every open, and `staleTime` is zero so nothing
 * treats the last answer as fresh.
 *
 * What `staleTime: 0` does NOT do is keep the previous answer off the screen.
 * A stale entry is refetched AND returned: within `gcTime` it resolves
 * `status: "success"` with the old `data` on the very first render, and only
 * `isFetching` says a newer answer is on its way. The chooser is built for
 * that: its store follows each answer until the user edits it, so a newer
 * answer moves an untouched pick and never an edited one.
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
 * lost race rather than failing the call. No surface draws copy for them: the
 * chooser reads only `listed` rows and otherwise opens on the tuple it was
 * entered from, and only a transport failure reaches `isError`.
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
