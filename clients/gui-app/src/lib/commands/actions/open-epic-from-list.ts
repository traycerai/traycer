import type { UseNavigateResult } from "@tanstack/react-router";
import {
  activateTabIntent,
  openEpicFromListIntent,
} from "@/lib/tab-navigation";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import {
  Analytics,
  AnalyticsEvent,
  type AnalyticsSource,
} from "@/lib/analytics";

type NavigateFn = UseNavigateResult<string>;

/** Opens an epic from a home/start-page-style epic list. */
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
  // Replace-in-place is only the right UX when the user is currently sitting on the draft tab.
  // Other call sites (history modal, /epics listing) reuse `EpicsListPanel` while a stale empty draft may still exist in the store from an earlier session - closing it silently off-route would be a surprise.
  if (!currentPathname.startsWith("/draft/")) return null;
  const state = useLandingDraftStore.getState();
  const activeId = state.activeDraftId;
  if (activeId === null) return null;
  const draft = state.drafts.find((entry) => entry.id === activeId);
  if (draft === undefined) return null;
  // "Empty" is now derived from content: no typed text AND no image atoms.
  // An image-only draft is real content, so replacing it in-place (which closes it) would silently drop the image - treat it as non-empty.
  if (!isEmptyLandingDraftContent(draft.content)) return null;
  return draft.id;
}
