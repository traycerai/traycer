import { useCallback } from "react";

export interface DraftAuthorityControl {
  /**
   * Called from every edit handler, before the edit is written to a
   * host-bound row. On a foreign draft it forks synchronously; on an own
   * draft it is a no-op. Nothing is ever shown for either.
   */
  readonly noteEdit: () => void;
}

/**
 * The fork rule, surface-agnostic. A draft is mutated only by the host it
 * was created on; ownership never moves between hosts. When the row a
 * surface is about to edit is foreign - another host's row, or this host's
 * row adopted on a host the surface has since left - the edit FORKS it
 * first: a fresh id of the surface's host, carrying the content, with
 * `supersedes` naming the ancestor so the host retracts the ancestor's
 * cloud row on the fork's first publish. The keystroke then lands on the
 * fork. `isForeign` is read at the edit, never from a render: the row's
 * origin can change between the two (an echo, a placement move), and the
 * decision must match the row as it is when the edit applies.
 *
 * No claim, no chain, no settle: submit and Start on a foreign draft
 * proceed on the row as it is, and the fork rule alone keeps this device's
 * edits off rows it does not own. The editor is never disabled or held.
 */
export function useDraftAuthorityControl(args: {
  readonly isForeign: () => boolean;
  readonly fork: () => void;
}): DraftAuthorityControl {
  const { isForeign, fork } = args;
  const noteEdit = useCallback((): void => {
    if (!isForeign()) return;
    fork();
  }, [fork, isForeign]);
  return { noteEdit };
}
