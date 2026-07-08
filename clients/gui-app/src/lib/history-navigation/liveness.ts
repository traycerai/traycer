import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  parseNestedFocusTargetFromHref,
  resolveNestedFocusTarget,
} from "@/lib/epic-nested-focus-route";
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
 * - `/epics/$epicId/$tabId` — top-level entries without nested pane/tile params
 *   are alive while the exact tab maps to `epicId`; once that tab is gone, dead
 *   ONLY when `resolveTabIdForEpic(epicId)` is null (no sibling tab). Nested
 *   pane/tile entries are exact session-local targets: they are alive only while
 *   the original tab maps to the epic and the target resolves in that tab's
 *   canvas. Sibling tabs must not salvage nested targets.
 * - `/draft/$draftId` — dead when `draftId` is absent from the landing-draft
 *   store (`src/routes/draft-route-components.tsx` redirects to `/` on the same
 *   condition). `/draft/new` is a distinct route and is always kept.
 *
 * Reads `getState()` at call time so the prune scheduler re-evaluates liveness
 * against the live stores at execution, not at install time.
 */
export function isHistoryEntryDead(href: string): boolean {
  const segments = parsePathSegments(href);

  // /epics/$epicId/$tabId — nested pane/tile targets are exact to this tab's
  // canvas. Only top-level entries without nested params keep the legacy
  // sibling-salvage behavior.
  if (segments.length === 3 && segments[0] === "epics") {
    const epicId = segments[1];
    const tabId = segments[2];
    const nestedTarget = parseNestedFocusTargetFromHref(href);
    const state = useEpicCanvasStore.getState();
    if (state.tabsById[tabId]?.epicId === epicId) {
      if (nestedTarget === null) {
        return false;
      }
      const canvas = state.canvasByTabId[tabId];
      if (canvas === undefined) {
        return true;
      }
      const resolved = resolveNestedFocusTarget(canvas, nestedTarget);
      return resolved === null;
    }
    if (nestedTarget !== null) {
      return true;
    }
    const sibling = state.resolveTabIdForEpic(epicId);
    return sibling === null;
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
