import { createContext, useContext } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";

interface FrameCommentSurfaceState {
  readonly pins: ReadonlyMap<symbol, string>;
  readonly registerPin: (threadId: string) => () => void;
}

export function createFrameCommentSurfaceStore() {
  return createStore<FrameCommentSurfaceState>((set) => ({
    pins: new Map(),
    registerPin: (threadId) => {
      const owner = Symbol(threadId);
      set((state) => ({ pins: new Map(state.pins).set(owner, threadId) }));
      return () => {
        set((state) => {
          const pins = new Map(state.pins);
          pins.delete(owner);
          return { pins };
        });
      };
    },
  }));
}

export const FrameCommentSurfaceContext =
  createContext<StoreApi<FrameCommentSurfaceState> | null>(null);

export function useFrameCommentSurface() {
  const store = useContext(FrameCommentSurfaceContext);
  if (store === null)
    throw new Error("Frame comments require a surface provider.");
  return store;
}
