import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { parseNestedFocusTargetFromHref } from "@/lib/epic-nested-focus-route";
import { hrefPathname } from "@/lib/routes";

/**
 * Conservative liveness predicate for a persisted history entry.
 *
 * Returns `true` (entry is dead → prunable) ONLY when a backing store can prove
 * the entry's source is gone. Everything else is KEPT, including `/`,
 * `/onboarding`, `/draft/new`, `/epics`, `/settings*`, overlay routes, and any
 * unknown / unparseable href. This is the destroy-only-what-a-store-proves-dead
 * rule from the tech plan (§3.2): pruning must never make valid back/forward
 * targets disappear.
 *
 * Two route shapes are prunable, read from the SAME stores the route
 * `beforeLoad` / committed-effect guards consult:
 *
 * - `/epics/$epicId/$tabId` — alive as long as the tab maps to `epicId`,
 *   regardless of whether it's open or closed and regardless of whether a
 *   nested pane/tile target resolves: a closed Task is handled by
 *   back/forward skip-eligibility (not pruning) so it becomes reachable again
 *   on reopen, and an unresolvable nested target under an open Task is the
 *   preview-reopen case, not dead. Once the tab is gone entirely, dead ONLY
 *   when `resolveTabIdForEpic(epicId)` finds no sibling tab (top-level
 *   entries) - a nested target never salvages onto a sibling.
 * - `/draft/$draftId` — dead when `draftId` is absent from the landing-draft
 *   store (`src/routes/draft-route-components.tsx` redirects to `/` on the same
 *   condition). `/draft/new` is a distinct route and is always kept.
 *
 * Reads `getState()` at call time so the prune scheduler re-evaluates liveness
 * against the live stores at execution, not at install time.
 */
export function isHistoryEntryDead(href: string): boolean {
  const epicTab = parseEpicTabHref(href);

  // /epics/$epicId/$tabId — a known tab (open or closed) is always alive
  // here, nested target or not. Only a tab that's gone from `tabsById`
  // entirely (deleted, or reassigned to a different epic) is a pruning
  // candidate, handled below.
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

  // /draft/$draftId — dead when the draft id is gone. `/draft/new` is kept.
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
 * Parses an `/epics/$epicId/$tabId` href into its route params, or `null` for
 * any other route shape. Shared by liveness pruning and the back/forward
 * skip-eligibility scan (`history-navigation/eligibility.ts`) so both read the
 * same route shape off the same parser.
 */
export function parseEpicTabHref(href: string): ParsedEpicTabHref | null {
  const segments = parsePathSegments(href);
  if (segments.length !== 3 || segments[0] !== "epics") {
    return null;
  }
  return { epicId: segments[1], tabId: segments[2] };
}
