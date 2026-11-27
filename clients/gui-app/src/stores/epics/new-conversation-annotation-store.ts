import { create } from "zustand";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import {
  type PersistedModalDraftSidecars,
  type PersistedModalDraftSidecar,
} from "@/stores/composer/composer-canvas-persistence";

/**
 * The new-conversation modal's browser-annotation sidecar, per epic: the
 * cards a selection sent to "New chat" carries until the create sends them.
 *
 * The crop bytes live in this window's image store. An ordinary draft read
 * installs them before replacing the sidecar.
 */
interface NewConversationAnnotationState {
  readonly byEpicId: Readonly<
    Record<string, ReadonlyArray<BrowserAnnotationRecord> | undefined>
  >;
  readonly dirtyByEpicId: Readonly<Partial<Record<string, true>>>;
  readonly add: (epicId: string, record: BrowserAnnotationRecord) => void;
  readonly remove: (epicId: string, annotationId: string) => void;
  readonly clear: (epicId: string) => void;
}

const NONE: ReadonlyArray<BrowserAnnotationRecord> = [];

export const useNewConversationAnnotationStore =
  create<NewConversationAnnotationState>((set) => ({
    byEpicId: {},
    dirtyByEpicId: {},
    add: (epicId, record) =>
      set((state) => {
        const previous = state.byEpicId[epicId] ?? [];
        const index = previous.findIndex(
          (row) => row.annotationId === record.annotationId,
        );
        if (previous[index] === record) return state;
        return {
          byEpicId: {
            ...state.byEpicId,
            [epicId]:
              index < 0
                ? [...previous, record]
                : previous.map((row, position) =>
                    position === index ? record : row,
                  ),
          },
          dirtyByEpicId: { ...state.dirtyByEpicId, [epicId]: true },
        };
      }),
    remove: (epicId, annotationId) =>
      set((state) => {
        const current = state.byEpicId[epicId] ?? [];
        const next = current.filter(
          (record) => record.annotationId !== annotationId,
        );
        if (next.length === current.length) return state;
        return {
          byEpicId: { ...state.byEpicId, [epicId]: next },
          dirtyByEpicId: { ...state.dirtyByEpicId, [epicId]: true },
        };
      }),
    clear: (epicId) => {
      set((state) => {
        const { [epicId]: _records, ...byEpicId } = state.byEpicId;
        const { [epicId]: _dirty, ...dirtyByEpicId } = state.dirtyByEpicId;
        return { byEpicId, dirtyByEpicId };
      });
    },
  }));

export function readNewConversationAnnotations(
  epicId: string,
): ReadonlyArray<BrowserAnnotationRecord> {
  return useNewConversationAnnotationStore.getState().byEpicId[epicId] ?? NONE;
}

export function settleNewConversationAnnotations(
  epicId: string,
  expected: ReadonlyArray<BrowserAnnotationRecord> | undefined,
): void {
  useNewConversationAnnotationStore.setState((state) => {
    if (state.byEpicId[epicId] !== expected || !state.dirtyByEpicId[epicId])
      return state;
    const { [epicId]: _dirty, ...dirtyByEpicId } = state.dirtyByEpicId;
    return { dirtyByEpicId };
  });
}

const ordinaryModalSidecarSlots = new Set<string>();
const coveredReleasedModalSidecars = new Map<
  string,
  PersistedModalDraftSidecar
>();

export function restoreOrdinaryModalSidecar(
  epicId: string,
  sidecar: PersistedModalDraftSidecar,
): void {
  if (!ordinaryModalSidecarSlots.has(epicId)) {
    const state = useNewConversationAnnotationStore.getState();
    const records = state.byEpicId[epicId];
    if (records !== undefined)
      coveredReleasedModalSidecars.set(epicId, {
        records,
        dirty: state.dirtyByEpicId[epicId] === true,
      });
  }
  ordinaryModalSidecarSlots.add(epicId);
  setModalSidecar(epicId, sidecar);
}

function setModalSidecar(
  epicId: string,
  sidecar: PersistedModalDraftSidecar,
): void {
  useNewConversationAnnotationStore.setState((state) => {
    const { [epicId]: _previous, ...dirtyByEpicId } = state.dirtyByEpicId;
    return {
      byEpicId: { ...state.byEpicId, [epicId]: sidecar.records },
      dirtyByEpicId: sidecar.dirty
        ? { ...dirtyByEpicId, [epicId]: true }
        : dirtyByEpicId,
    };
  });
}

export function uncoverOrdinaryModalSidecar(epicId: string): void {
  if (!ordinaryModalSidecarSlots.delete(epicId)) return;
  const released = coveredReleasedModalSidecars.get(epicId);
  coveredReleasedModalSidecars.delete(epicId);
  if (released === undefined)
    useNewConversationAnnotationStore.getState().clear(epicId);
  else setModalSidecar(epicId, released);
}

export function clearOrdinaryModalSidecars(): void {
  for (const epicId of ordinaryModalSidecarSlots)
    uncoverOrdinaryModalSidecar(epicId);
}

export function ordinaryModalSidecarsForStorage(
  state: NewConversationAnnotationState,
): PersistedModalDraftSidecars {
  return Object.fromEntries(
    Object.entries(state.byEpicId).flatMap(([epicId, records]) =>
      records === undefined
        ? []
        : [[epicId, { records, dirty: state.dirtyByEpicId[epicId] === true }]],
    ),
  );
}
