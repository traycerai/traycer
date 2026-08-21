import { useEffect, useState } from "react";

/**
 * Whole seconds left until `targetMs`, re-rendering once a second and floored
 * at zero. Shared by every sign-in wait that counts toward an absolute
 * instant — a device code's expiry, a link-login poll's next fire — so the
 * surfaces cannot drift apart in rounding or tick cadence.
 */
export function useRemainingSeconds(targetMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return remainingSecondsUntil(targetMs, nowMs);
}

function remainingSecondsUntil(targetMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
}
