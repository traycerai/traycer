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
}): void {
  input.store.persist.setOptions({ name: input.name });
  if (window.localStorage.getItem(input.name) === null) {
    input.store.setState(input.store.getInitialState());
    return;
  }
  void input.store.persist.rehydrate();
}

export function clearAndResetPersistedStore<State>(input: {
  readonly store: PersistLifecycleStore<State>;
  readonly anonymousName: string;
}): void {
  input.store.persist.clearStorage();
  input.store.persist.setOptions({ name: input.anonymousName });
  input.store.setState(input.store.getInitialState());
}
