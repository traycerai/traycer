import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, settingsSaveMemoryKey } from "@/lib/persist";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";

/** How long a bound save waits for its hold before it is forgotten. */
export const SETTINGS_SAVE_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

/** How many bound saves are remembered; local saves await the host's receipt. */
const SETTINGS_SAVE_MEMORY_CAP = 200;

interface RememberedSettingsSave {
  /** A later save of the same item replaces the record, so earlier work finds nothing. */
  readonly editId: string;
  readonly hostId: string;
  readonly writtenAt: number;
  /** The live revision from the original review of this promotion, including across an unanswered apply. */
  readonly promotionBase?: {
    readonly heldRevision: number;
    readonly liveRevision: number | null;
  };
  /** A new hold revision starts over. */
  readonly unanswered: {
    readonly revision: number;
    readonly tries: number;
  } | null;
}

/** Never the value nor its canonical text: a put is matched by its digest alone. */
export interface BoundSettingsSave extends RememberedSettingsSave {
  readonly environmentId: string;
  readonly sharingGeneration: number;
  readonly kind: string;
  readonly key: string;
  readonly os: string | null;
  readonly operation: "put" | "delete";
  readonly valueDigest: string | null;
  readonly expectedLiveRevision: number | null;
}

interface LocalSettingsSave extends RememberedSettingsSave {
  readonly environmentId: null;
}

export type SettingsSaveMemoryRecord = BoundSettingsSave | LocalSettingsSave;

interface SettingsSaveMemoryState {
  readonly records: Readonly<Record<string, SettingsSaveMemoryRecord>>;
  /** Never persisted: a restart has none. */
  readonly inFlight: Readonly<Record<string, number>>;
  /** Forgets every earlier save of the same item on the same host. */
  readonly remember: (record: SettingsSaveMemoryRecord) => string;
  readonly forget: (id: string) => void;
  readonly notePromotionBase: (
    id: string,
    heldRevision: number,
    liveRevision: number | null,
  ) => void;
  readonly noteUnanswered: (id: string, holdRevision: number) => void;
  readonly markSent: (id: string) => void;
  readonly markAnswered: (id: string) => void;
}

function sameItem(
  a: SettingsSaveMemoryRecord,
  b: SettingsSaveMemoryRecord,
): boolean {
  return (
    a.environmentId !== null &&
    b.environmentId !== null &&
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
  const bound = entries.filter(([, record]) => record.environmentId !== null);
  if (bound.length <= SETTINGS_SAVE_MEMORY_CAP) return { ...records };
  return Object.fromEntries([
    ...entries.filter(([, record]) => record.environmentId === null),
    ...bound
      .toSorted(([, a], [, b]) => b.writtenAt - a.writtenAt)
      .slice(0, SETTINGS_SAVE_MEMORY_CAP),
  ]);
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
      notePromotionBase: (id, heldRevision, liveRevision) =>
        set((state) => {
          const record = settingsSaveMemoryRecord(state.records, id);
          if (
            record === null ||
            record.promotionBase?.heldRevision === heldRevision
          )
            return state;
          return {
            records: {
              ...state.records,
              [id]: {
                ...record,
                promotionBase: { heldRevision, liveRevision },
              },
            },
          };
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
