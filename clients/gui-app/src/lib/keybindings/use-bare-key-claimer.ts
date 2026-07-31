import { useCallback, useEffect, useRef } from "react";
import { claimBareKey } from "@/lib/keybindings/bare-key-owner";

/**
 * A `claimBareKey` factory whose IDENTITY does not move when the handler's
 * does.
 *
 * `claimBareKey` is last-claim-wins, so re-claiming is not free: it moves the
 * claimer to the top of the stack. Handing it a handler built from render
 * state re-claims on every identity change, which for a refresh handler is
 * every time `refreshing` toggles - so an older overlay whose refresh merely
 * FINISHED would jump above a newer overlay that legitimately owns the key.
 * The effect that claims must therefore depend on whether the surface is open,
 * never on what the key does; the handler rides behind a ref and stays current
 * without re-registering.
 *
 * Returns a factory rather than claiming directly because callers gate the
 * claim differently - a plain effect for an overlay that unmounts when it
 * closes, `useActivePaneEffect` for one that stays mounted in an unfocused
 * pane.
 */
export function useBareKeyClaimer(
  key: string,
  handler: (event: KeyboardEvent) => void,
): () => () => void {
  const handlerRef = useRef(handler);
  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);
  return useCallback(
    () => claimBareKey(key, (event) => handlerRef.current(event)),
    [key],
  );
}
