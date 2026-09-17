/**
 * Shared fake-IndexedDB harness for every suite that drives a real IndexedDB
 * (landing images, drafts, appearance cache, tab recovery). Installs a fresh
 * factory per test so prior DBs and connections cannot leak state.
 */
import {
  IDBFactory as FakeIDBFactory,
  IDBKeyRange as FakeIDBKeyRange,
} from "fake-indexeddb";

export function installFreshIndexedDb(): void {
  // Fresh factory per test so prior DBs and connections cannot leak state.
  // The package re-exports its constructors as IDBFactory / IDBKeyRange.
  globalThis.indexedDB = new FakeIDBFactory();
  globalThis.IDBKeyRange = FakeIDBKeyRange;
}
