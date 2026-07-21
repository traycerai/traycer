/**
 * Update the keybindings docs whenever the persisted shape or storage key changes.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { basePersistOptions, persistKey, STORE_KEYS } from "@/lib/persist";
import {
  ACTION_IDS,
  getDefaultBindings,
  type ActionId,
} from "@/lib/keybindings/actions";
import type { ChordString } from "@/lib/keybindings/chord";

/**
 * User-configured keyboard shortcuts. `bindings[id] === null` means the
 * action is explicitly unbound and will not fire from any chord.
 *
 * Persisted to `localStorage` with `version: 1`. Hydration preserves custom
 * user bindings, while `mergePersistedKeybindings` carries forward narrow
 * default corrections that should apply to existing default users.
 */
export interface KeybindingState {
  readonly bindings: Readonly<Record<ActionId, ChordString | null>>;
  setBinding: (id: ActionId, chord: ChordString) => void;
  clearBinding: (id: ActionId) => void;
  resetAll: () => void;
}

const LEGACY_SPLIT_RIGHT_CHORD = "mod+shift+d";
const LEGACY_SPLIT_DOWN_CHORD = "mod+d";

const KEYBINDING_STORE_KEY = persistKey(STORE_KEYS.keybinding);

export const useKeybindingStore = create<KeybindingState>()(
  persist(
    (set) => ({
      bindings: getDefaultBindings(),
      setBinding: (id, chord) => {
        set((state) => {
          if (state.bindings[id] === chord) return state;
          return { bindings: { ...state.bindings, [id]: chord } };
        });
      },
      clearBinding: (id) => {
        set((state) => {
          if (state.bindings[id] === null) return state;
          return { bindings: { ...state.bindings, [id]: null } };
        });
      },
      resetAll: () => {
        set({ bindings: getDefaultBindings() });
      },
    }),
    {
      ...basePersistOptions(KEYBINDING_STORE_KEY),
      merge: mergePersistedKeybindings,
    },
  ),
);

// Cross-window sync: zustand's `persist` middleware only writes on this
// window's own changes and reads once at module load, so without this a
// second window's rebind never reaches window A's in-memory `bindings` -
// conflict checks there (both directions with the desktop global summon
// shortcut) would keep validating against a stale snapshot. The browser
// `storage` event only fires in OTHER same-origin windows, never the one
// that wrote, so this can't loop with `setBinding`/`clearBinding`/`resetAll`.
// `event.key === null` covers an explicit `localStorage.clear()`.
window.addEventListener("storage", (event) => {
  if (event.key === null || event.key === KEYBINDING_STORE_KEY) {
    void useKeybindingStore.persist.rehydrate();
  }
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedBindingValue(value: unknown): value is ChordString | null {
  return typeof value === "string" || value === null;
}

function readPersistedBindings(
  persistedState: unknown,
): Partial<Record<ActionId, ChordString | null>> | null {
  if (!isRecord(persistedState)) return null;
  const { bindings } = persistedState;
  if (!isRecord(bindings)) return null;
  const persistedBindings: Partial<Record<ActionId, ChordString | null>> = {};
  for (const actionId of ACTION_IDS) {
    const value = bindings[actionId];
    if (isPersistedBindingValue(value)) {
      persistedBindings[actionId] = value;
    }
  }
  return persistedBindings;
}

function normalizePersistedBindings(
  bindings: Readonly<Partial<Record<ActionId, ChordString | null>>>,
): Readonly<Record<ActionId, ChordString | null>> {
  const merged = { ...getDefaultBindings(), ...bindings };
  if (
    merged["group.split.horizontal"] === LEGACY_SPLIT_RIGHT_CHORD &&
    merged["group.split.vertical"] === LEGACY_SPLIT_DOWN_CHORD
  ) {
    return {
      ...merged,
      "group.split.horizontal": "mod+d",
      "group.split.vertical": "mod+shift+d",
    };
  }
  return merged;
}

function mergePersistedKeybindings(
  persistedState: unknown,
  currentState: KeybindingState,
): KeybindingState {
  // `persistedState === undefined` means the storage key is genuinely
  // missing (removed, `localStorage.clear()`'d, or first launch) - zustand's
  // persist passes `undefined` rather than skipping `merge` in that case.
  // Reset to defaults rather than keeping whatever is in memory, so a
  // cross-window "clear local data"/reset doesn't leave this window on a
  // stale custom map that a later edit could persist right back
  // (distinct from malformed-but-present data, which still falls back to
  // `currentState` below).
  if (persistedState === undefined) {
    return { ...currentState, bindings: getDefaultBindings() };
  }
  const bindings = readPersistedBindings(persistedState);
  if (bindings === null) return currentState;
  return {
    ...currentState,
    bindings: normalizePersistedBindings(bindings),
  };
}

export function useBindingForAction(id: ActionId): ChordString | null {
  return useKeybindingStore((s) => s.bindings[id]);
}
