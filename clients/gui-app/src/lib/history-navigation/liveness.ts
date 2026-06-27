import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
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
 * - `/epics/$epicId/$tabId` — alive while the exact tab maps to `epicId`; once
 *   that tab is gone, dead ONLY when `resolveTabIdForEpic(epicId)` is null (no
 *   sibling tab). This mirrors the epic route's `beforeLoad`, which redirects a
 *   stale tab to a sibling of the same epic when one exists, so a back step to
 *   it still lands somewhere valid (`src/routes/epics.$epicId.$tabId.tsx`).
 * - `/draft/$draftId` — dead when `draftId` is absent from the landing-draft
 *   store (`src/routes/draft-route-components.tsx` redirects to `/` on the same
 *   condition). `/draft/new` is a distinct route and is always kept.
 *
 * Reads `getState()` at call time so the prune scheduler re-evaluates liveness
 * against the live stores at execution, not at install time.
 */
export function isHistoryEntryDead(href: string): boolean {
  const segments = parsePathSegments(href);

  // /epics/$epicId/$tabId — alive while the exact tab maps to epicId. Once that
  // tab is gone, dead ONLY when the epic has no resolvable tab: the route's
  // `beforeLoad` redirects a stale tab to a sibling of the same epic via
  // `resolveTabIdForEpic`, so a back step there still lands somewhere valid.
  if (segments.length === 3 && segments[0] === "epics") {
    const epicId = segments[1];
    const tabId = segments[2];
    const state = useEpicCanvasStore.getState();
    if (state.tabsById[tabId]?.epicId === epicId) return false;
    return state.resolveTabIdForEpic(epicId) === null;
  }

  // /draft/$draftId — dead when the draft id is gone. `/draft/new` is kept.
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
