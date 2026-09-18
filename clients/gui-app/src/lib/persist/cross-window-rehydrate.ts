/**
 * Make a persisted store pick up ANOTHER window's writes to it.
 *
 * `localStorage` fires `storage` in every other window of the origin, never in
 * the one that wrote - so a second window holds whatever it hydrated at start
 * until something re-reads the key. The settings store has done this since it
 * shipped; the layout and left-panel stores had not, which is fine while every
 * writer is a Settings page the user has open in one window and wrong the
 * moment an editor writes chrome preferences live in another.
 *
 * Idempotent per key, because module-load call sites cannot coordinate: two
 * imports of the same store must not leave two listeners rehydrating it twice
 * per event.
 */
const installedKeys = new Set<string>();

interface RehydratableStore {
  readonly persist: { rehydrate: () => Promise<void> | void };
}

export function installCrossWindowRehydrate(
  store: RehydratableStore,
  key: string,
): void {
  if (installedKeys.has(key)) return;
  if (typeof window === "undefined") return;
  installedKeys.add(key);
  window.addEventListener("storage", (event) => {
    // A `null` key is `localStorage.clear()`, which is every key at once -
    // including this one. Ignoring it would leave the store holding values
    // whose storage is gone (what "sign out in the other window" looks like).
    if (event.key === null || event.key === key) {
      void store.persist.rehydrate();
    }
  });
}
