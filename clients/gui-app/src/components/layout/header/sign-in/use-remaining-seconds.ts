import { useEffect, useState } from "react";

/**
 * Whole seconds left until `targetMs`, re-rendering once a second and floored
 * at zero. Shared by every sign-in wait that counts toward an absolute
 * instant — a device code's expiry, a link-login poll's next fire — so the
 * surfaces cannot drift apart in rounding or tick cadence.
 *
 * The clock is sampled at mount and then only on this hook's own one-second
 * tick, which is right for ONE target and wrong across a change of target: a
 * new instant subtracted from the previous tick's clock is up to a second
 * stale, and a fresh 3s wait can render as `4s` until the next tick. Callers
 * whose target moves under a mounted component therefore KEY the component on
 * it (see `LinkCodeWaitStatus`), which remounts and re-samples. Resetting from
 * inside is not available: reading the clock during render is impure, and
 * writing state from an effect is the cascading render this hook is small
 * enough to avoid entirely.
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
