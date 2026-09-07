import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import type { TabRef } from "@/stores/tabs/types";

/**
 * The canonical set of refs a strip layout may reference: every open Epic tab in canvas order,
 * then every landing draft. Defined once on purpose.
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
