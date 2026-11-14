import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { basePersistOptions, settingsSaveMemoryKey } from "@/lib/persist";
import { createRecordMapStorage } from "@/lib/persist/record-map-storage";

/** How long a remembered save waits for its hold before it is forgotten. */
export const SETTINGS_SAVE_MEMORY_TTL_MS = 24 * 60 * 60 * 1000;

/** How many saves are remembered at most; the oldest go first. */
const SETTINGS_SAVE_MEMORY_CAP = 200;

/**
 * One save this account made in a host's settings that it expects authn to
 * hold, for this account to apply. Never the value and never its canonical
 * text: a put is matched by {@link valueDigest} alone.
 */
export interface SettingsSaveMemoryRecord {
  readonly environmentId: string;
  readonly hostId: string;
  /** The host's sharing generation when the save was made. */
  readonly sharingGeneration: number;
  readonly kind: string;
  readonly key: string;
  readonly os: string | null;
  readonly operation: "put" | "delete";
  /** SHA-256 of the put value's canonical text; null for a delete. */
  readonly valueDigest: string | null;
  /** The live item's revision read from authn when the person made the edit. */
  readonly expectedLiveRevision: number | null;
  readonly writtenAt: number;
  /**
   * A hold revision whose apply went unanswered, and how many times; null
   * until one does. A new hold revision starts over.
   */
  readonly unanswered: {
    readonly revision: number;
    readonly tries: number;
  } | null;
}

interface SettingsSaveMemoryState {
  readonly records: Readonly<Record<string, SettingsSaveMemoryRecord>>;
  /**
   * The records whose save this window has sent and not yet seen answered,
   * with how many such saves each has. Never persisted: a restart has none.
   */
  readonly inFlight: Readonly<Record<string, number>>;
  /** Remembers `record`, forgetting every earlier save of the same item on the same host. */
  readonly remember: (record: SettingsSaveMemoryRecord) => string;
  readonly forget: (id: string) => void;
  readonly noteUnanswered: (id: string, holdRevision: number) => void;
  readonly markSent: (id: string) => void;
  readonly markAnswered: (id: string) => void;
}

/** The record's id: the save's full address, so two saves of one item never share one. */
export function settingsSaveMemoryId(
  record: Pick<
    SettingsSaveMemoryRecord,
    | "environmentId"
    | "hostId"
    | "sharingGeneration"
    | "kind"
    | "key"
    | "os"
    | "operation"
  >,
): string {
  return JSON.stringify([
    record.environmentId,
    record.hostId,
    record.sharingGeneration,
    record.kind,
    record.key,
    record.os,
    record.operation,
  ]);
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

/** The record remembered under `id`; null when there is none. */
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

/**
 * The saves this account expects authn to hold. Kept per account, record by
 * record, so a window that read the store earlier never erases another
 * window's newer saves; the lifecycle bridge points it at the signed-in
 * account and wipes it on sign-out.
 */
export const useSettingsSaveMemoryStore = create<SettingsSaveMemoryState>()(
  persist(
    (set) => ({
      records: {},
      inFlight: {},
      remember: (record) => {
        const id = settingsSaveMemoryId(record);
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
