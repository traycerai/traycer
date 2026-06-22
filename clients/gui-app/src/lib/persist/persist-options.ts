// Shared zustand persist defaults. The registry supplies the default version;
// `version` is owned per-store so a shape change bumps one store at a time
// (spread `basePersistOptions(...)` then override `version: 2`). Lockstep
// migration is a non-goal — today every store stays at version 1.

export const CURRENT_PERSIST_VERSION = 1;

export const basePersistOptions = (name: string) =>
  ({ name, version: CURRENT_PERSIST_VERSION }) as const;
