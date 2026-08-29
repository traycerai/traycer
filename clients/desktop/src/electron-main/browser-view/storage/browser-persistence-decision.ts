import { app } from "electron";
import { join } from "node:path";
import { z } from "zod";
import type {
  BrowserCookieStorageBackend,
  BrowserPersistenceDecision,
} from "@traycer-clients/shared/platform/browser-view";
import { createJsonFileStore } from "../../app/json-file-store";

/**
 * Desktop-local persistence decision (spec §6.1). This file is the only thing
 * boot is allowed to read before deciding whether to touch the OS keystore -
 * reading it is pure I/O and can never raise an OS prompt.
 *
 * `storageBackend` is the backend the last *successful* probe selected. On
 * Linux it is what lets a later boot auto-enable silently: a machine that
 * already resolved `gnome_libsecret` will not prompt again, while an unknown
 * machine follows the macOS card path (spec §6.1 rules).
 */
export const BROWSER_PERSISTENCE_FILE_NAME = "browser-persistence.json";

export interface BrowserPersistenceRecord {
  readonly decision: BrowserPersistenceDecision;
  /** Backend from the last successful probe; `null` when never probed. */
  readonly storageBackend: BrowserCookieStorageBackend;
}

export const UNDECIDED_BROWSER_PERSISTENCE_RECORD: BrowserPersistenceRecord = {
  decision: { kind: "undecided" },
  storageBackend: null,
};

const decidedAtSchema = z.number().finite();

const decisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("undecided") }),
  z.strictObject({ kind: z.literal("enabled"), decidedAt: decidedAtSchema }),
  z.strictObject({ kind: z.literal("declined"), decidedAt: decidedAtSchema }),
  z.strictObject({
    kind: z.literal("relaunch-pending"),
    decidedAt: decidedAtSchema,
  }),
]);

const storageBackendSchema = z.union([
  z.enum([
    "basic_text",
    "gnome_libsecret",
    "kwallet",
    "kwallet5",
    "kwallet6",
    "unknown",
  ]),
  z.null(),
]);

const recordSchema = z.strictObject({
  version: z.literal(1),
  decision: decisionSchema,
  storageBackend: storageBackendSchema,
});

export interface BrowserPersistenceDecisionStore {
  /** Missing, unreadable or corrupt file all read back as `undecided`. */
  read(): Promise<BrowserPersistenceRecord>;
  /** Atomic (tmp + rename), `0600`, serialized against concurrent writes. */
  write(record: BrowserPersistenceRecord): Promise<void>;
}

interface PersistedBrowserPersistenceRecord extends BrowserPersistenceRecord {
  readonly version: 1;
}

const UNDECIDED_PERSISTED_RECORD: PersistedBrowserPersistenceRecord = {
  version: 1,
  ...UNDECIDED_BROWSER_PERSISTENCE_RECORD,
};

export function createBrowserPersistenceDecisionStore(
  filePath: string,
): BrowserPersistenceDecisionStore {
  const store = createJsonFileStore<PersistedBrowserPersistenceRecord>(
    filePath,
    UNDECIDED_PERSISTED_RECORD,
    parsePersistedRecord,
  );
  return {
    async read() {
      const persisted = await store.load();
      return {
        decision: persisted.decision,
        storageBackend: persisted.storageBackend,
      };
    },
    write: (record) =>
      store.saveStrict({
        version: 1,
        decision: record.decision,
        storageBackend: record.storageBackend,
      }),
  };
}

export function parseBrowserPersistenceRecord(
  value: unknown,
): BrowserPersistenceRecord {
  const persisted = parsePersistedRecord(value);
  return {
    decision: persisted.decision,
    storageBackend: persisted.storageBackend,
  };
}

function parsePersistedRecord(
  value: unknown,
): PersistedBrowserPersistenceRecord {
  const parsed = recordSchema.safeParse(value);
  if (!parsed.success) return UNDECIDED_PERSISTED_RECORD;
  return {
    version: 1,
    decision: parsed.data.decision,
    storageBackend: parsed.data.storageBackend,
  };
}

export function browserPersistenceFilePath(): string {
  return join(app.getPath("userData"), BROWSER_PERSISTENCE_FILE_NAME);
}
