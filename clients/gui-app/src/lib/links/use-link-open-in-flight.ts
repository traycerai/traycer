import { useCallback, useRef, useState } from "react";
import type { LinkKind } from "@/lib/links/link-kind";
import { useOpenLink, type LinkClickEvent } from "@/lib/links/open-link";

export interface LinkOpenInFlight {
  /** True while an OS handoff is outstanding - drives `disabled` / spinners. */
  readonly pending: boolean;
  readonly open: (
    url: string,
    kind: LinkKind,
    event: LinkClickEvent | null,
  ) => void;
}

/**
 * {@link useOpenLink} with the one-at-a-time guard the bridge mutation used to
 * provide (R10, R12): a second click landing while the first handoff is still
 * in flight is dropped, because each call fires a fresh RunnerHost request and
 * a double click would otherwise open two OS tabs.
 *
 * The in-app path resolves immediately, so the guard is effectively invisible
 * there - which is right: `openBrowserUrl` already dedupes by page.
 */
export function useLinkOpenInFlight(): LinkOpenInFlight {
  const openLink = useOpenLink();
  const [pending, setPending] = useState<boolean>(false);
  const inFlight = useRef<boolean>(false);

  const open = useCallback(
    (url: string, kind: LinkKind, event: LinkClickEvent | null): void => {
      if (inFlight.current) return;
      inFlight.current = true;
      setPending(true);
      const settle = (): void => {
        inFlight.current = false;
        setPending(false);
      };
      // `then(settle, settle)` rather than `finally`: it also HANDLES the
      // rejection, so nothing floats (the failure toast is the seam's).
      void openLink(url, kind, event).then(settle, settle);
    },
    [openLink],
  );

  return { pending, open };
}
