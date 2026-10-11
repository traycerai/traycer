import { createJSONStorage, type PersistStorage } from "zustand/middleware";
import {
  cancelDeferredJsonWrite,
  deferJsonWrite,
} from "@/lib/persist/deferred-json-storage";

// Shared zustand persist defaults. The registry supplies the default version;
// `version` is owned per-store so a shape change bumps one store at a time
// (spread `basePersistOptions(...)` then override `version: 2`). Lockstep
// migration is a non-goal — today every store stays at version 1.

export const CURRENT_PERSIST_VERSION = 1;

export const basePersistOptions = (name: string) =>
  ({ name, version: CURRENT_PERSIST_VERSION }) as const;

// Zustand calls partialize before storage.setItem. Keep the unprojected
// immutable snapshot here so projection and encoding both happen at flush.
export function createDeferredPersistStorage<State>(
  project: (state: State) => unknown,
  enabled: () => boolean,
): PersistStorage<State> {
  const storage = createJSONStorage<State>(() => window.localStorage);
  return {
    getItem: (name) => {
      // An authoritative read must not be overwritten by an older queued edit.
      cancelDeferredJsonWrite(name);
      return storage?.getItem(name) ?? null;
    },
    setItem: (name, value) => {
      if (!enabled() || storage === undefined) return;
      deferJsonWrite(name, () => {
        if (!enabled()) return;
        window.localStorage.setItem(
          name,
          JSON.stringify({ ...value, state: project(value.state) }),
        );
      });
    },
    removeItem: (name) => {
      cancelDeferredJsonWrite(name);
      return storage?.removeItem(name);
    },
  };
}

export function cancelDeferredPersistOnRetarget(store: {
  readonly persist: {
    readonly getOptions: () => { readonly name?: string };
    setOptions: (options: { readonly name?: string }) => void;
  };
}): void {
  const setOptions = store.persist.setOptions;
  store.persist.setOptions = (options) => {
    const name = store.persist.getOptions().name;
    if (
      name !== undefined &&
      options.name !== undefined &&
      options.name !== name
    ) {
      cancelDeferredJsonWrite(name);
    }
    setOptions(options);
  };
}
