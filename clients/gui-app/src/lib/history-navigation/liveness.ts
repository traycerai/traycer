import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { parseNestedFocusTargetFromHref } from "@/lib/epic-nested-focus-route";
import { hrefPathname } from "@/lib/routes";

/** Conservative liveness predicate for a persisted history entry. */
export function isHistoryEntryDead(href: string): boolean {
  const epicTab = parseEpicTabHref(href);

  // /epics/$epicId/$tabId - a known tab (open or closed) is always alive here, nested target or not.
  // Only a tab that's gone from `tabsById` entirely (deleted, or reassigned to a different epic) is a pruning candidate, handled below.
  if (epicTab !== null) {
    const { epicId, tabId } = epicTab;
    const state = useEpicCanvasStore.getState();
    if (state.tabsById[tabId]?.epicId === epicId) {
      return false;
    }
    const nestedTarget = parseNestedFocusTargetFromHref(href);
    if (nestedTarget !== null) {
      return true;
    }
    const sibling = state.resolveTabIdForEpic(epicId);
    return sibling === null;
  }

  // /draft/$draftId - dead when the draft id is gone. `/draft/new` is kept.
  const segments = parsePathSegments(href);
  if (
    segments.length === 2 &&
    segments[0] === "draft" &&
    segments[1] !== "new"
  ) {
    const draftId = segments[1];
    const exists = useLandingDraftStore
      .getState()
      .drafts.some((draft) => draft.id === draftId);
    return !exists;
  }

  // Unknown / unparseable / every other route shape: keep.
  return false;
}

/** Split an href into its non-empty pathname segments (query/hash stripped). */
function parsePathSegments(href: string): ReadonlyArray<string> {
  return hrefPathname(href)
    .split("/")
    .filter((segment) => segment.length > 0);
}

export interface ParsedEpicTabHref {
  readonly epicId: string;
  readonly tabId: string;
}

/**
 * Parses an `/epics/$epicId/$tabId` href into its route params, or `null` for any other route shape.
 * Shared by liveness pruning and the back/forward skip-eligibility scan (`history-navigation/eligibility.ts`) so both read the same route shape off the same parser.
 */
export function parseEpicTabHref(href: string): ParsedEpicTabHref | null {
  const segments = parsePathSegments(href);
  if (segments.length !== 3 || segments[0] !== "epics") {
    return null;
  }
  return { epicId: segments[1], tabId: segments[2] };
}
