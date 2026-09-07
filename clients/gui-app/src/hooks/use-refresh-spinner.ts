import { useCallback, useEffect, useRef, useState } from "react";

const MIN_VISIBLE_REFRESH_MS = 350;

type TimerRef = {
  current: number | null;
};

type TimerRunRef = {
  current: number | null;
};

function clearTimer(timerRef: TimerRef, timerRunRef: TimerRunRef): void {
  if (timerRef.current === null) return;
  window.clearTimeout(timerRef.current);
  timerRef.current = null;
  timerRunRef.current = null;
}

function clearTimerForRun(
  timerRef: TimerRef,
  timerRunRef: TimerRunRef,
  runId: number,
): void {
  if (timerRunRef.current !== runId) return;
  clearTimer(timerRef, timerRunRef);
}

/**
 * Spinner until the promise settles after a visible minimum, or `timeoutMs` as a hung-refetch cap. A run id so a slow earlier run cannot clear a newer spinner.
 */
export function useRefreshSpinner(args: {
  readonly onRefresh: () => Promise<void>;
  readonly externalRefreshing: boolean;
  readonly timeoutMs: number;
}): { readonly refreshing: boolean; readonly trigger: () => void } {
  const { onRefresh, externalRefreshing, timeoutMs } = args;
  const [localRefreshing, setLocalRefreshing] = useState(false);
  const refreshing = localRefreshing || externalRefreshing;
  const runId = useRef(0);
  const timeoutTimerRef = useRef<number | null>(null);
  const timeoutTimerRunRef = useRef<number | null>(null);
  const minimumVisibleTimerRef = useRef<number | null>(null);
  const minimumVisibleTimerRunRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer(timeoutTimerRef, timeoutTimerRunRef);
      clearTimer(minimumVisibleTimerRef, minimumVisibleTimerRunRef);
    };
  }, []);

  const trigger = useCallback(() => {
    if (refreshing) return;
    const id = (runId.current += 1);
    const startedAtMs = performance.now();
    setLocalRefreshing(true);
    const stop = () => {
      if (mountedRef.current && runId.current === id) {
        setLocalRefreshing(false);
      }
    };
    clearTimer(timeoutTimerRef, timeoutTimerRunRef);
    clearTimer(minimumVisibleTimerRef, minimumVisibleTimerRunRef);
    timeoutTimerRunRef.current = id;
    timeoutTimerRef.current = window.setTimeout(() => {
      if (timeoutTimerRunRef.current === id) {
        timeoutTimerRef.current = null;
        timeoutTimerRunRef.current = null;
      }
      stop();
    }, timeoutMs);
    void onRefresh()
      .catch(() => {
        // Refresh errors surface through the query/mutation layer; here we only
        // release the spinner and avoid an unhandled rejection.
      })
      .finally(() => {
        clearTimerForRun(timeoutTimerRef, timeoutTimerRunRef, id);
        if (!mountedRef.current || runId.current !== id) return;
        const remainingMs =
          MIN_VISIBLE_REFRESH_MS - (performance.now() - startedAtMs);
        if (remainingMs <= 0) {
          stop();
          return;
        }
        minimumVisibleTimerRunRef.current = id;
        minimumVisibleTimerRef.current = window.setTimeout(() => {
          if (minimumVisibleTimerRunRef.current === id) {
            minimumVisibleTimerRef.current = null;
            minimumVisibleTimerRunRef.current = null;
          }
          stop();
        }, remainingMs);
      });
  }, [onRefresh, refreshing, timeoutMs]);

  return { refreshing, trigger };
}
