import type { StateStorage } from "zustand/middleware";
import {
  recordMapStorageKey,
  recordMapStoragePrefix,
} from "@/lib/persist/keys";

interface RecordMapStorage extends StateStorage<void> {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

interface RecordMapSnapshot {
  readonly records: Readonly<Record<string, unknown>>;
  readonly version: number;
}

interface RecordMapOptions {
  readonly field: string;
  readonly separatePrefix?: string;
  /** Reconcile a write against a record changed since this window observed it. */
  readonly reconcile?: (
    observed: string | undefined,
    current: string,
    proposed: string,
  ) => string | undefined;
}

function parseSnapshot(value: string | null, field: string): RecordMapSnapshot {
  const parsed: unknown = value === null ? null : JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || !("state" in parsed)) {
    return { records: {}, version: 1 };
  }
  const state = parsed.state;
  const records: unknown =
    typeof state === "object" && state !== null && field in state
      ? Reflect.get(state, field)
      : null;
  return {
    records:
      typeof records === "object" && records !== null
        ? Object.fromEntries(Object.entries(records))
        : {},
    version:
      "version" in parsed && typeof parsed.version === "number"
        ? parsed.version
        : 1,
  };
}

/**
 * Persist a map by record, writing only this window's changes. Replacing a
 * whole map from a stale window must not erase another window's new records.
 * Tombstones fence late writes and simultaneous legacy-snapshot migrations.
 */
export function createRecordMapStorage(
  options: string | RecordMapOptions,
): RecordMapStorage {
  const field = typeof options === "string" ? options : options.field;
  const separatePrefix =
    typeof options === "string" ? undefined : options.separatePrefix;
  const reconcile = typeof options === "string" ? undefined : options.reconcile;
  let observed = new Map<string, string>();
  const tracksRecord = (id: string, record: string): boolean =>
    (record !== "null" || reconcile !== undefined) &&
    (separatePrefix === undefined || !id.startsWith(separatePrefix));
  const reconcileChange = (
    before: string | undefined,
    current: string | null,
    proposed: string,
  ): string | undefined =>
    reconcile !== undefined && current !== null && current !== before
      ? reconcile(before, current, proposed)
      : proposed;
  const writableRecord = (
    before: string | undefined,
    current: string | null,
  ): boolean =>
    current === "null"
      ? reconcile !== undefined && before === "null"
      : current !== null || before === undefined;
  return {
    getItem: (name) => {
      const raw = localStorage.getItem(name);
      const header: unknown = raw === null ? null : JSON.parse(raw);
      const snapshot = parseSnapshot(raw, field);
      if (
        typeof header !== "object" ||
        header === null ||
        !("recordStorage" in header) ||
        header.recordStorage !== true
      ) {
        for (const [id, record] of Object.entries(snapshot.records)) {
          const key = recordMapStorageKey(name, id);
          if (localStorage.getItem(key) === null) {
            localStorage.setItem(key, JSON.stringify(record));
          }
        }
        localStorage.setItem(
          name,
          JSON.stringify({
            state: { [field]: {} },
            version: snapshot.version,
            recordStorage: true,
          }),
        );
      }
      const prefix = recordMapStoragePrefix(name);
      const records: Record<string, unknown> = {};
      observed = new Map();
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key === null || !key.startsWith(prefix)) continue;
        const record = localStorage.getItem(key);
        if (record === null) continue;
        const id = decodeURIComponent(key.slice(prefix.length));
        if (record !== "null") records[id] = JSON.parse(record);
        if (tracksRecord(id, record)) observed.set(id, record);
      }
      return JSON.stringify({
        state: { [field]: records },
        version: snapshot.version,
      });
    },
    setItem: (name, value) => {
      const snapshot = parseSnapshot(value, field);
      const next = new Map(
        Object.entries(snapshot.records).map(([id, record]) => [
          id,
          JSON.stringify(record),
        ]),
      );
      for (const [id, record] of next) {
        const before = observed.get(id);
        if (before === record) continue;
        const key = recordMapStorageKey(name, id);
        const current = localStorage.getItem(key);
        // A cancellation in another window wins over an old in-flight write.
        if (!writableRecord(before, current)) continue;
        const write = reconcileChange(before, current, record);
        if (write !== undefined) localStorage.setItem(key, write);
      }
      for (const [id, before] of observed) {
        if (next.has(id)) continue;
        const key = recordMapStorageKey(name, id);
        const current = localStorage.getItem(key);
        if (current === null) continue;
        const write = reconcileChange(before, current, "null");
        if (write === undefined) continue;
        if (current !== write || reconcile === undefined)
          localStorage.setItem(key, write);
        if (reconcile !== undefined) next.set(id, write);
      }
      observed = next;
      localStorage.setItem(
        name,
        JSON.stringify({
          state: { [field]: {} },
          version: snapshot.version,
          recordStorage: true,
        }),
      );
    },
    removeItem: (name) => {
      const prefix = recordMapStoragePrefix(name);
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key !== null && key.startsWith(prefix)) keys.push(key);
      }
      for (const key of keys) localStorage.removeItem(key);
      localStorage.removeItem(name);
      observed.clear();
    },
  };
}
