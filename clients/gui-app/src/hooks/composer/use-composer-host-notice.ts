import { useCallback, useState } from "react";
import type { ComposerHostNoticeState } from "@/components/home/composer/composer-host-notice";

interface ComposerHostNoticeControl {
  /** The notice to render, or null when none applies to the current host. */
  readonly notice: ComposerHostNoticeState | null;
  /** Raise a notice for the surface's CURRENT placement, or clear with null. */
  readonly raise: (notice: ComposerHostNoticeState | null) => void;
  readonly dismiss: () => void;
}

/**
 * The composer's §54 refusal slot, retired whenever the placement moves.
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
 * Cleared during render (React's documented "adjusting state when props
 * change"), like `useWindowNarration`'s served latch: an effect would trip
 * `react-hooks/set-state-in-effect`, and it would also paint the stale alert
 * for one commit before removing it.
 */
export function useComposerHostNotice(
  resolvedHostId: string | null,
): ComposerHostNoticeControl {
  const [raised, setRaised] = useState<ComposerHostNoticeState | null>(null);
  const [raisedFor, setRaisedFor] = useState<string | null>(resolvedHostId);
  if (raisedFor !== resolvedHostId) {
    setRaisedFor(resolvedHostId);
    if (raised !== null) setRaised(null);
  }
  const raise = useCallback((notice: ComposerHostNoticeState | null): void => {
    setRaised(notice);
  }, []);
  const dismiss = useCallback((): void => {
    setRaised(null);
  }, []);
  return { notice: raised, raise, dismiss };
}
