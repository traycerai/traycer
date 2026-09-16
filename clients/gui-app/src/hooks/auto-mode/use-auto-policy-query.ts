import type { UseQueryResult } from "@tanstack/react-query";
import type { AutoPolicyGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useCloudChatViewerId } from "@/hooks/chats/use-cloud-chat-queries";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const AUTO_POLICY_GET_PARAMS = {};

/**
 * The account's auto-mode policy, as the surface's host sees it.
 *
 * ACCOUNT data over a HOST call, deliberately: the record lives on
 * traycer-server so it follows the user across machines, and the host proxies
 * it so what the panel edits is what the judge on that machine will actually
 * apply (a host that could not refresh its cached copy answers with the copy it
 * has, and `readState: "stale"` to say so).
 *
 * The response is three answers, not one: `body`/`updatedAt` say what the
 * policy is, `readState` says how far that can be trusted - including the case
 * where `body: null` means "could not look" rather than "never saved" - and
 * `shippedDefaults` carries the host's own bundled judge policy, which is
 * readable even when the account record is not. Both of the latter are optional
 * on the wire; `autoPolicyReadStateFor` is where the absent-`readState`
 * fallback is spelled.
 *
 * `refetchOnMount: "always"` because the record is shared: another device may
 * have saved since this window last looked, and `updatedAt` is what the editor
 * warns a stale edit against - a cached answer would make that warning
 * unreliable in exactly the case it exists for. There is no polling (see the
 * method policy table): a person editing on another device is not an event a
 * timer can catch, and every open settings tab waking the host - and through it
 * the cloud - for it would be worse than the warning being one save behind.
 *
 * An OPTIONAL capability; callers gate on
 * `useHostSupportsMethod(hostId, "autoPolicy.get")`.
 */
export function useAutoPolicyQuery(): UseQueryResult<
  AutoPolicyGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  // ACCOUNT-OWNED DATA UNDER A HOST KEY IS A CROSS-IDENTITY LEAK.
  //
  // `["host", hostId, method, params]` says nothing about WHO asked, and an
  // auth identity transition "marks stale WITHOUT refetching"
  // (`createHostQueryInvalidator`) - so the cached body survives the switch and
  // the next observer is served it SYNCHRONOUSLY. After A signs out and B signs
  // in on the same instance, Permissions opened as B with A's policy on screen,
  // Edit enabled, until the mandatory refetch landed; a save inside that window
  // would have written A's prose into B's account.
  //
  // The viewer id closes it by construction: B's first render looks up a key
  // that has never held data, so there is nothing to serve. `""` (no context
  // metadata yet) is its own bucket for the same reason, which is the safe
  // direction. Same read every other viewer-scoped surface uses rather than a
  // second spelling of the same field.
  //
  // `autoJudge.get` deliberately does NOT take this: it answers from a file
  // only this GUI writes ON THAT MACHINE, so it is host-owned and the host key
  // already says everything about who owns it. The distinction is ownership,
  // not caution - adding a user segment there would fragment a per-machine
  // cache for nothing.
  //
  // Appended AFTER the method key (`use-host-query.ts` spreads
  // `cacheKeyIdentity` last), so the method scope stays a valid PREFIX and
  // every INVALIDATION keyed on it still reaches this entry. The write-through
  // in `use-auto-policy-set-mutation.ts` deliberately does NOT use that prefix
  // any more: a prefix write lands on every viewer's partition at once, which
  // is this same leak through the other door. It addresses one entry through
  // `hostQueryKeys.autoPolicyForViewer`, which restates the key shape built
  // here - move one and move the other.
  const viewerUserId = useCloudChatViewerId();
  return useHostQuery({
    cacheKeyIdentity: [viewerUserId],
    client,
    method: "autoPolicy.get",
    params: AUTO_POLICY_GET_PARAMS,
    options: { refetchOnWindowFocus: false, refetchOnMount: "always" },
  });
}
