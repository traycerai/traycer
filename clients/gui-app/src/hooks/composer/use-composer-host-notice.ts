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
 * Composer refusal about a host; retire it when `resolvedHostId` changes, including A→B→A.
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
