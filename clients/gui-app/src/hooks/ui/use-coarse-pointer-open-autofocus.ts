import { useCallback, useRef, type RefObject } from "react";

import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

export interface CoarsePointerOpenAutoFocus {
  /** Attach to the popover content, the fallback focus destination. */
  readonly contentRef: RefObject<HTMLDivElement | null>;
  /** Pass to the layer's `onOpenAutoFocus`. */
  readonly onOpenAutoFocus: (event: Event) => void;
}

/**
 * Open-autofocus for a popover whose first tabbable descendant is a text field
 * the user did not ask to type in - a cmdk `CommandInput` above a list of
 * choices being the usual shape. On a fine pointer the field takes focus and
 * type-to-filter costs nothing; on a touch pointer it summons a software
 * keyboard over the list the popover was opened to read.
 *
 * Declining Radix's autofocus does not choose a destination, it keeps the one
 * focus already had - so it is only safe when focus is somewhere. Two things
 * have to hold, and the second is easy to assume:
 *
 * 1. **The trigger survives the open.** For a popover it does: still mounted,
 *    still tabbable, and what the user just pressed. A layer whose trigger
 *    does NOT survive - a dialog raised from a menu that unmounts with it -
 *    cannot use the decline path at all.
 * 2. **Focus actually rests on something.** WebKit does not focus a `button`
 *    on pointer activation, so a tap can open a popover with focus still on
 *    `body`. Cancelling there stands the layer up with focus outside it: no
 *    screen-reader announcement, nothing for the focus scope to hold. That
 *    case moves focus onto the content element instead, which Radix's focus
 *    scope gives `tabIndex={-1}` for exactly this purpose.
 *
 * Fails safe in both directions. With focus resting, declining is enough and
 * no destination is needed. Without it, the content guard runs BEFORE
 * `preventDefault`, so a content element that has not mounted lets Radix's own
 * default run rather than being cancelled with nowhere to go.
 *
 * Only worth attaching where that text field really is the first tabbable
 * descendant. Where something harmless precedes it, Radix was never going to
 * focus it, and attaching this changes nothing while reading as a fix.
 */
export function useCoarsePointerOpenAutoFocus(): CoarsePointerOpenAutoFocus {
  const coarsePointer = useCoarsePointer();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const onOpenAutoFocus = useCallback(
    (event: Event): void => {
      if (!coarsePointer) return;
      // Read before Radix moves anything: this is where the opening gesture
      // left focus. `documentElement` counts as nowhere alongside `body` -
      // that is what a document with no focused element reports in some
      // engines.
      const active = document.activeElement;
      const focusRests =
        active !== null &&
        active !== document.body &&
        active !== document.documentElement;
      if (focusRests) {
        event.preventDefault();
        return;
      }
      const content = contentRef.current;
      if (content === null) return;
      event.preventDefault();
      content.focus();
    },
    [coarsePointer],
  );
  return { contentRef, onOpenAutoFocus };
}
