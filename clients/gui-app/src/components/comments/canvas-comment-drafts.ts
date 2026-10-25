import { createContext } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";

export interface SharedCommentComposerDraft {
  readonly content: JsonContent | null;
  readonly dirty: boolean;
  readonly pending: boolean;
  readonly onChange: (content: JsonContent, empty: boolean) => void;
}

export interface CanvasThreadDraft {
  readonly reply: JsonContent | null;
  readonly edit: {
    readonly commentId: string;
    readonly content: JsonContent;
    readonly dirty: boolean;
  } | null;
  readonly pending: boolean;
}
export const EMPTY_CANVAS_THREAD_DRAFT: CanvasThreadDraft = {
  reply: null,
  edit: null,
  pending: false,
};
interface CanvasCommentDraftState {
  readonly threads: Readonly<Record<string, CanvasThreadDraft | undefined>>;
  readonly update: (threadId: string, draft: CanvasThreadDraft) => void;
}
export type CanvasCommentDraftStore = StoreApi<CanvasCommentDraftState>;
export const CanvasCommentDraftContext =
  createContext<CanvasCommentDraftStore | null>(null);

// The normal and fullscreen sidebars belong to the same Epic session client.
// Weak ownership releases drafts with that session; panel unmounts do not.
const sessions = new WeakMap<
  HostClient<HostRpcRegistry>,
  Map<string, CanvasCommentDraftStore>
>();
export function canvasCommentDraftStore(
  client: HostClient<HostRpcRegistry>,
  scope: string,
): CanvasCommentDraftStore {
  let scopes = sessions.get(client);
  if (scopes === undefined) {
    scopes = new Map();
    sessions.set(client, scopes);
  }
  const existing = scopes.get(scope);
  if (existing !== undefined) return existing;
  const store = createStore<CanvasCommentDraftState>((set) => ({
    threads: {},
    update: (threadId, draft) =>
      set((state) => {
        const threads = { ...state.threads };
        if (draft.reply === null && draft.edit === null && !draft.pending)
          delete threads[threadId];
        else threads[threadId] = draft;
        return { threads };
      }),
  }));
  scopes.set(scope, store);
  return store;
}

/** One in-flight save across both surfaces; a failed save keeps the draft. */
export async function submitCanvasCommentDraft(
  store: CanvasCommentDraftStore | null,
  threadId: string,
  kind: "reply" | "edit",
  save: () => Promise<void>,
): Promise<boolean> {
  if (store === null) {
    await save();
    return true;
  }
  const before =
    store.getState().threads[threadId] ?? EMPTY_CANVAS_THREAD_DRAFT;
  if (before.pending) return false;
  store.getState().update(threadId, { ...before, pending: true });
  try {
    await save();
    const current =
      store.getState().threads[threadId] ?? EMPTY_CANVAS_THREAD_DRAFT;
    if (current[kind] === before[kind])
      store.getState().update(threadId, { ...current, [kind]: null });
    return true;
  } finally {
    const current =
      store.getState().threads[threadId] ?? EMPTY_CANVAS_THREAD_DRAFT;
    store.getState().update(threadId, { ...current, pending: false });
  }
}
