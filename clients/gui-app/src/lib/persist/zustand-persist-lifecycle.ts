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
   * The key this store was written under BEFORE account scoping moved from
   * the email to the canonical `userId`, or `null` for a store that never had
   * one.
   *
   * Required rather than optional so each bridge states its own answer: an
   * omitted migration is indistinguishable from a deliberate absence, and this
   * whole class of defect started with an identity parameter whose callers
   * silently disagreed about what they were passing.
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

/**
 * Move an email-bucketed entry onto its canonical-`userId` key, once.
 *
 * Without this, re-bucketing silently resets every existing install's
 * preferences on upgrade - canvas tab layout, composer run settings, landing
 * terminals, reading positions. That is not data the fix is entitled to throw
 * away, and a state reset nobody asked for reads as a bug rather than as a
 * migration.
 *
 * Adopt-and-retire rather than a standing fallback tier, deliberately: a
 * transitional tier that several accounts keep reading is the same leak in
 * miniature, and it never terminates. Two accounts SHARING an email - the
 * exact case this whole change exists for - race for the one legacy blob, and
 * the first to sign in takes it while the second starts clean. That is the
 * correct outcome and is strictly better than the status quo, where both share
 * the bucket permanently.
 *
 * Exported for the ONE persisted store that is not a singleton behind a
 * lifecycle bridge: the per-Epic open-epic store is created per handle with
 * its key baked into `persist`, so its adoption has to run before creation,
 * at the call site that knows both names.
 */
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
