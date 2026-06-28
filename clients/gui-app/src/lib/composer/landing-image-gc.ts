/**
 * Garbage collection for the landing / new-epic composer's content-addressed
 * image bytes (`landing-image-store`). Reclaims IndexedDB bytes + session
 * entries that no draft references, runs the ready-gated startup orphan sweep,
 * and enforces a per-partition byte budget on paste.
 *
 * This module runs OUTSIDE React render (store ops + GC), so it reads stores
 * imperatively via `getState()` at call time. It is consumer-driven: the draft
 * store, composer store, paste hook, and submit path call into it on the
 * documented triggers (§6 of the tech plan).
 *
 * Two invariants drive the reconcile logic:
 *
 * - **[C2] Roots, never victims.** The set of referenced hashes is the union of
 *   every persisted draft's content AND the live editor mirror. The session
 *   cache additionally protects the paste→insert window: a just-pasted hash has
 *   bytes in IndexedDB before its node lands in `currentContent`, so it must not
 *   be IDB-deleted while it is still session-cached.
 * - **[C1] Ready-gated sweep.** `reconcile()` is a no-op until the draft set is
 *   known. On browser the draft store hydrates synchronously from localStorage;
 *   on desktop drafts arrive asynchronously over IPC (localStorage is disabled),
 *   so an ungated sweep at module load would see ZERO referenced hashes and
 *   delete every restored image's bytes moments before the drafts arrive.
 */

import { toast } from "sonner";

import type { JsonContent } from "@traycer/protocol/common/registry";

import { collectImageAtoms } from "@/lib/composer/image-atoms";
import {
  deleteImage,
  imageHashKeys,
  releaseSession,
  sessionHashKeys,
} from "@/lib/composer/landing-image-store";
import {
  useLandingDraftStore,
  type LandingDraftTab,
} from "@/stores/home/landing-draft-store";
import { landingComposerLiveImageHashes } from "@/stores/composer/landing-composer-store";
import { appLogger, describeLogError } from "@/lib/logger";

/**
 * Per-partition byte budget for stored landing images. Flagged TUNABLE — shipped
 * at 64 MB (≈ 12× the 5 MB per-image cap). Per-runtime partitioning already
 * isolates this to the current window, so the budget is scoped to this window's
 * drafts; there is no cross-window accounting.
 */
export const LANDING_IMAGE_BUDGET_BYTES = 64 * 1024 * 1024;

const RECONCILE_DEBOUNCE_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Desktop iff the preload-injected `runnerHost.windows` global is present (the
 * same signal `landingImagePartition` keys off). Reliable at module-eval time:
 * preload runs before renderer scripts. Browser has no such global.
 */
function isDesktopRuntime(): boolean {
  const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
  return isRecord(runnerHost) && isRecord(runnerHost.windows);
}

// One-shot "the draft set is known" gate. Stays false until browser hydration
// or the first desktop projection flips it — see `markLandingDraftsReady`.
let draftsReady = false;

/**
 * Flip the one-shot ready signal and run the startup orphan sweep. Idempotent:
 * later calls (e.g. subsequent desktop projections) are no-ops, so the sweep
 * fires exactly once on the FIRST signal. Browser calls this after synchronous
 * hydration; desktop calls it from the first inbound projection.
 */
export function markLandingDraftsReady(): void {
  if (draftsReady) return;
  draftsReady = true;
  // Fire-and-forget startup sweep — best-effort at this boundary. A failure (no
  // IndexedDB in the runtime, a transient DB error) just leaves orphans for the
  // next trigger to reclaim; it must never surface as an unhandled rejection.
  void reconcile().catch((error: unknown) => {
    appLogger.warn("[landing-image-gc] startup reconcile failed", {
      error: describeLogError(error),
    });
  });
}

/** Whether the draft set is known and reconcile is allowed to delete. */
export function landingDraftsReady(): boolean {
  return draftsReady;
}

function imageHashesOf(content: JsonContent): Set<string> {
  const hashes = new Set<string>();
  for (const atom of collectImageAtoms(content)) {
    if (atom.hash !== null) hashes.add(atom.hash);
  }
  return hashes;
}

/**
 * Every hash that must NOT be collected: union of all persisted drafts' content
 * and the live editor mirror. The session cache is handled separately (it
 * protects the paste→insert window but its entries are reclaimed once a hash
 * leaves the live roots).
 */
function computeLiveRoots(): Set<string> {
  const roots = new Set<string>();
  for (const draft of useLandingDraftStore.getState().drafts) {
    for (const hash of imageHashesOf(draft.content)) roots.add(hash);
  }
  for (const hash of landingComposerLiveImageHashes()) roots.add(hash);
  return roots;
}

/**
 * Reclaim image bytes/session entries no longer referenced. No-op until ready
 * [C1]. IDB orphans exclude both the live roots and the current session keys —
 * the session is a delete-root that protects a just-pasted, not-yet-inserted
 * hash [C2]. Session entries that have left the live roots are released, so a
 * close/submit promptly frees the object-URL; their (now session-free) bytes are
 * reclaimed by the next sweep (or the cold-start sweep, where the session is
 * empty and every unreferenced byte is collected in one pass).
 */
export async function reconcile(): Promise<void> {
  if (!draftsReady) return;
  // Read the persisted keys FIRST, then snapshot the roots. Both root reads are
  // synchronous, so capturing them AFTER the `await` means a paste that completed
  // DURING the IndexedDB read — writing its bytes and (per `putImage`) seeding the
  // session before that write — is reflected in `liveRoots`/`sessionKeys` and is
  // not mistaken for an orphan and deleted. [C2: the paste↔reconcile-await race]
  const stored = await imageHashKeys();
  const liveRoots = computeLiveRoots();
  const sessionKeys = sessionHashKeys();
  const protectedFromDelete = new Set(sessionKeys);
  const orphans = stored.filter(
    (hash) => !liveRoots.has(hash) && !protectedFromDelete.has(hash),
  );
  await Promise.all(orphans.map((hash) => deleteImage(hash)));
  for (const hash of sessionKeys) {
    if (!liveRoots.has(hash)) releaseSession(hash);
  }
}

let reconcileTimer: Parameters<typeof clearTimeout>[0] | null = null;

/**
 * Debounced reconcile for the high-frequency triggers (draft close, in-editor
 * image remove, submit). Coalesces bursts into a single sweep.
 */
export function scheduleLandingImageReconcile(): void {
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcile();
  }, RECONCILE_DEBOUNCE_MS);
}

function referencedImageBytes(drafts: ReadonlyArray<LandingDraftTab>): number {
  // Bytes are content-addressed: a hash present in N drafts occupies the store
  // ONCE, so dedupe by hash before summing — counting it per-draft would evict or
  // block too eagerly. Base64-only atoms (no hash) aren't in the store; skip them.
  // A node with no `size` attr — only a 0-byte file yields that — counts as 0; the
  // per-image 5 MB paste cap bounds the untracked slack, so the soft budget stays
  // meaningful.
  const sizeByHash = new Map<string, number>();
  for (const draft of drafts) {
    for (const atom of collectImageAtoms(draft.content)) {
      if (atom.hash === null) continue;
      if (!sizeByHash.has(atom.hash)) sizeByHash.set(atom.hash, atom.size ?? 0);
    }
  }
  let total = 0;
  for (const size of sizeByHash.values()) total += size;
  return total;
}

/**
 * Drop a draft and reclaim the image bytes it solely referenced. The evicted
 * draft is an intentional discard, so its hashes ARE deleted from IndexedDB (and
 * their session entries released) even though they were session-cached — unless
 * another remaining draft / the live editor still references them.
 */
function evictLandingDraftImages(draft: LandingDraftTab): void {
  useLandingDraftStore.getState().closeDraft(draft.id);
  const remainingRoots = computeLiveRoots();
  for (const hash of imageHashesOf(draft.content)) {
    if (remainingRoots.has(hash)) continue;
    void deleteImage(hash);
    releaseSession(hash);
  }
}

/**
 * Reserve budget for a paste of `incomingBytes`. Returns whether the paste may
 * proceed. When the current referenced bytes + the incoming bytes would exceed
 * the budget, evict the oldest drafts by `lastTouchedAt` — EXCLUDING the active
 * draft — until back under budget, toasting each eviction. If only the active
 * draft remains and its own paste still exceeds the budget, the paste is blocked
 * with a toast (return false).
 */
export function reserveLandingImageBudget(incomingBytes: number): boolean {
  const { drafts, activeDraftId } = useLandingDraftStore.getState();
  let referenced = referencedImageBytes(drafts);
  if (referenced + incomingBytes <= LANDING_IMAGE_BUDGET_BYTES) return true;

  // With no active draft, this paste is not attributed to any existing draft, so
  // `draft.id !== activeDraftId` would exclude NOTHING and the eviction below
  // would destroy unrelated in-progress drafts to make room for it. Block the
  // paste instead — we never evict user drafts for an unattributed paste.
  if (activeDraftId === null) {
    toast.error("Couldn't add the image.", {
      description: "It would exceed this window's image storage budget.",
    });
    return false;
  }

  const evictable = drafts
    .filter((draft) => draft.id !== activeDraftId)
    .sort((a, b) => a.lastTouchedAt - b.lastTouchedAt);

  for (const draft of evictable) {
    if (referenced + incomingBytes <= LANDING_IMAGE_BUDGET_BYTES) break;
    evictLandingDraftImages(draft);
    toast.info("Cleared an older draft to free up image space.");
    referenced = referencedImageBytes(useLandingDraftStore.getState().drafts);
  }

  if (referenced + incomingBytes <= LANDING_IMAGE_BUDGET_BYTES) return true;

  toast.error("Couldn't add the image.", {
    description: "It would exceed this window's image storage budget.",
  });
  return false;
}

// Browser becomes ready once the draft store has hydrated synchronously from
// localStorage. That hydration has completed by the time this module finishes
// evaluating (this module imports the draft store, so its `create(persist(...))`
// runs as part of resolving these imports). Deferring to a microtask keeps two
// things safe: `draftsReady` above is fully initialized before the gate flips,
// and — since the draft store imports this module back — we never make an
// eval-time cross-module call that could hit a temporal-dead-zone read. Desktop
// is excluded here and instead readies on the first inbound projection: an
// ungated sweep there would see an empty draft set (drafts arrive async over
// IPC) and delete every restored image's bytes. [C1]
if (!isDesktopRuntime()) {
  queueMicrotask(markLandingDraftsReady);
}
