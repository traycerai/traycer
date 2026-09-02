import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { z } from "zod";
import { log } from "../../app/logger";
import {
  createJsonFileStore,
  type StrictJsonFileStore,
} from "../../app/json-file-store";

/**
 * The blobs THIS installation wrapped (browser-security-hardening H03).
 *
 * `safeStorage.decryptString` is an oracle: Chromium's OSCrypt is AES-CBC with
 * a fixed IV and no MAC, so an ok/null answer over an attacker-chosen blob is a
 * padding oracle against this machine's own encrypted `Cookies` database - and
 * a host that hands over a blob it forged rather than one this desktop
 * produced gets a store key of its choosing adopted. Both stop at the same
 * rule: unwrap only what this desktop wrapped, checked against a durable
 * ledger of digests kept beside `browser-saved-logins.json`.
 *
 * Only the digest is stored: the ledger is not a second copy of the blob, and
 * a stolen ledger tells an attacker nothing it can decrypt.
 *
 * Every entry names the ACCOUNT it was wrapped for as well as the blob, and
 * both are matched: a store key is per user, so this machine's own blob for
 * another account is as foreign as another machine's.
 *
 * A file written before that field existed carries digests without accounts,
 * fails the strict parse and is DROPPED WHOLE rather than migrated. That is
 * fail-closed and cheap: the only consequence is that blobs wrapped before the
 * upgrade read as foreign, and each affected host heals with one re-wrap the
 * next time it asks - the same path a cold boot on a new machine already
 * takes. Migrating instead would mean guessing which account each old digest
 * belonged to, which is the one thing the field exists to stop.
 *
 * Bounded at {@link MAX_LEDGER_DIGESTS}, which is a FILE-SIZE bound and
 * nothing else - deliberately not the host's four-blobs-per-user cap. This
 * desktop wraps once per (host, user) pair it ever attaches to, so a cap of
 * four would evict a digest for a blob some host still holds: that blob then
 * reads as foreign, and on a cold boot with no raw key the host's heal
 * discards the encrypted slice and rebuilds it. A digest is unforgeable, so
 * keeping many costs nothing but bytes.
 *
 * The cap is per FILE, across every account that has signed in on this
 * machine - one shared eviction window, not one per user. A machine with
 * several accounts and many hosts therefore evicts sooner for all of them; the
 * cost of an eviction is the re-wrap above, so a per-account cap would be more
 * state for a cheaper version of an already cheap outcome.
 */
const LEDGER_FILE_NAME = "browser-store-key-ledger.json";

const MAX_LEDGER_DIGESTS = 64;

/**
 * One blob this desktop wrapped, and WHO it wrapped it for.
 *
 * The account is part of the entry because a store key is per user: without
 * it, one signed-in account's host could name another account's blob and this
 * machine would open it, handing a slice of someone else's jar to a host that
 * was never given custody of it. Matching on both is what keeps the answer
 * "yes, for you" rather than "yes, for somebody".
 */
const entrySchema = z.strictObject({
  /** sha256 of the base64 blob, hex. */
  digest: z.string().max(64),
  userId: z.string().max(128),
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

/** The ledger sits beside the saved-logins pref, in the same userData dir. */
export function browserStoreKeyLedgerPathBeside(
  savedLoginsPath: string,
): string {
  return join(dirname(savedLoginsPath), LEDGER_FILE_NAME);
}

/**
 * Loaded once at startup rather than lazily, because the check it feeds is
 * synchronous: the store-key IPC answers in one turn, and a ledger still
 * loading would refuse a blob this desktop really did wrap.
 */
export async function initBrowserStoreKeyLedger(
  filePath: string,
): Promise<void> {
  store = createJsonFileStore<LedgerRecord>(
    filePath,
    EMPTY_RECORD,
    (value) => recordSchema.safeParse(value).data ?? EMPTY_RECORD,
  );
  // Clamped on the way in as well as on the way out: the file is editable, and
  // an in-memory list is bounded only by whatever was last read.
  digests = (await store.load()).digests.slice(-MAX_LEDGER_DIGESTS);
}

function digestOf(wrappedKeyBase64: string): string {
  return createHash("sha256").update(wrappedKeyBase64, "utf8").digest("hex");
}

/**
 * Records a blob this desktop just produced. The durable write is not awaited:
 * the wrap answer is synchronous, and a crash between the two costs one
 * host-side re-wrap, never a login.
 */
export function recordWrappedStoreKey(
  wrappedKeyBase64: string,
  userId: string,
): void {
  const digest = digestOf(wrappedKeyBase64);
  if (matches(digest, userId)) return;
  digests = [...digests, { digest, userId }].slice(-MAX_LEDGER_DIGESTS);
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

/**
 * Did this installation wrap this blob FOR THIS ACCOUNT? Nothing else may be
 * decrypted - not another machine's blob, and not another account's.
 */
export function isWrappedStoreKeyOurs(
  wrappedKeyBase64: string,
  userId: string,
): boolean {
  return matches(digestOf(wrappedKeyBase64), userId);
}

/**
 * TEST ONLY: settles the write `recordWrappedStoreKey` deliberately does not
 * await, so a test can assert on the file, or tear its directory down, without
 * polling.
 */
export async function flushBrowserStoreKeyLedgerForTests(): Promise<void> {
  await store?.flush();
}

/** TEST-TEARDOWN ONLY: the ledger above is module-global state. */
export function resetBrowserStoreKeyLedgerForTests(): void {
  store = null;
  digests = [];
}
