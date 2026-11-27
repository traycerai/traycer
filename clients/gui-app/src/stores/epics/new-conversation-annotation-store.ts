import { create } from "zustand";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { admitsLocalPlane, useAuthStore } from "@/stores/auth/auth-store";
import {
  readWindowOrdinaryDraftScope,
  updateWindowOrdinaryDraftScope,
  type OrdinaryDraftScopeBinding,
  type PersistedModalDraftSidecars,
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
    clear: (epicId) =>
      set((state) => {
        const { [epicId]: _records, ...byEpicId } = state.byEpicId;
        const { [epicId]: _dirty, ...dirtyByEpicId } = state.dirtyByEpicId;
        return { byEpicId, dirtyByEpicId };
      }),
  }));

export function readNewConversationAnnotations(
  epicId: string,
): ReadonlyArray<BrowserAnnotationRecord> {
  return useNewConversationAnnotationStore.getState().byEpicId[epicId] ?? NONE;
}

export function projectNewConversationAnnotations(
  epicId: string,
  annotations: ReadonlyArray<BrowserAnnotationRecord>,
): void {
  useNewConversationAnnotationStore.setState((state) => {
    const { [epicId]: _dirty, ...dirtyByEpicId } = state.dirtyByEpicId;
    return {
      byEpicId: { ...state.byEpicId, [epicId]: annotations },
      dirtyByEpicId,
    };
  });
}

export function ordinaryModalSidecarsWithProjection(
  epicId: string,
  records: ReadonlyArray<BrowserAnnotationRecord> | null,
): PersistedModalDraftSidecars {
  const { [epicId]: _previous, ...existing } = modalSidecarsForStorage(
    useNewConversationAnnotationStore.getState(),
  );
  if (records === null) return existing;
  return {
    ...existing,
    [epicId]: { records, dirty: false },
  };
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

let modalSidecarScope: OrdinaryDraftScopeBinding | null = null;
let restoringModalSidecars = false;

export function bindOrdinaryModalSidecarScope(
  binding: OrdinaryDraftScopeBinding,
): void {
  if (
    modalSidecarScope?.scopeId === binding.scopeId &&
    modalSidecarScope.ownerId === binding.ownerId
  )
    return;
  const previous = modalSidecarScope;
  modalSidecarScope = binding;
  const saved = readWindowOrdinaryDraftScope(
    binding.ownerId,
    binding.scopeId,
  )?.modalSidecars;
  if (
    previous === null &&
    (saved === undefined || Object.keys(saved).length === 0)
  )
    return;
  restoreModalSidecars(saved ?? {});
}

function restoreModalSidecars(saved: PersistedModalDraftSidecars): void {
  restoringModalSidecars = true;
  try {
    useNewConversationAnnotationStore.setState({
      byEpicId: Object.fromEntries(
        Object.entries(saved).flatMap(([epicId, entry]) =>
          entry === undefined ? [] : [[epicId, entry.records]],
        ),
      ),
      dirtyByEpicId: Object.fromEntries(
        Object.entries(saved).flatMap(([epicId, entry]) =>
          entry?.dirty ? [[epicId, true]] : [],
        ),
      ),
    });
  } finally {
    restoringModalSidecars = false;
  }
}

useNewConversationAnnotationStore.subscribe((state, previous) => {
  if (
    restoringModalSidecars ||
    modalSidecarScope === null ||
    (state.byEpicId === previous.byEpicId &&
      state.dirtyByEpicId === previous.dirtyByEpicId)
  )
    return;
  updateWindowOrdinaryDraftScope(modalSidecarScope, {
    modalSidecars: modalSidecarsForStorage(state),
  });
});

function modalSidecarsForStorage(
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

useAuthStore.subscribe((current, previous) => {
  const ownerId = admitsLocalPlane(current.status)
    ? (current.contextMetadata?.userId ?? null)
    : null;
  const previousOwnerId = admitsLocalPlane(previous.status)
    ? (previous.contextMetadata?.userId ?? null)
    : null;
  if (ownerId === previousOwnerId) return;
  const known =
    ownerId === null ? null : readWindowOrdinaryDraftScope(ownerId, null);
  if (known !== null) bindOrdinaryModalSidecarScope(known.binding);
  else if (modalSidecarScope !== null) {
    modalSidecarScope = null;
    restoreModalSidecars({});
  }
});
