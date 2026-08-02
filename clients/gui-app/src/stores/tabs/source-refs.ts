import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The canonical set of refs a strip layout may reference: every open Epic tab
 * in canvas order, then every landing draft.
 *
 * Defined once on purpose. Reconciliation (the command coordinator) and
 * hydration/sanitize (desktop persistence) have to agree on exactly what counts
 * as a source ref; when each kept its own copy, a new source kind or a changed
 * filter could reach one side only and silently desync placement from
 * hydration.
 */
export function tabSourceRefs(): ReadonlyArray<TabRef> {
  const canvas = useEpicCanvasStore.getState();
  const epics = canvas.openTabOrder.flatMap<TabRef>((id) =>
    canvas.tabsById[id] === undefined ? [] : [{ kind: "epic", id }],
  );
  const drafts = useLandingDraftStore
    .getState()
    .drafts.map<TabRef>((draft) => ({ kind: "draft", id: draft.id }));
  return [...epics, ...drafts];
}
