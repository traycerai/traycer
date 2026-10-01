import type { UseQueryResult } from "@tanstack/react-query";
import type { AutoJudgeGetResponse } from "@traycer/protocol/host/auto-mode/contracts";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { useHostClient, type HostRpcRegistry } from "@/lib/host";
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
 * what makes auto mode work before anyone opens Settings. New hosts report
 * that resolution in `effective` and known configuration blockers in `blocked`.
 *
 * An OPTIONAL capability. Callers must gate mounting on
 * `useHostSupportsMethod(hostId, "autoJudge.get")`; a host that predates auto
 * mode advertises no handler and the request degrades as unsupported.
 *
 * Settings' reader for the SELECTION, which it shows whatever its age. Its
 * `isStale` also turns true after a minute, so it cannot tell an invalidated
 * verdict from an old one: the verdict comes from
 * {@link useAutoJudgeVerdict}.
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
    // Recheck on returning from Providers even when the selection cache is
    // fresh: enablement and the catalog default can change independently.
    options: { refetchOnWindowFocus: false, refetchOnMount: "always" },
  });
}

/**
 * The record while its VERDICT is current, else `undefined`: nothing has
 * answered yet, or the answer held was invalidated since. The reader for the
 * record's verdict half, `effective` and `blocked`, which every surface naming
 * the account that pays takes from here: the composer's billing line
 * (`useAutoJudgeBilling`) and Settings' Judge tab ({@link useAutoJudgeVerdict}).
 *
 * The verdict is only as current as the facts the host computed it from.
 * Under Automatic, `effective` is derived per read from the Traycer harness
 * row, and the harness catalog invalidates this read when that row moves
 * (`useGuiHarnessesQueryForClient`); a save's echo is written and invalidated
 * in the same tick (`useAutoJudgeSetMutation`). An invalidated verdict answers
 * a question the host would now answer differently, so it is withheld until
 * the refetch lands - and stays withheld if that refetch fails, since the
 * answer is still unknown.
 *
 * `staleTime: Infinity` is what makes `isStale` mean exactly "no answer, or
 * invalidated since" rather than "older than a minute" - and it would also
 * stop a mount from ever re-asking, so `refetchOnMount: "always"` puts that
 * back. It puts back MORE than the app's 60-second window would: every mount
 * re-asks. That is deliberate - a selection saved in another window reaches
 * this one no other way, and a mount is rare next to a render.
 *
 * It shares {@link useAutoJudgeQuery}'s cache entry, so a surface can mount
 * both - Settings keeps that reader for the SELECTION, shown whatever its age
 * because the picker hands off to it - and one fetch serves the two.
 *
 * It returns the record, not the query, so the answer is a HOOK result: the
 * React Compiler treats one as frozen, and the composer memoises on it
 * (`runJudgeTarget`). A plain function's result it treats as mutable, and
 * gives that memoisation up.
 */
export function useAutoJudgeVerdictForClient(
  client: HostClient<HostRpcRegistry> | null,
  enabled: boolean,
): AutoJudgeGetResponse | undefined {
  const query = useHostQuery({
    cacheKeyIdentity: undefined,
    client,
    method: "autoJudge.get",
    params: AUTO_JUDGE_GET_PARAMS,
    options: {
      enabled,
      staleTime: Infinity,
      refetchOnMount: "always",
      refetchOnWindowFocus: false,
    },
  });
  return query.isStale ? undefined : query.data;
}

/**
 * Settings' reader for the verdict, on this subtree's host, beside
 * {@link useAutoJudgeQuery} for the selection.
 */
export function useAutoJudgeVerdict(): AutoJudgeGetResponse | undefined {
  return useAutoJudgeVerdictForClient(useHostClient(), true);
}
