/**
 * Canonical owner of landing-composer image capacity: the byte budget, live-root
 * / measured-referenced-byte accounting, and the in-flight reservation ledger.
 * Both normal landing paste (`use-landing-composer-paste.ts`,
 * `landing-composer.tsx`) and prompt-stash import (`landing-stash-import.ts`)
 * admit work through the single `reserveLandingImageBudget` below - there is no
 * second budget authority.
 *
 * `landing-image-gc.ts` imports `landingLiveImageRootHashes` from here for its
 * own orphan-reconcile sweep; this module never touches storage or deletion
 * itself, only admission math.
 *
 * A candidate's `hash` is `null` when the caller hasn't computed one yet (paste
 * hashes bytes only as part of writing them via `putImage`). An unhashed
 * candidate can never be recognized as already-live or as overlapping another
 * reservation - it always gets its own ledger slot - so it costs exactly its
 * own bytes, same as before this consolidation. A hashed candidate (stash
 * import, which resolves bytes - and therefore hashes - before writing) is
 * deduped against current live roots and against every other outstanding
 * reservation for that same hash.
 *
 * This module deliberately has NO static import of `landing-draft-store.ts`.
 * That store imports `landing-image-gc.ts`, which imports this module for
 * `landingLiveImageRootHashes` - a static import back to the store here would
 * close a cycle (store → gc → budget → store) and risk a temporal-dead-zone
 * read of the store binding during startup reconcile. Instead
 * `landing-draft-store.ts` calls `registerLandingDraftRootSource` once, right
 * after its own store is constructed (mirroring how that same file wires
 * `draftRuntimeRegistry.configure` for the same reason). Before that
 * registration happens - e.g. a test that imports only this module - every
 * draft-derived read below is empty/zero: safe and deterministic, never a
 * crash or a read against a partially-initialized store.
 */
import type { JsonContent } from "@traycer/protocol/common/registry";

import { collectImageAtoms } from "@/lib/composer/image-atoms";
import type { LandingDraftTab } from "@/stores/home/landing-draft-store";
import { draftRuntimeRegistry } from "@/stores/home/draft-runtime-registry";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

export interface LandingDraftRootSource {
  /** Every currently persisted landing draft in this window, read live. */
  drafts(): ReadonlyArray<LandingDraftTab>;
}

let draftRootSource: LandingDraftRootSource | null = null;

/**
 * Installs the live draft reader. Called exactly once, by
 * `landing-draft-store.ts` immediately after `useLandingDraftStore` is
 * constructed. See the module doc for why this is a registration rather than
 * a static import.
 */
export function registerLandingDraftRootSource(
  source: LandingDraftRootSource,
): void {
  draftRootSource = source;
}

/**
 * Extra content hashes that must survive landing GC: chat-composer annotation
 * crops (hash + filename on the draft record, not present in landing draft
 * content) and the images referenced by composer / new-chat / stash rows,
 * which live in this same partition.
 */
export interface ExtraImageRootSource {
  hashes(): ReadonlyArray<string>;
}

const extraRootSources: ExtraImageRootSource[] = [];

export function registerExtraImageRootSource(
  source: ExtraImageRootSource,
): void {
  extraRootSources.push(source);
}

/**
 * A holder that keeps whole DOCUMENTS, contributing to both halves of the
 * accounting: its images are GC roots AND their bytes count against the
 * budget.
 *
 * The split from {@link ExtraImageRootSource} is exactly the split between
 * what a holder knows. A bare hash - an annotation crop, a stash row, a
 * hash set held across one upload - carries no size, so it can root bytes
 * but cannot price them. A document carries `size` on the node, so it can do
 * both, and a holder that could do both while only rooting was the W-6 hole:
 * the composer admitted image after image against a usage figure that only
 * ever counted landing drafts, so eighteen sequential 3.75 MiB pastes into a
 * chat composer each saw zero prior usage and sailed past a 64 MiB cap.
 *
 * Register a document holder HERE, never as a root source, or its bytes go
 * uncounted again.
 */
export interface ExtraImageContentSource {
  contents(): ReadonlyArray<JsonContent>;
}

const extraContentSources: ExtraImageContentSource[] = [];

export function registerExtraImageContentSource(
  source: ExtraImageContentSource,
): void {
  extraContentSources.push(source);
}

/**
 * The same registration for a document holder whose lifetime is SHORTER than
 * the module's - a mounted component's state.
 *
 * {@link registerExtraImageContentSource} is push-only because every caller is
 * a module singleton reading a store that outlives everything. A holder that
 * can go away needs the other half, or its root outlives the bytes' last
 * reader and the store never reclaims them - and its bytes stay charged
 * against a budget nothing is using. Call the returned function when the
 * holder releases; it is idempotent.
 *
 * Releasing is the UNMOUNT, not the emptying: a holder that is still mounted
 * with nothing to contribute returns `[]` from `contents()` and stays
 * registered. That is what an inline edit does on Escape - the tile does not
 * unmount, its `currentContent` goes to null - so both halves have to work.
 */
export function registerReleasableImageContentSource(
  source: ExtraImageContentSource,
): () => void {
  extraContentSources.push(source);
  return () => {
    const at = extraContentSources.indexOf(source);
    if (at === -1) return;
    extraContentSources.splice(at, 1);
  };
}

function extraSourceContents(): ReadonlyArray<JsonContent> {
  const contents: JsonContent[] = [];
  for (const source of extraContentSources) contents.push(...source.contents());
  return contents;
}

/**
 * Roots a fixed set of hashes for the duration of one asynchronous pass - the
 * shape a holder takes when it is neither a store field nor component state,
 * but a promise in flight.
 *
 * Refcounted, because two passes can legitimately hold the same hash: the
 * release only drops THIS call's share, exactly like a budget reservation, so
 * an early finisher cannot unroot bytes a slower overlapping pass still needs.
 */
const heldHashCounts = new Map<string, number>();

registerExtraImageRootSource({ hashes: () => [...heldHashCounts.keys()] });

export function holdImageHashes(hashes: ReadonlyArray<string>): () => void {
  // Snapshot and dedupe: the release must decrement exactly what it
  // incremented, whatever the caller does to its array afterwards.
  const held = [...new Set(hashes)];
  for (const hash of held) {
    heldHashCounts.set(hash, (heldHashCounts.get(hash) ?? 0) + 1);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const hash of held) {
      const count = heldHashCounts.get(hash) ?? 0;
      if (count <= 1) {
        heldHashCounts.delete(hash);
        continue;
      }
      heldHashCounts.set(hash, count - 1);
    }
  };
}

function currentDrafts(): ReadonlyArray<LandingDraftTab> {
  return draftRootSource?.drafts() ?? [];
}

/**
 * Per-partition byte budget for stored landing images. Flagged TUNABLE - shipped
 * at 64 MB (≈ 12× the 5 MB per-image cap). Per-runtime partitioning already
 * isolates this to the current window, so the budget is scoped to this window's
 * drafts; there is no cross-window accounting.
 */
export const LANDING_IMAGE_BUDGET_BYTES = 64 * 1024 * 1024;

export interface LandingImageBudgetCandidate {
  /**
   * Canonical content hash, or `null` when unknown at reservation time. See
   * the module doc for what `null` means for admission.
   */
  readonly hash: string | null;
  readonly bytes: number;
}

/** Opaque handle on an admitted reservation. `release` is idempotent. */
export interface LandingImageBudgetReservation {
  /**
   * Releases this call's share of every candidate it was charged for. A
   * second call is a no-op - it can never decrement another reservation's
   * share, including one for the same hash held by an overlapping caller.
   */
  release(): void;
}

function imageHashesOf(content: JsonContent): Set<string> {
  const hashes = new Set<string>();
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash !== null) hashes.add(atom.hash);
  }
  return hashes;
}

/**
 * Every hash that must NOT be collected: union of all persisted drafts'
 * content and every keyed live runtime. Exposed (read-only) for
 * `landing-image-gc.ts`'s orphan-reconcile sweep and used internally here to
 * skip charging a reservation candidate that is already live.
 */
export function landingLiveImageRootHashes(): Set<string> {
  const roots = new Set<string>();
  for (const draft of currentDrafts()) {
    for (const hash of imageHashesOf(draft.content)) roots.add(hash);
  }
  for (const hash of draftRuntimeRegistry.liveImageRoots()) roots.add(hash);
  for (const source of extraRootSources) {
    for (const hash of source.hashes()) roots.add(hash);
  }
  for (const content of extraSourceContents()) {
    for (const hash of imageHashesOf(content)) roots.add(hash);
  }
  return roots;
}

function referencedImageBytes(drafts: ReadonlyArray<LandingDraftTab>): number {
  // Bytes are content-addressed: a hash present in N drafts occupies the store
  // ONCE, so dedupe by hash before summing - counting it per-draft would evict or
  // block too eagerly. Base64-only atoms (no hash) aren't in the store; skip them.
  // A node with no `size` attr - only a 0-byte file yields that - counts as 0; the
  // per-image 5 MB paste cap bounds the untracked slack, so the soft budget stays
  // meaningful.
  const sizeByHash = new Map<string, number>();
  for (const draft of drafts) {
    for (const atom of collectImageAtoms(draft.content)) {
      if (atom.hash === null) continue;
      if (!sizeByHash.has(atom.hash)) sizeByHash.set(atom.hash, atom.size ?? 0);
    }
  }
  for (const content of draftRuntimeRegistry.liveContents()) {
    for (const atom of collectImageAtoms(content)) {
      if (atom.hash === null) continue;
      if (!sizeByHash.has(atom.hash)) sizeByHash.set(atom.hash, atom.size ?? 0);
    }
  }
  // Every non-landing holder of a document: the chat/modal composer drafts, an
  // open inline edit, a pending or refused send, a queued prompt, a pending
  // handoff. Same dedupe by hash as the two loops above, and for the same
  // reason - these holders overlap each other constantly (a send's restore and
  // its pending row are the same document twice over).
  for (const content of extraSourceContents()) {
    for (const atom of collectImageAtoms(content)) {
      if (atom.hash === null) continue;
      if (!sizeByHash.has(atom.hash)) sizeByHash.set(atom.hash, atom.size ?? 0);
    }
  }
  let total = 0;
  for (const size of sizeByHash.values()) total += size;
  return total;
}

function currentReferencedBytes(): number {
  return referencedImageBytes(currentDrafts());
}

interface LedgerEntry {
  readonly bytes: number;
  refCount: number;
}

/**
 * In-flight reservation ledger, keyed by content hash for hash-aware
 * candidates or a fresh synthetic key per call for unhashed ones. Module-level
 * singleton state, mirroring `composer-image-store.ts`'s session cache: this is
 * process-local contention hygiene, not a durability boundary. It never
 * persists and is rebuilt as empty on reload.
 */
const inFlight = new Map<string, LedgerEntry>();

let anonymousReservationSeq = 0;

/** A fresh key for a candidate with no hash - never dedupes against anything. */
function nextAnonymousKey(): string {
  anonymousReservationSeq += 1;
  return `landing-image-budget:anon:${anonymousReservationSeq}`;
}

function inFlightBytes(): number {
  let total = 0;
  for (const entry of inFlight.values()) total += entry.bytes;
  return total;
}

function showBudgetExceededToast(draftId: string | null): void {
  reportableErrorToast(
    "Couldn't add the image.",
    {
      description:
        draftId === null
          ? "Create a draft or remove images before trying again."
          : "Remove images or close a draft yourself, then try again.",
    },
    {
      title: "Could not add image",
      message: "The image storage budget was exceeded.",
      code: null,
      source: "Chat composer",
    },
  );
}

/**
 * Reserves capacity for every candidate, charged against current live usage
 * PLUS every other outstanding reservation. A candidate whose hash is already
 * a live root costs nothing. A candidate whose hash matches another
 * outstanding reservation (or another candidate in THIS same call) is
 * refcounted onto one ledger entry rather than double-charged - overlapping
 * reservations for the same hash reserve its bytes once. A candidate with no
 * hash always gets its own ledger slot and can never be deduped. All-or-
 * nothing: on rejection nothing is reserved and the shared budget-exceeded
 * toast is shown.
 *
 * Returns `null` when combined usage would exceed the cap. Otherwise returns
 * an opaque reservation; the caller must call `release()` on it exactly once,
 * after it either commits the reserved content or discovers it will not be
 * committed (rejected, stale destination, or a thrown write).
 */
export function reserveLandingImageBudget(
  draftId: string | null,
  candidates: ReadonlyArray<LandingImageBudgetCandidate>,
): LandingImageBudgetReservation | null {
  const reservation = tryReserveLandingImageBudget(candidates);
  if (reservation === null) showBudgetExceededToast(draftId);
  return reservation;
}

/** Silent admission for callers that provide their own retryable failure UI.
 * Admission never deletes drafts or recovery history, including on rejection.
 */
export function tryReserveLandingImageBudget(
  candidates: ReadonlyArray<LandingImageBudgetCandidate>,
): LandingImageBudgetReservation | null {
  const liveRoots = landingLiveImageRootHashes();
  const owned: Array<{ readonly key: string; readonly bytes: number }> = [];
  const seenThisCall = new Set<string>();
  let additionalBytes = 0;
  for (const candidate of candidates) {
    if (candidate.hash !== null && liveRoots.has(candidate.hash)) continue;
    const key = candidate.hash ?? nextAnonymousKey();
    owned.push({ key, bytes: candidate.bytes });
    if (!inFlight.has(key) && !seenThisCall.has(key)) {
      additionalBytes += candidate.bytes;
    }
    seenThisCall.add(key);
  }

  if (additionalBytes > 0) {
    const projected =
      currentReferencedBytes() + inFlightBytes() + additionalBytes;
    if (projected > LANDING_IMAGE_BUDGET_BYTES) {
      return null;
    }
  }

  for (const { key, bytes } of owned) {
    const existing = inFlight.get(key);
    if (existing === undefined) {
      inFlight.set(key, { bytes, refCount: 1 });
    } else {
      existing.refCount += 1;
    }
  }

  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      for (const { key } of owned) {
        const existing = inFlight.get(key);
        if (existing === undefined) continue;
        existing.refCount -= 1;
        if (existing.refCount <= 0) inFlight.delete(key);
      }
    },
  };
}

export function resetLandingImageBudgetReservationsForTesting(): void {
  inFlight.clear();
  anonymousReservationSeq = 0;
}
