import {
  persistKey,
  recordMapStoragePrefix,
  STORE_KEYS,
} from "@/lib/persist/keys";

export const STAGED_SANDBOX_STORAGE_KEY = persistKey(
  STORE_KEYS.stagedSandboxSend,
);

export function persistedStageStorage(): ReadonlyArray<
  readonly [string, string]
> {
  const prefix = recordMapStoragePrefix(STAGED_SANDBOX_STORAGE_KEY);
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      key === null ||
      (key !== STAGED_SANDBOX_STORAGE_KEY && !key.startsWith(prefix))
    ) {
      continue;
    }
    const value = localStorage.getItem(key);
    if (value !== null) entries.push([key, value]);
  }
  return entries;
}

export function restoreStageStorage(
  entries: ReadonlyArray<readonly [string, string]>,
): void {
  const prefix = recordMapStoragePrefix(STAGED_SANDBOX_STORAGE_KEY);
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (
      key === STAGED_SANDBOX_STORAGE_KEY ||
      (key !== null && key.startsWith(prefix))
    ) {
      keys.push(key);
    }
  }
  for (const key of keys) localStorage.removeItem(key);
  for (const [key, value] of entries) localStorage.setItem(key, value);
}
