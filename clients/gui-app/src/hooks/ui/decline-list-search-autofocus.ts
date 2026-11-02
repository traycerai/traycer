import { isCoarsePointer } from "@/hooks/ui/use-coarse-pointer";

const FIRST_TABBABLE =
  'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';
const LIST_SEARCH =
  'input[cmdk-input],input[type="search"],input[placeholder^="Search"],input[placeholder^="Filter"]';

/**
 * The default open-autofocus of a dialog or popover. On a touch pointer, one
 * whose first tabbable is a search over its own list would summon the keyboard
 * over the list it was opened to read, which on a phone in landscape covers all
 * of it. A field the person opened the surface to fill keeps its focus.
 */
export function declineListSearchAutoFocus(event: Event): void {
  if (!isCoarsePointer()) return;
  const content = event.currentTarget;
  if (!(content instanceof HTMLElement)) return;
  if (content.querySelector(FIRST_TABBABLE)?.matches(LIST_SEARCH) !== true) {
    return;
  }
  event.preventDefault();
  content.focus();
}
