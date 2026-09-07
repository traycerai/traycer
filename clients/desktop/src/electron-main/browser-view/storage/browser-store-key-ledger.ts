import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";

const LEDGER_FILE_NAME = "browser-store-key-ledger.json";

const MAX_LEDGER_PAIRS = 64;

const entrySchema = z.strictObject({
  /** sha256 of the base64 blob, hex. */
  digest: z.string().max(64),
  userId: z.string().max(128),
  hostId: z.string().max(128),
});
type LedgerEntry = z.infer<typeof entrySchema>;

const recordSchema = z.strictObject({
  version: z.literal(1),
  /** Oldest first. */
  digests: z.array(entrySchema).max(1024),
});
type LedgerRecord = z.infer<typeof recordSchema>;

const EMPTY_RECORD: LedgerRecord = { version: 1, digests: [] };

let store: StrictJsonFileStore<LedgerRecord> | null = null;
let digests: readonly LedgerEntry[] = [];

export async function initBrowserStoreKeyLedger(
  savedLoginsPath: string,
): Promise<void> {
  store = createJsonFileStore<LedgerRecord>(
    join(dirname(savedLoginsPath), LEDGER_FILE_NAME),
    EMPTY_RECORD,
    (value) => recordSchema.safeParse(value).data ?? EMPTY_RECORD,
  );
  // Clamped on the way in as well as on the way out: the file is editable, and
  // an in-memory list is bounded only by whatever was last read.
  digests = (await store.load()).digests.slice(-MAX_LEDGER_PAIRS);
}

function digestOf(wrappedKeyBase64: string): string {
  return createHash("sha256").update(wrappedKeyBase64, "utf8").digest("hex");
}

/** The durable write is not awaited: the wrap answer is synchronous, and a crash between the two costs one host-side re-wrap, never a login. */
export function recordWrappedStoreKey(
  wrappedKeyBase64: string,
  userId: string,
  hostId: string,
): void {
  const digest = digestOf(wrappedKeyBase64);
  const existing = digests.find(
    (entry) => entry.userId === userId && entry.hostId === hostId,
  );
  if (existing?.digest === digest) return;
  digests = [
    ...digests.filter((entry) => entry !== existing),
    { digest, userId, hostId },
  ].slice(-MAX_LEDGER_PAIRS);
  const next: LedgerRecord = { version: 1, digests: [...digests] };
  if (store === null) {
    log.warn(
      "[browser-view] store-key ledger is not initialised; the wrap digest is kept in memory only",
    );
    return;
  }
  void store.save(next);
}

function matches(digest: string, userId: string): boolean {
  return digests.some(
    (entry) => entry.digest === digest && entry.userId === userId,
  );
}

export function isWrappedStoreKeyOurs(
  wrappedKeyBase64: string,
  userId: string,
): boolean {
  return matches(digestOf(wrappedKeyBase64), userId);
}

export async function flushBrowserStoreKeyLedgerForTests(): Promise<void> {
  await store?.flush();
}

/** TEST-TEARDOWN ONLY: the ledger above is module-global state. */
export function resetBrowserStoreKeyLedgerForTests(): void {
  store = null;
  digests = [];
}
