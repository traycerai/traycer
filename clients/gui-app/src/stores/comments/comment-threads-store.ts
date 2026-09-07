/** Per-epic ephemeral UI state for the comments surface. */
import { create } from "zustand";

export interface FlashThread {
  readonly threadId: string;
  readonly nonce: number;
}

export interface DraftRange {
  readonly tileId: string;
  readonly artifactId: string;
  readonly from: number;
  readonly to: number;
  /** Snapshot of the selected text at draft-open time; used as the
   *  thread's frozen `quotedText` if the user submits. */
  readonly quotedText: string;
}

export interface CommentThreadsStore {
  readonly activeByEpicId: Readonly<Record<string, string | null>>;
  readonly hoverByEpicId: Readonly<Record<string, string | null>>;
  readonly flashByEpicId: Readonly<Record<string, FlashThread | null>>;
  readonly draftByEpicId: Readonly<Record<string, DraftRange | null>>;
  readonly artifactByEpicId: Readonly<Record<string, string | null>>;

  readonly setActiveThread: (epicId: string, threadId: string | null) => void;
  readonly setHoverThread: (epicId: string, threadId: string | null) => void;
  readonly setFlashThread: (epicId: string, threadId: string) => void;
  readonly clearFlashThread: (epicId: string, nonce: number) => void;
  readonly setDraft: (epicId: string, draft: DraftRange | null) => void;
  readonly clearDraft: (epicId: string) => void;
  readonly setCurrentArtifact: (
    epicId: string,
    artifactId: string | null,
  ) => void;
}

let flashNonce = 0;

function patchById<T>(
  map: Readonly<Record<string, T>>,
  id: string,
  next: T,
  prevDefault: T,
): Readonly<Record<string, T>> | null {
  const current = map[id] ?? prevDefault;
  if (current === next) return null;
  return { ...map, [id]: next };
}

export const useCommentThreadsStore = create<CommentThreadsStore>((set) => ({
  activeByEpicId: {},
  hoverByEpicId: {},
  flashByEpicId: {},
  draftByEpicId: {},
  artifactByEpicId: {},

  setActiveThread: (epicId, threadId) => {
    set((state) => {
      const next = patchById(state.activeByEpicId, epicId, threadId, null);
      return next === null ? {} : { activeByEpicId: next };
    });
  },

  setHoverThread: (epicId, threadId) => {
    set((state) => {
      const next = patchById(state.hoverByEpicId, epicId, threadId, null);
      return next === null ? {} : { hoverByEpicId: next };
    });
  },

  setFlashThread: (epicId, threadId) => {
    set((state) => {
      const next = patchById(
        state.flashByEpicId,
        epicId,
        { threadId, nonce: ++flashNonce },
        null,
      );
      return next === null ? {} : { flashByEpicId: next };
    });
  },

  clearFlashThread: (epicId, nonce) => {
    set((state) => {
      const current = state.flashByEpicId[epicId] ?? null;
      if (current === null || current.nonce !== nonce) return {};
      const next = patchById(state.flashByEpicId, epicId, null, null);
      return next === null ? {} : { flashByEpicId: next };
    });
  },

  setDraft: (epicId, draft) => {
    set((state) => {
      const next = patchById(state.draftByEpicId, epicId, draft, null);
      return next === null ? {} : { draftByEpicId: next };
    });
  },

  clearDraft: (epicId) => {
    set((state) => {
      const next = patchById(state.draftByEpicId, epicId, null, null);
      return next === null ? {} : { draftByEpicId: next };
    });
  },

  setCurrentArtifact: (epicId, artifactId) => {
    set((state) => {
      const next = patchById(state.artifactByEpicId, epicId, artifactId, null);
      return next === null ? {} : { artifactByEpicId: next };
    });
  },
}));

export function useActiveThreadId(epicId: string): string | null {
  return useCommentThreadsStore((s) => s.activeByEpicId[epicId] ?? null);
}

export function useHoverThreadId(epicId: string): string | null {
  return useCommentThreadsStore((s) => s.hoverByEpicId[epicId] ?? null);
}

export function useFlashThread(epicId: string): FlashThread | null {
  return useCommentThreadsStore((s) => s.flashByEpicId[epicId] ?? null);
}

export function useDraftRange(epicId: string): DraftRange | null {
  return useCommentThreadsStore((s) => s.draftByEpicId[epicId] ?? null);
}
