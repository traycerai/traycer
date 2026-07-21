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
 * Returns `true` (entry is dead → prunable) when either its source is gone or
 * its pathname cannot be a persistent app route. This makes the restored
 * stack safe before it is navigable: Back never feeds an unknown/dead target
 * into T3's materializing external-Epic branch.
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
  const pathname = hrefPathname(href);
  const segments = parsePathSegments(pathname);
  if (!isKnownPersistentRoute(pathname, segments)) return true;

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

  // The remaining known persistent route shapes (`/`, onboarding, Epics
  // index, and Settings) have no source-owned identity to validate.
  return false;
}

/** Split an href into its non-empty pathname segments (query/hash stripped). */
function parsePathSegments(pathname: string): ReadonlyArray<string> {
  return pathname.split("/").filter((segment) => segment.length > 0);
}

const SETTINGS_SEGMENTS = new Set([
  "agents",
  "appearance",
  "diagnostics",
  "general",
  "host",
  "keybindings",
  "notifications",
  "providers",
  "service",
  "shell",
  "worktrees",
]);

function isKnownPersistentRoute(
  pathname: string,
  segments: ReadonlyArray<string>,
): boolean {
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return false;
  if (segments.length === 0) return pathname === "/";
  if (segments.length === 1) {
    return (
      segments[0] === "onboarding" ||
      segments[0] === "epics" ||
      segments[0] === "settings"
    );
  }
  if (segments[0] === "epics") return segments.length === 3;
  if (segments[0] === "draft") return segments.length === 2;
  return (
    segments[0] === "settings" &&
    segments.length === 2 &&
    SETTINGS_SEGMENTS.has(segments[1])
  );
}
