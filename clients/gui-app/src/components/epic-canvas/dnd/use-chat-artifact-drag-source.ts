import {
  useDraggable,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { useId, useMemo } from "react";
import type { EpicArtifactKind } from "@traycer/protocol/common/registry";
import {
  resolveTabIdForEpic,
  useEpicCanvasStore,
} from "@/stores/epics/canvas/store";
import {
  CHAT_ARTIFACT_DND_TYPE,
  getChatArtifactDragId,
  type EpicCanvasChatArtifactDragData,
} from "@/components/epic-canvas/dnd/dnd";

/**
 * Artifact identity a chat drag source carries. Identity ONLY - no
 * `instanceId` (minted per drop at commit time, constraint C2). `null` when the
 * caller has no draggable identity to offer.
 */
export interface ChatArtifactDragIdentity {
  readonly id: string;
  readonly type: EpicArtifactKind;
  readonly name: string;
  readonly hostId: string;
}

/**
 * Shared `chat-artifact` drag-source wiring for both in-chat drag surfaces - the
 * assistant block card (`artifact-card-segment`) and the inline reference chip
 * (`traycer-reference-chip`). Owns the common core: the occurrence-unique drag
 * id, the pure `viewTabId` resolution, the stable identity->payload memo, and
 * the `useDraggable` registration. Each caller keeps its own eligibility gate
 * (`enabled`) and attaches the returned wiring to its own element - the card
 * attaches `setNodeRef` + `listeners` to its whole header row (no
 * `attributes`); the chip additionally spreads `attributes`.
 *
 * - C1: `viewTabId` comes from the NON-side-effecting `resolveTabIdForEpic` read
 *   reactively via a selector - never `resolveTargetTabForEpic`, which mutates
 *   tab state and must not run during render. A `null` result (no open tab for
 *   the epic) makes the source non-draggable.
 * - C2: the payload carries identity only; the `instanceId` is minted per drop
 *   at commit time, so it is absent here.
 * - C3: the drag id keys on `useId()`, not the artifact id, because the same
 *   artifact can appear many times in one thread.
 */
export function useChatArtifactDragSource(args: {
  readonly epicId: string | undefined;
  readonly identity: ChatArtifactDragIdentity | null;
  readonly enabled: boolean;
}): {
  readonly isDraggable: boolean;
  readonly setNodeRef: (element: HTMLElement | null) => void;
  readonly listeners: DraggableSyntheticListeners;
  readonly attributes: DraggableAttributes;
  readonly isDragging: boolean;
} {
  const { epicId, identity, enabled } = args;
  // C3 - occurrence-unique drag id.
  const occurrenceId = useId();
  // C1 - pure resolver read reactively via a selector; `null` => non-draggable.
  const viewTabId = useEpicCanvasStore((state) =>
    epicId === undefined || epicId.length === 0
      ? null
      : resolveTabIdForEpic(state, epicId),
  );
  // Depend the memo on the identity's PRIMITIVE fields, not the object: a caller
  // may hand a fresh identity object every render (e.g. a ref that mints a new
  // `instanceId`), and `useDraggable` must not see a new `data` reference each
  // render. Reading the primitives keeps the payload reference-stable.
  const id = identity === null ? null : identity.id;
  const type = identity === null ? null : identity.type;
  const name = identity === null ? null : identity.name;
  const hostId = identity === null ? null : identity.hostId;
  const dragData = useMemo<EpicCanvasChatArtifactDragData | undefined>(() => {
    if (!enabled) return undefined;
    if (epicId === undefined || epicId.length === 0) return undefined;
    if (viewTabId === null) return undefined;
    if (id === null || type === null || name === null || hostId === null) {
      return undefined;
    }
    return {
      kind: CHAT_ARTIFACT_DND_TYPE,
      epicId,
      viewTabId,
      artifact: { id, type, name, hostId },
    };
  }, [enabled, epicId, viewTabId, id, type, name, hostId]);

  const isDraggable = dragData !== undefined;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: getChatArtifactDragId(occurrenceId),
    disabled: !isDraggable,
    data: dragData,
  });

  return { isDraggable, setNodeRef, listeners, attributes, isDragging };
}
