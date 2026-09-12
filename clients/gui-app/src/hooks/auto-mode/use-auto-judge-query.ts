import type { UseQueryResult } from "@tanstack/react-query";
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient } from "@/lib/host";
import { useHostQuery } from "@/hooks/host/use-host-query";

// Stable params identity so the host-scoped query key stays referentially
// constant across renders.
const AUTO_JUDGE_GET_PARAMS = {};

/**
 * The harness + model that runs Traycer's judge on this host.
 *
 * Host-scoped: the record lives in `~/.traycer/host/config/auto-judge.json` on
 * whichever host answers, so the query rebinds when the surface's host changes.
 * `selection: null` means unset - the host falls back to the `traycer` harness
 * and the model the server catalog flags as the auto-judge default, which is
 * what makes auto mode work before anyone opens Settings.
 *
 * An OPTIONAL capability. Callers must gate mounting on
 * `useHostSupportsMethod(hostId, "autoJudge.get")`; a host that predates auto
 * mode advertises no handler and the request degrades as unsupported.
 */
export function useAutoJudgeQuery(): UseQueryResult<
  AutoJudgeGetResponse,
  HostRpcError
> {
  const client = useHostClient();
  return useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "autoJudge.get",
    params: AUTO_JUDGE_GET_PARAMS,
    options: { refetchOnWindowFocus: false },
  });
}
