/**
 * `@/stores/composer/prompt-stash-store` opens its IndexedDB connection as a
 * MODULE-LEVEL side effect (`void usePromptStashStore.getState().hydrate()`
 * at the bottom of the module), which runs the instant that module is first
 * imported - before any test's `beforeEach` gets a chance to run. jsdom has
 * no built-in `indexedDB`, and `prompt-stash-repository.ts` caches its opened
 * connection in a module-level `dbPromise` that a THROWN (not merely
 * rejected) "This browser does not support IndexedDB" error never resets, so
 * once that eager hydrate fails, every later `save`/`load` in the whole test
 * file fails the same way.
 *
 * Importing THIS module first (before anything that transitively imports the
 * real prompt-stash store) installs a fake IndexedDB factory before that
 * eager hydrate runs, so it succeeds against a real (fake) database instead.
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;
