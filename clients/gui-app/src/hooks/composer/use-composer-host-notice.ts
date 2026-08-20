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
 * The composer's §54 refusal slot, stamped with the placement it refused.
 *
 * A refusal is a statement ABOUT A HOST - "the client this create would go out
 * on no longer addresses the host the chip is showing" - so it stops being
 * true the moment the surface resolves somewhere else. Both ways that happens
 * retire it: a derivation move under a following composer (G4), and the
 * picker writing a new pin. Neither is a special case here, because the
 * premise travels WITH the value and staleness is decided at render.
 *
 * Deliberately not an effect that clears on host change. Beyond tripping
 * `react-hooks/set-state-in-effect`, a clear-on-change effect renders the
 * stale alert for one commit before removing it, and it has to enumerate the
 * triggers - the enumeration being exactly what a targeted fix gets wrong when
 * a third way to re-point a surface is added later.
 */
export function useComposerHostNotice(
  resolvedHostId: string | null,
): ComposerHostNoticeControl {
  const [raised, setRaised] = useState<{
    readonly notice: ComposerHostNoticeState;
    readonly hostId: string | null;
  } | null>(null);
  const raise = useCallback(
    (notice: ComposerHostNoticeState | null): void => {
      setRaised(notice === null ? null : { notice, hostId: resolvedHostId });
    },
    [resolvedHostId],
  );
  const dismiss = useCallback((): void => {
    setRaised(null);
  }, []);
  return {
    notice:
      raised !== null && raised.hostId === resolvedHostId
        ? raised.notice
        : null,
    raise,
    dismiss,
  };
}
