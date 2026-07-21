import type { UseNavigateResult } from "@tanstack/react-router";
import {
  activateTabIntent,
  openEpicFromListIntent,
} from "@/lib/tab-navigation";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";

type NavigateFn = UseNavigateResult<string>;

/**
 * Opens an epic from a home/start-page-style epic list.
 *
 * When the user is currently sitting on a draft tab whose content is empty,
 * the epic REPLACES that draft tab in-place - same strip position, no
 * trailing empty draft, no flash of the epic at the strip's end. Drafts
 * with typed text or attached images are preserved and the epic opens as a
 * new tab via the standard append-at-end flow.
 *
 * Resolution/creation of the epic (and the empty-draft swap) is deferred to the
 * navigation controller, which captures the pre-command selection snapshot
 * FIRST. That way a rejected navigation rolls back to the tab the user actually
 * started on, not the just-opened epic. This helper only decides WHICH empty
 * draft (if any) is eligible to be replaced.
 *
 * Centralised here so additional epic-open entry points (command palette,
 * recent-epic menu, deep links) can adopt the same UX by calling this
 * helper instead of duplicating the empty-draft check.
 */
export function openEpicFromList(
  navigate: NavigateFn,
  epicId: string,
  currentPathname: string,
  options: {
    readonly title: string | undefined;
    readonly source: AnalyticsSource;
  },
): void {
  Analytics.getInstance().track(AnalyticsEvent.TaskOpened, {
    source: options.source,
  });
  activateTabIntent(
    navigate,
    openEpicFromListIntent({
      epicId,
      focus: undefined,
      name: options.title,
      replaceEmptyDraftId: readActiveEmptyDraftId(currentPathname),
    }),
    undefined,
  );
}

function readActiveEmptyDraftId(currentPathname: string): string | null {
  // Replace-in-place is only the right UX when the user is currently
  // sitting on the draft tab. Other call sites (history modal, /epics
  // listing) reuse `EpicsListPanel` while a stale empty draft may still
  // exist in the store from an earlier session - closing it silently
  // off-route would be a surprise. The pathname comes from the caller so
  // it reflects the TanStack-router-tracked location (not `window.location`,
  // which lags one microtask behind `pushState`/`replaceState`).
  if (!currentPathname.startsWith("/draft/")) return null;
  const state = useLandingDraftStore.getState();
  const activeId = state.activeDraftId;
  if (activeId === null) return null;
  const draft = state.drafts.find((entry) => entry.id === activeId);
  if (draft === undefined) return null;
  // "Empty" is now derived from content: no typed text AND no image atoms. An
  // image-only draft is real content, so replacing it in-place (which closes it)
  // would silently drop the image - treat it as non-empty.
  if (
    extractPlainTextFromComposerJSONContent(draft.content).trim().length > 0
  ) {
    return null;
  }
  if (containsImageAtoms(draft.content)) return null;
  return draft.id;
}
