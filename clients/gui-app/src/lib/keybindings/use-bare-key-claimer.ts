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
 * without re-registering. The stable identity is load-bearing a second time:
 * `claimBareKey` releases by `lastIndexOf(handler)`, so a handler whose
 * identity moved between claim and release would not be the one removed.
 *
 * NOT `useEffectEvent`, which is this codebase's usual answer to "stable
 * identity, latest closure". An effect event may only be CALLED from an effect
 * of the same component, and `react-hooks/rules-of-hooks` enforces that. This
 * handler is called by `bare-key-owner`'s window listener, from a module-level
 * stack the component does not own - so it has to leave the component, which
 * an effect event may not do. The ref is the correct tool for that shape.
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
