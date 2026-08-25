import { useCallback } from "react";

import { useCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

/**
 * Open-autofocus for a popover whose first tabbable descendant is a text field
 * the user did not ask to type in - a cmdk `CommandInput` above a list of
 * choices being the usual shape. On a fine pointer the field takes focus and
 * type-to-filter costs nothing; on a touch pointer it summons a software
 * keyboard over the list the popover was opened to read.
 *
 * Whether a layer may simply decline turns on two questions, and this hook is
 * only correct when both are answered its way:
 *
 * 1. **Does the trigger survive the open?** Declining leaves focus wherever it
 *    was, which is the trigger. For a popover that is the right place - still
 *    mounted, still in the tab order, and what the user just pressed. A layer
 *    whose trigger does NOT survive, a dialog raised from a menu that unmounts
 *    with it, strands focus outside the new focus scope; that one must move
 *    focus to its own content element instead of using this. Guard the
 *    destination BEFORE calling `preventDefault`, so a content element that
 *    has not mounted degrades to Radix's default rather than cancelling with
 *    nowhere to go.
 * 2. **Is the field actually the first tabbable descendant?** If something
 *    harmless precedes it, Radix was never going to focus it, and attaching
 *    this changes nothing while reading as a fix.
 */
export function useDeclineOpenAutoFocusOnCoarsePointer(): (
  event: Event,
) => void {
  const coarsePointer = useCoarsePointer();
  return useCallback(
    (event: Event): void => {
      if (!coarsePointer) return;
      event.preventDefault();
    },
    [coarsePointer],
  );
}
