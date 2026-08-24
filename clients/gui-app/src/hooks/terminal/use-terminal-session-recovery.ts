/**
 * Automatic recovery for a terminal/TUI tile whose live session dies while the
 * app is disconnected (e.g. the Traycer Host reaps an idle TUI agent after the
 * overnight WS heartbeat times out). The renderer's transport auto-reconnects,
 * but re-subscribing to the missing session id dead-ends at `status: "lost"`
 * or `"reaped"` with no path back - the only recovery used to be a full app
 * refresh.
 *
 * This hook drives a SCOPED refresh instead: on a `"lost"` or `"reaped"`
 * handle it force-releases the dead session store, waits for a fresh
 * `terminal.list`, and then bumps `recoverNonce`. The owning tile keys its
 * bootstrap subtree on that nonce, so the whole `terminal.list -> create ->
 * resume` bootstrap re-runs - for a TUI agent that re-issues `prepareLaunch`,
 * which resumes the conversation from disk. Waiting for fresh host authority
 * prevents retained query data from remounting a subscriber against the
 * already-dead PTY incarnation.
 *
 * Auto-recovery is capped at {@link MAX_AUTO_RECOVERIES} consecutive attempts so
 * a session that keeps dying can't loop forever; past the cap the tile shows a
 * manual Reconnect affordance. A session that reaches a healthy state resets the
 * budget.
 */
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { hostQueryKeys } from "@/lib/query-keys";
import { getTerminalSessionRegistry } from "@/lib/registries/terminal-session-registry";

const MAX_AUTO_RECOVERIES = 3;

export interface TerminalSessionRecovery {
  /** Bumped on each recovery; the tile keys its bootstrap subtree on this to remount. */
  readonly recoverNonce: number;
  /** True once auto-recovery has exhausted its budget - the tile then offers a manual retry. */
  readonly recoveryExhausted: boolean;
  /** The live tile reports a stream handle dead-ended (`"lost"`/`"reaped"`). */
  readonly onSessionLost: () => void;
  /** The live tile reports the session is healthy again, resetting the auto budget. */
  readonly onSessionHealthy: () => void;
  /** User-initiated reconnect from the lost overlay; bypasses the auto cap. */
  readonly onManualReconnect: () => void;
}

export function useTerminalSessionRecovery(input: {
  readonly hostId: string;
  readonly instanceId: string;
  readonly onRecoveryExhausted: () => void;
}): TerminalSessionRecovery {
  const { hostId, instanceId, onRecoveryExhausted } = input;
  const queryClient = useQueryClient();
  const autoAttemptsRef = useRef(0);
  const recoveryExhaustionReportedRef = useRef(false);
  const recoveryInFlightRef = useRef(false);
  const [recoverNonce, setRecoverNonce] = useState(0);
  const [recoveryExhausted, setRecoveryExhausted] = useState(false);

  const doRecover = useCallback((): boolean => {
    if (recoveryInFlightRef.current) return false;
    recoveryInFlightRef.current = true;
    // Drop the dead, warm-kept store so the remounted bootstrap acquires a fresh
    // one instead of re-resolving the lost handle. Do not remount until the
    // active host-session list refetch has settled: TanStack retains old data
    // while fetching, and that stale `running` row would otherwise enable a
    // premature subscription to the same missing PTY.
    getTerminalSessionRegistry().forceRelease(instanceId);
    void queryClient
      .invalidateQueries({
        queryKey: hostQueryKeys.methodScope(hostId, "terminal.list"),
      })
      .then(() => {
        setRecoverNonce((n) => n + 1);
      })
      .finally(() => {
        recoveryInFlightRef.current = false;
      });
    return true;
  }, [instanceId, hostId, queryClient]);

  const onSessionLost = useCallback(() => {
    if (recoveryInFlightRef.current) return;
    if (autoAttemptsRef.current >= MAX_AUTO_RECOVERIES) {
      setRecoveryExhausted(true);
      if (!recoveryExhaustionReportedRef.current) {
        recoveryExhaustionReportedRef.current = true;
        onRecoveryExhausted();
      }
      return;
    }
    if (doRecover()) autoAttemptsRef.current += 1;
  }, [doRecover, onRecoveryExhausted]);

  const onSessionHealthy = useCallback(() => {
    autoAttemptsRef.current = 0;
    recoveryExhaustionReportedRef.current = false;
    setRecoveryExhausted(false);
  }, []);

  const onManualReconnect = useCallback(() => {
    autoAttemptsRef.current = 0;
    recoveryExhaustionReportedRef.current = false;
    setRecoveryExhausted(false);
    doRecover();
  }, [doRecover]);

  return {
    recoverNonce,
    recoveryExhausted,
    onSessionLost,
    onSessionHealthy,
    onManualReconnect,
  };
}
