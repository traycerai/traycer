import { vi } from "vitest";

/**
 * Import-free half of the shared idb-keyval fixture: `vi.mock("idb-keyval")`
 * factories dynamic-import THIS module, so it must not (transitively) import
 * `idb-keyval` itself - `browser-annotation-idb-fixtures.ts` does, via the
 * landing-image store, which is why the two halves are separate files.
 */
export function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("landing image store keys are string hashes");
  }
  return key;
}

export function createIdbKeyvalMock(idbData: Map<string, unknown>) {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: string) => Promise.resolve(idbData.get(key))),
    set: vi.fn((key: string, value: unknown) => {
      idbData.set(key, value);
      return Promise.resolve();
    }),
    del: vi.fn((key: string) => {
      idbData.delete(key);
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
}
