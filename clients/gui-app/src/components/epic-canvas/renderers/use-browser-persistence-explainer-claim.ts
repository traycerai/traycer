import { useCallback, useEffect, useSyncExternalStore } from "react";

/**
 * The explainer card is shown ONCE, in the first tile that opens (spec §7.2) -
 * not once per tile. With several tiles on a canvas the copy would otherwise
 * repeat, and every copy would raise the same OS prompt. One claim, held by
 * whichever tile mounted first and released when it unmounts, so the card moves
 * to a surviving tile rather than disappearing with its owner.
 *
 * It lives in its own module because both the card and the tile that renders it
 * import it, and a file that exports a component may export nothing else.
 */
let explainerClaimHolder: string | null = null;
const explainerClaimListeners = new Set<() => void>();

function readExplainerClaimHolder(): string | null {
  return explainerClaimHolder;
}

function setExplainerClaimHolder(next: string | null): void {
  explainerClaimHolder = next;
  explainerClaimListeners.forEach((listener) => {
    listener();
  });
}

export function useBrowserPersistenceExplainerClaim(claimId: string): boolean {
  const subscribe = useCallback((listener: () => void) => {
    explainerClaimListeners.add(listener);
    return () => {
      explainerClaimListeners.delete(listener);
    };
  }, []);
  const holder = useSyncExternalStore(
    subscribe,
    readExplainerClaimHolder,
    readExplainerClaimHolder,
  );
  useEffect(() => {
    if (explainerClaimHolder === null) setExplainerClaimHolder(claimId);
    return () => {
      if (explainerClaimHolder !== claimId) return;
      setExplainerClaimHolder(null);
    };
  }, [claimId]);
  return holder === claimId;
}
