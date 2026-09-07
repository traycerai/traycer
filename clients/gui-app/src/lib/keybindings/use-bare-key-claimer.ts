import { useCallback, useLayoutEffect, useRef } from "react";
import { claimBareKey } from "@/lib/keybindings/bare-key-owner";

/**
 * Stable `claimBareKey` identity: the handler rides a ref so refresh-state changes do not re-claim (last-claim-wins).
 * Hand-off is a layout effect because the window listener is outside React; not `useEffectEvent` (handler leaves the component).
 */
export function useBareKeyClaimer(
  key: string,
  handler: (event: KeyboardEvent) => void,
): () => () => void {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback(
    () => claimBareKey(key, (event) => handlerRef.current(event)),
    [key],
  );
}
