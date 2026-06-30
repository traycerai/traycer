import { useEffect, useState } from "react";

export function useRemainingDeviceSeconds(expiresAtMs: number): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(interval);
    };
  }, []);

  return remainingSecondsUntil(expiresAtMs, nowMs);
}

function remainingSecondsUntil(expiresAtMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((expiresAtMs - nowMs) / 1000));
}
