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
  /** A new hold revision starts over. */
  readonly unanswered: {
    readonly revision: number;
    readonly tries: number;
  } | null;
}

/** Never the value nor its canonical text: a put is matched by its digest alone. */
export interface RememberedSettingsItem {
  readonly kind: string;
  readonly key: string;
  readonly os: string | null;
  readonly operation: "put" | "delete";
  readonly valueDigest: string | null;
  readonly expectedLiveRevision: number | null;
}

export interface BoundSettingsSave
  extends RememberedSettingsSave, RememberedSettingsItem {
  readonly environmentId: string;
  readonly sharingGeneration: number;
}

export interface UnansweredMoveSave {
  readonly environmentId: string | null;
  readonly acceptanceId: string;
  readonly resolveHostOs: boolean;
  /** A P5 reader must still see an unanswered base after the app downgrades. */
  readonly item: null;
  readonly moveItem: RememberedSettingsItem;
}

export type RememberedPersonalSave =
  | {
      readonly environmentId: string;
      readonly item: RememberedSettingsItem | null;
    }
  | UnansweredMoveSave;

interface LocalSettingsSave
  extends
    RememberedSettingsSave,
    Partial<{ readonly personal: RememberedPersonalSave | null }> {
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
  readonly noteUnanswered: (id: string, holdRevision: number) => void;
  readonly markSent: (id: string) => void;
  readonly markAnswered: (id: string) => void;
}

function itemFor(
  record: SettingsSaveMemoryRecord,
): RememberedSettingsItem | null {
  if (record.environmentId !== null) return record;
  const personal = record.personal;
  if (personal && "acceptanceId" in personal) return personal.moveItem;
  return personal?.item ?? null;
}

function sameItem(
  a: SettingsSaveMemoryRecord,
  b: SettingsSaveMemoryRecord,
): boolean {
  const aTarget = a.environmentId === null ? a.personal : a;
  const bTarget = b.environmentId === null ? b.personal : b;
  const aItem = itemFor(a);
  const bItem = itemFor(b);
  const sameTarget =
    aTarget?.environmentId === null && bTarget?.environmentId === null
      ? "acceptanceId" in aTarget &&
        "acceptanceId" in bTarget &&
        aTarget.acceptanceId === bTarget.acceptanceId
      : aTarget?.environmentId === bTarget?.environmentId;
  return (
    aItem !== null &&
    bItem !== null &&
    sameTarget &&
    a.hostId === b.hostId &&
    aItem.kind === bItem.kind &&
    aItem.key === bItem.key &&
    aItem.os === bItem.os
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
