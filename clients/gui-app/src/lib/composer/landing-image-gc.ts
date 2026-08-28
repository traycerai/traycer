/**
 * Garbage collection for the landing / new-epic composer's content-addressed
 * image bytes (`landing-image-store`). Reclaims IndexedDB bytes + session
 * entries that no draft references and runs the ready-gated startup orphan
 * sweep. Byte-budget ownership (the 64 MB cap, live-root/referenced-byte
 * accounting, and in-flight reservations) lives in `landing-image-budget.ts`;
 * this module only imports its live-root helper for the reconcile sweep below.
 *
 * This module runs OUTSIDE React render (store ops + GC), so it reads stores
 * imperatively via `getState()` at call time. It is consumer-driven: the draft
 * store, draft-runtime registry, paste hook, and submit path call into it on the
 * documented triggers (§6 of the tech plan).
 *
 * Two invariants drive the reconcile logic:
 *
 * - **[C2] Roots, never victims.** The set of referenced hashes is the union of
 *   every persisted draft's content AND every keyed live runtime. The session
 *   cache additionally protects the paste→insert window: a just-pasted hash has
 *   bytes in IndexedDB before its node lands in a runtime mirror, so it must not
 *   be IDB-deleted while it is still session-cached.
 * - **[C1] Ready-gated sweep.** `reconcile()` is a no-op until the draft set is
 *   known. On browser the draft store hydrates synchronously from localStorage;
 *   on desktop drafts arrive asynchronously over IPC (localStorage is disabled),
 *   so an ungated sweep at module load would see ZERO referenced hashes and
 *   delete every restored image's bytes moments before the drafts arrive.
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

// [B2] "The landing roots are trustworthy" gate for the DELETING sweep. On a
// fresh desktop renderer the session cache is empty and the FIRST desktop
// projection can be a spurious cold-start empty (a stale disk read, or a snapshot
// clobbered by registry churn); reconciling then — empty roots, empty session —
// would reap every restored image's bytes as an "orphan". Deletion is therefore
// withheld until EITHER a non-empty authoritative draft snapshot has been applied
// this session (roots definitely include real drafts) OR the live landing editor
// has mounted (its surface is gated on windows-bridge hydration, so the
// authoritative snapshot is in and the live-editor + draft roots are real).
// Browser is exempt: it hydrates the draft set synchronously from localStorage,
// so its first reconcile already has trustworthy roots.
let sawAuthoritativeNonEmptyDrafts = false;
let landingEditorMounted = false;

/**
 * Record that a non-empty authoritative draft snapshot has been applied this
 * session. Called by the draft store's desktop-projection path. Opens the [B2]
 * deletion gate: the reconcile's roots now provably reflect real drafts.
 */
export function markLandingDraftsAuthoritativeNonEmpty(): void {
  sawAuthoritativeNonEmptyDrafts = true;
}

/**
 * Record that the live landing editor has mounted (called once from
 * `LandingComposer`). Opens the [B2] deletion gate and kicks a reconcile so any
 * genuine orphans deferred while the gate was closed are reclaimed now that the
 * roots are trustworthy.
 */
export function markLandingEditorMounted(): void {
  if (landingEditorMounted) return;
  landingEditorMounted = true;
  // [B1] The editor mounting means the draft set is known, so satisfy readiness
  // even if an empty-inbound projection guard suppressed the projection's own
  // `markLandingDraftsReady` — otherwise reconcile would stay a no-op for this
  // renderer's whole lifetime. Idempotent when readiness already fired.
  markLandingDraftsReady();
  // Ready may already have been set (no-op above); run a sweep now that the
  // deletion gate is open so genuine orphans deferred while it was closed are
  // reclaimed.
  scheduleLandingImageReconcile();
}

/** Whether the [B2] deleting sweep is allowed to run (see the gate note above). */
function landingDeletionAllowed(): boolean {
  if (!isDesktopRuntime()) return true;
  return sawAuthoritativeNonEmptyDrafts || landingEditorMounted;
}

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
  const liveRoots = landingLiveImageRootHashes();
  const sessionKeys = sessionHashKeys();
  const protectedFromDelete = new Set(sessionKeys);
  const orphans = stored.filter(
    (hash) => !liveRoots.has(hash) && !protectedFromDelete.has(hash),
  );
  // [B2] Withhold the whole sweep while the roots are untrustworthy (cold-start
  // desktop): deleting would reap freshly-restored bytes, and there is nothing to
  // release either (the session is empty before the editor mounts). Once the gate
  // opens, `markLandingEditorMounted` re-runs the reconcile so genuine orphans are
  // still reaped.
  if (orphans.length > 0 && !landingDeletionAllowed()) return;
  await Promise.all(orphans.map((hash) => deleteImage(hash)));
  let releasedUnreferenced = false;
  for (const hash of sessionKeys) {
    if (!liveRoots.has(hash)) {
      releaseSession(hash);
      releasedUnreferenced = true;
    }
  }
  // A hash that was session-protected THIS sweep but is no longer referenced had
  // its bytes spared (the session is a delete-root) and its session just
  // released; only the NEXT sweep can reclaim those now-unprotected bytes. Kick
  // one so a partial-failure orphan (a successful sibling of a failed putImage)
  // is reclaimed promptly instead of lingering until an unrelated later sweep.
  // Terminates: the follow-up finds the hash session-free and deletes it,
  // releasing nothing new.
  if (releasedUnreferenced) scheduleLandingImageReconcile();
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
