import { useMemo } from "react";
import type { GuiHarnessId } from "@traycer/protocol/host/index";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useReactiveHostReadiness } from "@/hooks/host/use-reactive-host-readiness";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import { useProvidersListForClient } from "@/hooks/providers/use-providers-list-query";
import {
  autoJudgeBillingForRun,
  providerRunsItsOwnJudge,
  type AutoJudgeBilling,
} from "@/lib/auto-mode/auto-judge-billing";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const AUTO_JUDGE_GET_PARAMS = {};

/**
 * Which pocket THIS composer's judged approvals would be charged to.
 *
 * Scoped to the composer's run target rather than the app-wide host, like
 * every other composer RPC: the judge runs on the machine the turn runs on, so
 * a composer pinned to another host must disclose that host's judge, not this
 * window's. A `null` target is the FOLLOWING case - the surface owns its
 * placement and resolves to the binding's host, which is exactly what
 * `useHostClientForHostId(null)` hands back a client for.
 *
 * **The host name is read off the CLIENT, never from an app-wide hook.** This
 * used to fall back to `useAddressableHostId()` for the `null` case, which is
 * banned inside a tab (root AGENTS.md: tabs bind a `hostId` for life) and was
 * subscribing every chat composer to the mutable app-wide selection - a
 * value it then discarded, since every caller passes a resolved id. It was
 * also the two-sources shape `useAddressableHostId`'s own doc warns about: the
 * capability gate's fallback named one host while the query ran on another's
 * client. `useReactiveHostReadiness` answers "which host is THIS client
 * addressing", so the following case keeps working - same value, same moment -
 * without anything here naming the selection.
 *
 * `autoJudge.get` is an OPTIONAL capability, so the read is gated on the
 * host advertising it. A host that predates auto mode - and the window before
 * any handshake completes - answers `null`, and the caller renders nothing:
 * the disclosure is additive, and an old host must change nothing.
 *
 * `harnessId` is the harness THIS composer will run, and it is here because the
 * provider's own classifier takes PRECEDENCE over the host-wide selection: a
 * provider set to `autoJudge: "provider"` bypasses Traycer's judge and the
 * policy entirely, so the stored selection describes a call that will never be
 * made. The `providers.list` read shares a key with the one
 * `HarnessModelPicker` already holds for this same client, so on the desktop
 * composer it costs nothing; the mobile toolbar has no picker mounted and is
 * the caller this read actually fetches for - which is the point, since that
 * row makes the same claim.
 */
export function useAutoJudgeBilling(
  hostId: string | null,
  harnessId: GuiHarnessId | null,
): AutoJudgeBilling | null {
  const client = useHostClientForHostId(hostId);
  // Only the FALLBACK moved, and deliberately so: a named target still gates on
  // the id it was handed, exactly as before, so nothing waits on a directory
  // row it did not wait on yesterday. What changed is where the following
  // case's name comes from - the client this hook already resolved, rather
  // than the app-wide selection.
  const followingHostId = useReactiveHostReadiness(client).hostId;
  const resolvedHostId = hostId ?? followingHostId;
  const supported = useHostSupportsMethod(resolvedHostId, "autoJudge.get");
  const query = useHostQuery<HostRpcRegistry, "autoJudge.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "autoJudge.get",
    params: AUTO_JUDGE_GET_PARAMS,
    options: { enabled: supported, refetchOnWindowFocus: false },
  });
  const providersQuery = useProvidersListForClient(client, {
    enabled: supported,
    subscribed: supported,
  });
  const providers = providersQuery.data?.providers;
  const isProviderNative = useMemo(
    () => providerRunsItsOwnJudge({ harnessId, providers }),
    [harnessId, providers],
  );
  const selection = query.data?.selection ?? null;
  const judgeHarnessId = selection === null ? null : selection.harnessId;
  // The host's own verdict that it CANNOT run the judge it has stored
  // (`provider-disabled`, `no-default`, `unsupported-harness`). Optional on the
  // wire, so an older host answers `undefined` and reads as "not blocked".
  const blocked = query.data?.blocked ?? null;
  const loaded = query.data !== undefined;
  return useMemo(
    () =>
      loaded
        ? autoJudgeBillingForRun({
            judgeHarnessId,
            runHarnessId: harnessId,
            isProviderNative,
            blocked,
          })
        : null,
    [loaded, judgeHarnessId, harnessId, isProviderNative, blocked],
  );
}
