interface PersistLifecycleStore<State> {
  readonly persist: {
    readonly setOptions: (options: { readonly name: string }) => void;
    readonly clearStorage: () => void;
    readonly rehydrate: () => Promise<void> | void;
  };
  readonly setState: (state: State) => void;
  readonly getInitialState: () => State;
}

export function retargetPersistedStore<State>(input: {
  readonly store: PersistLifecycleStore<State>;
  readonly name: string;
  /**
   * The key this store was written under BEFORE account scoping moved from the email to the canonical `userId`, or `null` for a store that never had one.
   */
  readonly legacyName: string | null;
}): void {
  adoptLegacyPersistedKey(input.name, input.legacyName);
  input.store.persist.setOptions({ name: input.name });
  if (window.localStorage.getItem(input.name) === null) {
    input.store.setState(input.store.getInitialState());
    return;
  }
  void input.store.persist.rehydrate();
}

/** Move an email-bucketed entry onto its canonical-`userId` key, once. */
export function adoptLegacyPersistedKey(
  name: string,
  legacyName: string | null,
): void {
  if (legacyName === null || legacyName === name) return;
  // A key already written under the new scheme wins outright - re-adopting
  // would overwrite this account's own newer state with the old shared blob.
  if (window.localStorage.getItem(name) !== null) return;
  const legacy = window.localStorage.getItem(legacyName);
  if (legacy === null) return;
  window.localStorage.setItem(name, legacy);
  window.localStorage.removeItem(legacyName);
}

export function clearAndResetPersistedStore<State>(input: {
  readonly store: PersistLifecycleStore<State>;
  readonly anonymousName: string;
}): void {
  input.store.persist.clearStorage();
  input.store.persist.setOptions({ name: input.anonymousName });
  input.store.setState(input.store.getInitialState());
}
