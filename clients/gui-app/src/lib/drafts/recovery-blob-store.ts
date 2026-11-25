import type {
  DraftAuthorityRecoveryStores,
  DraftAuthorityVerifiedBlob,
} from "@/lib/drafts/draft-authority-types";

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RESIDENT_BYTES_KEY = "resident-bytes";

type BlobKey = Parameters<DraftAuthorityRecoveryStores["blobs"]["read"]>[0];
type RecoveryBlobErrorKind = "missing" | "invalid" | "budget";

export class RecoveryBlobError extends Error {
  readonly kind: RecoveryBlobErrorKind;

  constructor(kind: RecoveryBlobErrorKind) {
    super(`Recovery blob operation failed: ${kind}`);
    this.name = "RecoveryBlobError";
    this.kind = kind;
  }
}

interface RecoveryRootChange {
  readonly before: readonly string[];
  readonly after: readonly string[];
}

export interface RecoveryRootChanges {
  readonly accountId: string;
  readonly byteLimit: number;
  readonly changes: readonly RecoveryRootChange[];
  readonly verified: readonly DraftAuthorityVerifiedBlob[];
}

export interface AuthorizedRecoveryRoots {
  readonly accountId: string;
  readonly byteLimit: number;
  readonly digests: readonly string[];
}

type RecoveryBlobReadStores = {
  readonly blobs: Pick<DraftAuthorityRecoveryStores["blobs"], "read">;
  readonly refs: Pick<DraftAuthorityRecoveryStores["refs"], "read">;
};

interface RootCounts {
  before: number;
  after: number;
}

interface BlobReference {
  readonly count: number;
  readonly byteLength: number;
}

interface ResidentBlob {
  readonly blob: Blob;
  readonly count: number;
}

interface ReferenceChange {
  readonly key: BlobKey;
  readonly blob: Blob;
  readonly count: number;
  readonly previousCount: number;
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function checkScope(accountId: string, byteLimit: number): void {
  if (accountId.length === 0 || !isByteCount(byteLimit)) {
    throw new RecoveryBlobError("invalid");
  }
}

function checkDigest(digest: string): void {
  if (!SHA256_HEX.test(digest)) throw new RecoveryBlobError("invalid");
}

function countRoots(
  changes: readonly RecoveryRootChange[],
): ReadonlyMap<string, RootCounts> {
  const counts = new Map<string, RootCounts>();
  for (const change of changes) {
    for (const side of ["before", "after"] as const) {
      for (const digest of new Set(change[side])) {
        checkDigest(digest);
        const count = counts.get(digest) ?? { before: 0, after: 0 };
        count[side] += 1;
        counts.set(digest, count);
      }
    }
  }
  return counts;
}

function verifiedBlobsByDigest(
  verified: readonly DraftAuthorityVerifiedBlob[],
  roots: ReadonlyMap<string, RootCounts>,
): ReadonlyMap<string, Blob> {
  const blobs = new Map<string, Blob>();
  for (const { digest, blob } of verified) {
    const counts = roots.get(digest);
    if (
      counts === undefined ||
      counts.after === 0 ||
      !(blob instanceof Blob) ||
      blob.size === 0 ||
      blobs.has(digest)
    ) {
      throw new RecoveryBlobError("invalid");
    }
    blobs.set(digest, blob);
  }
  return blobs;
}

function isBlobReference(value: unknown): value is BlobReference {
  return (
    typeof value === "object" &&
    value !== null &&
    "count" in value &&
    isByteCount(value.count) &&
    value.count > 0 &&
    "byteLength" in value &&
    isByteCount(value.byteLength) &&
    value.byteLength > 0
  );
}

async function readResidentBlob(
  stores: RecoveryBlobReadStores,
  key: BlobKey,
): Promise<ResidentBlob | undefined> {
  const [blob, reference] = await Promise.all([
    stores.blobs.read(key),
    stores.refs.read(key),
  ]);
  if (blob === undefined && reference === undefined) return undefined;
  if (
    !(blob instanceof Blob) ||
    !isBlobReference(reference) ||
    blob.size !== reference.byteLength
  ) {
    throw new RecoveryBlobError("invalid");
  }
  return { blob, count: reference.count };
}

async function writeReferenceChange(
  stores: DraftAuthorityRecoveryStores,
  change: ReferenceChange,
): Promise<void> {
  const { key, blob, count, previousCount } = change;
  if (count === 0) {
    await stores.blobs.remove(key);
    await stores.refs.remove(key);
    return;
  }
  if (previousCount === 0) await stores.blobs.write(key, blob);
  const reference: BlobReference = { count, byteLength: blob.size };
  await stores.refs.write(key, reference);
}

/**
 * A derives each owner's root sets from the accepted durable records. This
 * runs in A's write transaction with all three stores enlisted. A must abort
 * the entire operation on rejection, including any slot or receipt writes.
 */
export async function applyRecoveryRoots(
  stores: DraftAuthorityRecoveryStores,
  input: RecoveryRootChanges,
): Promise<void> {
  const { accountId, byteLimit } = input;
  checkScope(accountId, byteLimit);
  const roots = countRoots(input.changes);
  const verified = verifiedBlobsByDigest(input.verified, roots);
  if (roots.size === 0) return;

  const storedBytes = await stores.budget.read(RESIDENT_BYTES_KEY);
  const residentBytes = storedBytes === undefined ? 0 : storedBytes;
  if (!isByteCount(residentBytes)) throw new RecoveryBlobError("invalid");

  const writes: ReferenceChange[] = [];
  let touchedResidentBytes = 0;
  let addedBytes = 0;
  let reclaimedBytes = 0;
  for (const [digest, { before, after }] of roots) {
    const key: BlobKey = [accountId, digest];
    const resident = await readResidentBlob(stores, key);
    if (resident !== undefined) touchedResidentBytes += resident.blob.size;
    const previousCount = resident?.count ?? 0;
    if (previousCount < before) {
      throw new RecoveryBlobError(
        resident === undefined ? "missing" : "invalid",
      );
    }
    const count = previousCount - before + after;
    if (count === previousCount) continue;
    if (!isByteCount(count)) throw new RecoveryBlobError("invalid");

    const blob = resident?.blob ?? verified.get(digest);
    if (blob === undefined) throw new RecoveryBlobError("missing");
    if (previousCount === 0) addedBytes += blob.size;
    if (count === 0) reclaimedBytes += blob.size;
    writes.push({ key, blob, count, previousCount });
  }

  if (touchedResidentBytes > residentBytes) {
    throw new RecoveryBlobError("invalid");
  }
  const nextBytes = residentBytes - reclaimedBytes + addedBytes;
  if (nextBytes > byteLimit) throw new RecoveryBlobError("budget");

  // Compute the final charge before writing so a replacement can use the bytes
  // it reclaims, regardless of the order of that owner's roots.
  await Promise.all(writes.map((write) => writeReferenceChange(stores, write)));
  if (nextBytes !== residentBytes) {
    await stores.budget.write(RESIDENT_BYTES_KEY, nextBytes);
  }
}

/**
 * A derives the account and digests from the authorized version read in this
 * same transaction. The returned Blobs remain usable after later reclamation.
 */
export async function readRecoveryBlobs(
  stores: RecoveryBlobReadStores,
  roots: AuthorizedRecoveryRoots,
): Promise<ReadonlyMap<string, Blob>> {
  const { accountId, byteLimit, digests } = roots;
  checkScope(accountId, byteLimit);
  const snapshot = new Map<string, Blob>();
  let bytes = 0;
  for (const digest of new Set(digests)) {
    checkDigest(digest);
    const resident = await readResidentBlob(stores, [accountId, digest]);
    if (resident === undefined) throw new RecoveryBlobError("missing");
    bytes += resident.blob.size;
    if (bytes > byteLimit) throw new RecoveryBlobError("budget");
    snapshot.set(digest, resident.blob);
  }
  return snapshot;
}
