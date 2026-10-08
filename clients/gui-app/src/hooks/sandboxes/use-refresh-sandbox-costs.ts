import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SandboxListResponse } from "@traycer/protocol/host/sandbox-control";
import { useRefreshCreditsOnTraycerTurn } from "@/hooks/auth/use-refresh-credits-on-traycer-turn";
import { useSandboxList } from "@/hooks/sandboxes/use-sandbox-list-query";
import { useAuthService } from "@/lib/host";
import { authQueryKeys, sandboxQueryKeys } from "@/lib/query-keys";

/**
 * What the awake burn depends on: which sandboxes exist, their states and
 * their frozen flags. A string, so the effect below depends on it by VALUE -
 * the list query hands out a new object on every refetch, and keying an
 * effect on that identity would invalidate on every liveness tick.
 */
function burnSignature(list: SandboxListResponse | null | undefined): string {
  if (list === null || list === undefined) return "";
  return list.sandboxes
    .map((s) => `${s.id}:${s.state}:${s.frozen ? "f" : "t"}`)
    .sort()
    .join("|");
}

/**
 * While mounted, keeps the sandbox cost view and the balance it is divided
 * into live, on the pattern of `useRefreshCreditsOnTraycerTurn` (whose own
 * credits refresh this mounts): invalidation on events, never a timer.
 *
 * The events: a Traycer turn completing (it spent credits), and a sandbox
 * changing state or freezing (the burn moved), seen through the sandbox list
 * that the directory's existing liveness tick already refreshes. Both
 * queries otherwise refetch on window focus, like the credits card.
 */
export function useRefreshSandboxCosts(): void {
  useRefreshCreditsOnTraycerTurn();
  const queryClient = useQueryClient();
  const auth = useAuthService();
  const signature = burnSignature(useSandboxList().data);
  const previousRef = useRef<string | null>(null);

  useEffect(() => {
    const previous = previousRef.current;
    previousRef.current = signature;
    // The first answer is the queries' own first fetch, not a change.
    if (previous === null || previous === "" || previous === signature) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: sandboxQueryKeys.costsAll(),
    });
    void queryClient.invalidateQueries({ queryKey: authQueryKeys.user(auth) });
  }, [signature, queryClient, auth]);
}
