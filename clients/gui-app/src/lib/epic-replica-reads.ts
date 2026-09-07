/**
 * Replica byte reads behind one async seam so a worker move changes this file, not every caller.
 * `getArtifactFragment` stays sync (Tiptap binds by reference); attachment presence stays sync (paste cannot await).
 */
import type * as Y from "yjs";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { ArtifactBodyRetention } from "@/stores/epics/open-epic/runtime/worker/artifact-body-lease-bridge";

/** A materialized artifact body, held for as long as the caller needs it. */
export interface ArtifactBodyHold {
  readonly fragment: Y.XmlFragment;
  release(): void;
}

/**
 * Raised when an artifact has no body this client can materialize: no such artifact, or a body that has not been served yet.
 */
export class ArtifactBodyUnavailableError extends Error {
  readonly artifactId: string;

  constructor(artifactId: string) {
    super(`The body for artifact ${artifactId} is not available`);
    this.name = "ArtifactBodyUnavailableError";
    this.artifactId = artifactId;
  }
}

/** Materializes an artifact's body and holds it until released. */
export async function holdArtifactBody(
  handle: OpenEpicStoreHandle,
  artifactId: string,
  /**
   * What this hold's release does with the body.
   * Callers that read once and move on (a bulk export) pass `"immediate"`, so the loop's sequential RETENTION is real rather than only its sequential materialization; a surface a human may return to passes `"linger"`.
   */
  retention: ArtifactBodyRetention,
): Promise<ArtifactBodyHold> {
  const state = handle.store.getState();
  let release: (() => void) | null = null;
  try {
    // AWAITED, and this is the `await` this module's header promised: the lease is a bridge call, so a fragment read in the same tick as the acquire reads a doc no grant has installed yet.
    const lease = state.acquireResidentArtifactBodyLease(artifactId, retention);
    release = lease.release;
    await lease.resident;
    const fragment = state.getArtifactFragment(artifactId);
    if (fragment === null) throw new ArtifactBodyUnavailableError(artifactId);
    return { fragment, release: onceOnly(release) };
  } catch (cause: unknown) {
    release?.();
    throw cause instanceof Error ? cause : new Error(String(cause));
  }
}

/**
 * Content-addressed attachment bytes, WAITING for the hash if it has not arrived yet.
 * `null` only when `signal` aborts.
 */
export async function readEpicAttachmentBytes(
  handle: OpenEpicStoreHandle,
  hash: string,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  // The WAITING member, which is a different call than the prompt read below
  return handle.store.getState().awaitAttachmentBytes(hash, signal);
}

/**
 * Content-addressed attachment bytes from what the replica ALREADY holds.
 * `null` immediately when it does not hold them.
 */
export async function readHeldEpicAttachmentBytes(
  handle: OpenEpicStoreHandle,
  hash: string,
): Promise<Uint8Array | null> {
  // ONE call now, exactly as this function's own comment predicted: "the worker answers `{ bytes: null }` for a hash it does not hold, and the presence predicate stops being a separate thing that can be forgotten." The guard moved INTO the worker, where it is.
  return handle.store.getState().readAttachmentBytes(hash);
}

function onceOnly(release: () => void): () => void {
  let live = true;
  return () => {
    if (!live) return;
    live = false;
    release();
  };
}
