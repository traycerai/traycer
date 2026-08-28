import { useEffect, useState } from "react";

const TERMINAL_FLEET_WARNING_DELAY_MS = 750;

/**
 * The fleet stream deliberately emits a local-only replacement before cloud
 * discovery starts. Delay that expected bootstrap state so it only becomes a
 * warning when remote coverage is genuinely unavailable.
 */
export function useDelayedTerminalFleetWarning(
  incomplete: boolean,
  contextKey: string,
): boolean {
  const [visibleContextKey, setVisibleContextKey] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (!incomplete) {
      const timer = window.setTimeout(() => setVisibleContextKey(null), 0);
      return () => window.clearTimeout(timer);
    }
    const timer = window.setTimeout(
      () => setVisibleContextKey(contextKey),
      TERMINAL_FLEET_WARNING_DELAY_MS,
    );
    return () => window.clearTimeout(timer);
  }, [contextKey, incomplete]);
  return incomplete && visibleContextKey === contextKey;
}
