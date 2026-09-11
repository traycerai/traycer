import { useMemo } from "react";
import type { HostRpcRegistry } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useHostSupportsMethod } from "@/hooks/host/use-host-supports-method";
import {
  autoJudgeBillingFor,
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
 * `autoJudge.get` is an OPTIONAL capability, so the read is gated on the
 * host advertising it. A host that predates auto mode - and the window before
 * any handshake completes - answers `null`, and the caller renders nothing:
 * the disclosure is additive, and an old host must change nothing.
 */
export function useAutoJudgeBilling(
  hostId: string | null,
): AutoJudgeBilling | null {
  const bindingHostId = useAddressableHostId();
  const resolvedHostId = hostId ?? bindingHostId;
  const client = useHostClientForHostId(hostId);
  const supported = useHostSupportsMethod(resolvedHostId, "autoJudge.get");
  const query = useHostQuery<HostRpcRegistry, "autoJudge.get">({
    cacheKeyIdentity: undefined,
    client,
    method: "autoJudge.get",
    params: AUTO_JUDGE_GET_PARAMS,
    options: { enabled: supported, refetchOnWindowFocus: false },
  });
  const selection = query.data?.selection ?? null;
  const judgeHarnessId = selection === null ? null : selection.harnessId;
  const loaded = query.data !== undefined;
  return useMemo(
    () => (loaded ? autoJudgeBillingFor(judgeHarnessId) : null),
    [loaded, judgeHarnessId],
  );
}
