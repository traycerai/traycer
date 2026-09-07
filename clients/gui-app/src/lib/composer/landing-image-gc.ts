/**
 * Garbage collection for the landing / new-epic composer's content-addressed image bytes (`landing-image-store`).
 * Reclaims IndexedDB bytes + session entries that no draft references and runs the ready-gated startup orphan sweep.
 */

import {
  deleteImage,
  imageHashKeys,
  releaseSession,
  sessionHashKeys,
} from "@/lib/composer/landing-image-store";
import { landingLiveImageRootHashes } from "@/lib/composer/landing-image-budget";
import { appLogger, describeLogError } from "@/lib/logger";

const RECONCILE_DEBOUNCE_MS = 250;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Desktop iff the preload-injected `runnerHost.windows` global is present (the same signal `landingImagePartition` keys off).
 * Reliable at module-eval time: preload runs before renderer scripts.
 */
function isDesktopRuntime(): boolean {
  const runnerHost: unknown = Reflect.get(globalThis, "runnerHost");
  return isRecord(runnerHost) && isRecord(runnerHost.windows);
}

// One-shot "the draft set is known" gate. Stays false until browser hydration
// or the first desktop projection flips it - see `markLandingDraftsReady`.
let draftsReady = false;

// [B2] "The landing roots are trustworthy" gate for the DELETING sweep.
// On a fresh desktop renderer the session cache is empty and the FIRST desktop projection can be a spurious cold-start empty (a stale disk read, or a snapshot clobbered by registry churn); reconciling then - empty roots, empty session - would reap every.
let sawAuthoritativeNonEmptyDrafts = false;
let landingEditorMounted = false;

/**
 * Record that a non-empty authoritative draft snapshot has been applied this session.
 * Called by the draft store's desktop-projection path.
 */
export function markLandingDraftsAuthoritativeNonEmpty(): void {
  sawAuthoritativeNonEmptyDrafts = true;
}

/**
 * Record that the live landing editor has mounted (called once from `LandingComposer`).
 * Opens the [B2] deletion gate and kicks a reconcile so any genuine orphans deferred while the gate was closed are reclaimed now that the roots are trustworthy.
 */
export function markLandingEditorMounted(): void {
  if (landingEditorMounted) return;
  landingEditorMounted = true;
  // [B1] The editor mounting means the draft set is known, so satisfy readiness even if an empty-inbound projection guard suppressed the projection's own `markLandingDraftsReady` - otherwise reconcile would stay a no-op for this renderer's whole lifetime.
  markLandingDraftsReady();
  // Ready may already have been set (no-op above); run a sweep now that the deletion gate is open so genuine orphans deferred while it was closed are reclaimed.
  scheduleLandingImageReconcile();
}

/** Whether the [B2] deleting sweep is allowed to run (see the gate note above). */
function landingDeletionAllowed(): boolean {
  if (!isDesktopRuntime()) return true;
  return sawAuthoritativeNonEmptyDrafts || landingEditorMounted;
}

/**
 * Flip the one-shot ready signal and run the startup orphan sweep.
 * Idempotent: later calls (e.g. subsequent desktop projections) are no-ops, so the sweep fires exactly once on the FIRST signal.
 */
export function markLandingDraftsReady(): void {
  if (draftsReady) return;
  draftsReady = true;
  // Fire-and-forget startup sweep - best-effort at this boundary.
  // A failure (no IndexedDB in the runtime, a transient DB error) just leaves orphans for the next trigger to reclaim; it must never surface as an unhandled rejection.
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

/**
 * Reclaim image bytes/session entries no longer referenced.
 * No-op until ready [C1].
 */
export async function reconcile(): Promise<void> {
  if (!draftsReady) return;
  // Read the persisted keys FIRST, then snapshot the roots.
  // Both root reads are synchronous, so capturing them AFTER the `await` means a paste that completed DURING the IndexedDB read - writing its bytes and (per `putImage`) seeding the session before that write - is reflected in `liveRoots`/`sessionKeys` and is.
  const stored = await imageHashKeys();
  const liveRoots = landingLiveImageRootHashes();
  const sessionKeys = sessionHashKeys();
  const protectedFromDelete = new Set(sessionKeys);
  const orphans = stored.filter(
    (hash) => !liveRoots.has(hash) && !protectedFromDelete.has(hash),
  );
  // [B2] Withhold the whole sweep while the roots are untrustworthy (cold-start desktop): deleting would reap freshly-restored bytes, and there is nothing to release either (the session is empty before the editor mounts).
  if (orphans.length > 0 && !landingDeletionAllowed()) return;
  await Promise.all(orphans.map((hash) => deleteImage(hash)));
  let releasedUnreferenced = false;
  for (const hash of sessionKeys) {
    if (!liveRoots.has(hash)) {
      releaseSession(hash);
      releasedUnreferenced = true;
    }
  }
  // A hash that was session-protected THIS sweep but is no longer referenced had its bytes spared (the session is a delete-root) and its session just released; only the NEXT sweep can reclaim those now-unprotected bytes.
  if (releasedUnreferenced) scheduleLandingImageReconcile();
}

let reconcileTimer: Parameters<typeof clearTimeout>[0] | null = null;

/**
 * Debounced reconcile for the high-frequency triggers (draft close, in-editor image remove, submit).
 * Coalesces bursts into a single sweep.
 */
export function scheduleLandingImageReconcile(): void {
  if (reconcileTimer !== null) clearTimeout(reconcileTimer);
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    void reconcile();
  }, RECONCILE_DEBOUNCE_MS);
}

// Browser becomes ready once the draft store has hydrated synchronously from localStorage.
// That hydration has completed by the time this module finishes evaluating (this module imports the draft store, so its `create(persist(...))` runs as part of resolving these imports).
if (!isDesktopRuntime()) {
  queueMicrotask(markLandingDraftsReady);
}
