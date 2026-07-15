import type { UseNavigateResult } from "@tanstack/react-router";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { existingEpicTabIntent } from "@/lib/tab-navigation/intents";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import { extractPlainTextFromComposerJSONContent } from "@/lib/composer/tiptap-json-content";
import { containsImageAtoms } from "@/lib/composer/image-atoms";
import { useTabsStore } from "@/stores/tabs/store";
import type { TabRef } from "@/stores/tabs/types";
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
  const replacedDraft = replaceEmptyDraftWithEpicInStrip(
    epicId,
    currentPathname,
    options.title,
  );
  navigateToTabIntent(
    navigate,
    existingEpicTabIntent({
      epicId,
      tabId: replacedDraft.tabId,
      focus: undefined,
    }),
  );
}

interface ReplaceResult {
  readonly tabId: string;
}

/**
 * Coordinates the canvas/draft/strip mutations needed to swap an empty
 * draft tab for an epic tab AT THE DRAFT'S STRIP POSITION. The naive
 * sequence (close draft → resolve epic) lets reconciliation drop the
 * draft and append the epic at the end, which moves the new tab from
 * (say) position 2 to position 10. This helper captures the draft index
 * up front, lets the source-store mutations happen (each one fires
 * reconciliation), then rewrites `stripOrder` once so the epic ref sits
 * exactly where the draft ref was.
 *
 * Returns the resolved epic tab id so the caller can dispatch the
 * activate-then-navigate intent.
 */
function replaceEmptyDraftWithEpicInStrip(
  epicId: string,
  currentPathname: string,
  title: string | undefined,
): ReplaceResult {
  const emptyDraft = readActiveEmptyDraft(currentPathname);
  const stripOrderBefore = useTabsStore.getState().stripOrder;
  const draftIndex =
    emptyDraft === null
      ? -1
      : stripOrderBefore.findIndex(
          (ref) => ref.kind === "draft" && ref.id === emptyDraft.id,
        );

  const canvasOrderBefore = useEpicCanvasStore.getState().openTabOrder;
  const tabId = useEpicCanvasStore
    .getState()
    .resolveTargetTabForEpic(epicId, title);
  const epicWasNewlyOpened = !canvasOrderBefore.includes(tabId);

  if (emptyDraft === null || draftIndex === -1) {
    return { tabId };
  }

  useLandingDraftStore.getState().closeDraft(emptyDraft.id);

  if (epicWasNewlyOpened) {
    moveEpicRefToIndex(tabId, draftIndex);
  }
  return { tabId };
}

interface ActiveEmptyDraft {
  readonly id: string;
}

function readActiveEmptyDraft(
  currentPathname: string,
): ActiveEmptyDraft | null {
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
  return { id: draft.id };
}

function moveEpicRefToIndex(tabId: string, targetIndex: number): void {
  const stripOrder = useTabsStore.getState().stripOrder;
  const epicRef: TabRef = { kind: "epic", id: tabId };
  const filtered = stripOrder.filter(
    (ref) => !(ref.kind === "epic" && ref.id === tabId),
  );
  const clamped = Math.max(0, Math.min(targetIndex, filtered.length));
  const next: ReadonlyArray<TabRef> = [
    ...filtered.slice(0, clamped),
    epicRef,
    ...filtered.slice(clamped),
  ];
  useTabsStore.getState().setStripOrder(next);
}
