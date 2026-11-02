import { useCallback, useState } from "react";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";

interface ComposerHostNoticeControl {
  /** The notice to render, or null when none applies to the current host. */
  readonly notice: ComposerHostNoticeState | null;
  /** Raise a notice for the surface's CURRENT placement, or clear with null. */
  readonly raise: (notice: ComposerHostNoticeState | null) => void;
  /**
   * Send was refused for what the composer holds now (the agent picked, the
   * sandbox's credits): from here on the slot shows `sendRefusal` as each
   * render reads it, until a raise or a dismiss.
   */
  readonly raiseSendRefusal: () => void;
  readonly dismiss: () => void;
}

/**
 * The composer's placement refusal slot, retired whenever the placement moves.
 *
 * A refusal is a statement ABOUT A HOST - "the client this create would go out
 * on no longer addresses the host the chip is showing" - so it stops being
 * true the moment the surface resolves somewhere else. Every way that happens
 * retires it: a derivation move under a following composer (G4), the picker
 * writing a new pin, a pinned host dying and the surface auto-following. None
 * is a special case here, because the trigger is the RESOLVED HOST CHANGING
 * rather than any of the routes that change it - the enumeration being exactly
 * what a targeted fix gets wrong when a fourth route is added later.
 *
 * RETIRED, NOT HIDDEN, and the distinction is the whole reason this is state
 * and not a comparison. A pin is sticky (`AGENTS.md`: a surface whose pinned
 * host dies auto-follows and RETURNS when it is usable again), so A → B → A is
 * an ordinary round trip, not a corner. Merely holding the refusal beside the
 * host it was raised for and rendering it while they match would resurrect a
 * stale alert on the way back, with no submit in between and nothing on screen
 * to explain it.
 *
 * A refusal about what the composer HOLDS - the agent picked, which sandboxes
 * may not run - is a different statement: the person answers it by changing
 * the pick, not the host. Raised with `raiseSendRefusal`, it is never a stored
 * copy: the slot shows `sendRefusal`, which the caller derives on every render
 * from the same gates Send asked, so it clears the moment the pick or the
 * placement can run and names the new agent when it still can't. A host move
 * does not retire it, since that is one of the changes it follows.
 *
 * Cleared during render (React's documented "adjusting state when props
 * change"), like `useWindowNarration`'s served latch: an effect would trip
 * `react-hooks/set-state-in-effect`, and it would also paint the stale alert
 * for one commit before removing it.
 */
export function useComposerHostNotice(
  resolvedHostId: string | null,
  sendRefusal: ComposerHostNoticeState | null,
): ComposerHostNoticeControl {
  const [raised, setRaised] = useState<ComposerHostNoticeState | null>(null);
  const [raisedFor, setRaisedFor] = useState<string | null>(resolvedHostId);
  const [sendRefused, setSendRefused] = useState(false);
  if (raisedFor !== resolvedHostId) {
    setRaisedFor(resolvedHostId);
    if (raised !== null) setRaised(null);
  }
  const raise = useCallback((notice: ComposerHostNoticeState | null): void => {
    setSendRefused(false);
    setRaised(notice);
  }, []);
  const raiseSendRefusal = useCallback((): void => {
    setRaised(null);
    setSendRefused(true);
  }, []);
  const dismiss = useCallback((): void => {
    setSendRefused(false);
    setRaised(null);
  }, []);
  return {
    notice: sendRefused ? sendRefusal : raised,
    raise,
    raiseSendRefusal,
    dismiss,
  };
}
