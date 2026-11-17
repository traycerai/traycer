import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, settingsSaveMemoryKey } from "@/lib/persist";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";

/** How long a remembered save waits for its hold before it is forgotten. */
export const SETTINGS_SAVE_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

/** How many saves are remembered at most; the oldest go first. */
const SETTINGS_SAVE_MEMORY_CAP = 200;

/** Never the value nor its canonical text: a put is matched by {@link valueDigest} alone. */
export interface SettingsSaveMemoryRecord {
  /** A later save of the same item replaces the record, so work begun for the earlier edit finds nothing. */
  readonly editId: string;
  readonly environmentId: string;
  readonly hostId: string;
  readonly sharingGeneration: number;
  readonly kind: string;
  readonly key: string;
  readonly os: string | null;
  readonly operation: "put" | "delete";
  /** SHA-256 of the put value's canonical text; null for a delete. */
  readonly valueDigest: string | null;
  readonly expectedLiveRevision: number | null;
  readonly writtenAt: number;
  /** A new hold revision starts over. */
  readonly unanswered: {
    readonly revision: number;
    readonly tries: number;
  } | null;
}

interface SettingsSaveMemoryState {
  readonly records: Readonly<Record<string, SettingsSaveMemoryRecord>>;
  /** Never persisted: a restart has none. */
  readonly inFlight: Readonly<Record<string, number>>;
  /** Forgets every earlier save of the same item on the same host. */
  readonly remember: (record: SettingsSaveMemoryRecord) => string;
  readonly forget: (id: string) => void;
  readonly noteUnanswered: (id: string, holdRevision: number) => void;
  readonly markSent: (id: string) => void;
  readonly markAnswered: (id: string) => void;
}

function sameItem(
  a: SettingsSaveMemoryRecord,
  b: SettingsSaveMemoryRecord,
): boolean {
  return (
    a.environmentId === b.environmentId &&
    a.hostId === b.hostId &&
    a.kind === b.kind &&
    a.key === b.key &&
    a.os === b.os
  );
}

function newestWithin(
  records: Readonly<Record<string, SettingsSaveMemoryRecord>>,
): Record<string, SettingsSaveMemoryRecord> {
  const entries = Object.entries(records);
  if (entries.length <= SETTINGS_SAVE_MEMORY_CAP) return { ...records };
  return Object.fromEntries(
    entries
      .toSorted(([, a], [, b]) => b.writtenAt - a.writtenAt)
      .slice(0, SETTINGS_SAVE_MEMORY_CAP),
  );
}

export function settingsSaveMemoryRecord(
  records: Readonly<Record<string, SettingsSaveMemoryRecord>>,
  id: string,
): SettingsSaveMemoryRecord | null {
  return Object.hasOwn(records, id) ? records[id] : null;
}

function without(
  map: Readonly<Record<string, number>>,
  id: string,
): Record<string, number> {
  const { [id]: _removed, ...rest } = map;
  return rest;
}

// Kept per account, record by record, so a window that read earlier never erases another window's newer saves.
export const useSettingsSaveMemoryStore = create<SettingsSaveMemoryState>()(
  persist(
    (set) => ({
      records: {},
      inFlight: {},
      remember: (record) => {
        const id = record.editId;
        set((state) => ({
          records: newestWithin({
            ...Object.fromEntries(
              Object.entries(state.records).filter(
                ([, held]) => !sameItem(held, record),
              ),
            ),
            [id]: record,
          }),
        }));
        return id;
      },
      forget: (id) =>
        set((state) => {
          if (!Object.hasOwn(state.records, id)) return state;
          const { [id]: _forgotten, ...records } = state.records;
          return { records };
        }),
      noteUnanswered: (id, holdRevision) =>
        set((state) => {
          const record = settingsSaveMemoryRecord(state.records, id);
          if (record === null) return state;
          const tries =
            record.unanswered?.revision === holdRevision
              ? record.unanswered.tries + 1
              : 1;
          return {
            records: {
              ...state.records,
              [id]: {
                ...record,
                unanswered: { revision: holdRevision, tries },
              },
            },
          };
        }),
      markSent: (id) =>
        set((state) => ({
          inFlight: { ...state.inFlight, [id]: (state.inFlight[id] ?? 0) + 1 },
        })),
      markAnswered: (id) =>
        set((state) => {
          const count = state.inFlight[id] ?? 0;
          return {
            inFlight:
              count <= 1
                ? without(state.inFlight, id)
                : { ...state.inFlight, [id]: count - 1 },
          };
        }),
    }),
    {
      ...basePersistOptions(settingsSaveMemoryKey(null)),
      storage: createJSONStorage(() => createRecordMapStorage("records")),
      partialize: (state) => ({ records: state.records }),
    },
  ),
);
