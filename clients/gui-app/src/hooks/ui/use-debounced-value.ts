import { useEffect, useState } from "react";

/**
 * Returns `value` delayed by `delayMs`. Each new `value` resets the timer;
 * the returned reference only updates once the input has been stable for
 * the full delay window. Use to gate expensive work (parse, render, fetch)
 * behind "user has paused".
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = window.setTimeout(() => {
      setDebounced(value);
    }, delayMs);
    return () => {
      window.clearTimeout(handle);
    };
  }, [value, delayMs]);
  return debounced;
}
