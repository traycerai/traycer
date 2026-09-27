import { selectMobileTile } from "@/components/epic-canvas/mobile/mobile-tile-selection";
import { sessionKeyOf } from "@traycer-clients/shared/replica-runtime";
import {
  collectPanes,
  resolveActivePaneTab,
} from "@/stores/epics/canvas/tile-tree";
import type {
  EpicCanvasState,
  EpicCanvasTileRef,
  TilePane,
} from "@/stores/epics/canvas/types";

interface ChatPrewarmRef {
  readonly id: string;
  readonly hostId: string;
  readonly instanceId: string;
}

function activeRefInPane(
  canvas: EpicCanvasState,
  pane: TilePane,
): EpicCanvasTileRef | null {
  const activeId = resolveActivePaneTab(pane.activeTabId, pane.tabInstanceIds);
  const active =
    activeId === null ? undefined : canvas.tilesByInstanceId[activeId];
  if (active !== undefined) return active;
  for (const instanceId of pane.tabInstanceIds) {
    const ref = canvas.tilesByInstanceId[instanceId];
    if (ref !== undefined) return ref;
  }
  return null;
}

/** The chats whose transcript can be the first visible tile on this canvas. */
export function selectChatPrewarmRefs(
  canvas: EpicCanvasState,
  mobile: boolean,
  pendingCreateIds: ReadonlySet<string>,
  selfDeletedIds: ReadonlySet<string>,
): ReadonlyArray<ChatPrewarmRef> {
  const selected = mobile
    ? [selectMobileTile(canvas)?.ref ?? null]
    : collectPanes(canvas.root).map((pane) => activeRefInPane(canvas, pane));
  const seen = new Set<string>();
  const refs: ChatPrewarmRef[] = [];
  for (const ref of selected) {
    if (
      ref?.type !== "chat" ||
      pendingCreateIds.has(ref.id) ||
      selfDeletedIds.has(ref.id)
    ) {
      continue;
    }
    const key = sessionKeyOf([ref.hostId, ref.id]);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ id: ref.id, hostId: ref.hostId, instanceId: ref.instanceId });
  }
  return refs;
}
