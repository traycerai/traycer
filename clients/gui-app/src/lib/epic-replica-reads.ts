/**
 * The reads that cross the worker boundary, behind one asynchronous seam.
 *
 * Every read of replica-held BYTES in this app goes through here. That is the
 * whole purpose of the module: when the runtime moves into its worker, the doc
 * those reads resolve against is on the other side of a `postMessage`, and a
 * synchronous accessor has no answer to give. Collecting them now - while the
 * data is still local and the answers are still trivially available - turns
 * the relocation into a change to THIS file rather than a change to every
 * caller of it.
 *
 * The call sites are async-shaped from today, which is the point. An `await`
 * added later is a change to control flow (a mutation that used to fail
 * before its first side effect can now fail after one); an `await` added now,
 * against a fast local read, is the same control flow the worker version will
 * have, exercised by the same tests.
 *
 * ## What is NOT here, and why
 *
 * `getArtifactFragment` stays synchronous, and stays exposed by the store.
 * Tiptap and y-prosemirror bind a `Y.XmlFragment` BY REFERENCE, synchronously,
 * at editor construction - so open artifact bodies remain main-thread objects
 * behind the lease, by design and not by omission. What becomes asynchronous
 * is MATERIALIZING one, which is what {@link holdArtifactBody} expresses: take
 * the lease first, await RESIDENCY, then read the fragment the lease
 * guarantees. That await was described here before it existed - the function
 * took the lease and read in the same tick, which is the one ordering this
 * paragraph rules out.
 *
 * The synchronous attachment PRESENCE predicate
 * (`useEpicAttachmentBytesPresence`) is also still on the store, and is the
 * one member of this class that cannot become a promise: it is read inside a
 * ProseMirror paste handler, which decides synchronously whether to accept a
 * paste and cannot await. It is answered from a projected set of held hashes
 * rather than from a live doc read when the runtime moves - a projection, not
 * a call. Recorded here because the two are one class and the reader of this
 * file will look for the third member.
 */
import type * as Y from "yjs";
import type { OpenEpicStoreHandle } from "@/stores/epics/open-epic/store";
import type { ArtifactBodyRetention } from "@/stores/epics/open-epic/runtime/worker/artifact-body-lease-bridge";

/**
 * A materialized artifact body, held for as long as the caller needs it.
 *
 * Releasing is idempotent, because the two paths that release - the success
 * path releasing early, and a `finally` backstop - both legitimately run.
 */
export interface ArtifactBodyHold {
  readonly fragment: Y.XmlFragment;
  release(): void;
}

/**
 * Raised when an artifact has no body this client can materialize: no such
 * artifact, or a body that has not been served yet.
 *
 * Named rather than a bare `Error` so callers can render their own copy for
 * "still loading" without matching on a message string.
 */
export class ArtifactBodyUnavailableError extends Error {
  readonly artifactId: string;

  constructor(artifactId: string) {
    super(`The body for artifact ${artifactId} is not available`);
    this.name = "ArtifactBodyUnavailableError";
    this.artifactId = artifactId;
  }
}

/**
 * Materializes an artifact's body and holds it until released.
 *
 * The lease is taken FIRST and released on every failure path, including the
 * one where the fragment turns out to be unavailable. A lease leaked by an
 * early return is invisible - the room simply never cools - so the ordering
 * here is the contract, not a style choice.
 */
export async function holdArtifactBody(
  handle: OpenEpicStoreHandle,
  artifactId: string,
  /**
   * What this hold's release does with the body. Callers that read once and
   * move on (a bulk export) pass `"immediate"`, so the loop's sequential
   * RETENTION is real rather than only its sequential materialization; a
   * surface a human may return to passes `"linger"`.
   */
  retention: ArtifactBodyRetention,
): Promise<ArtifactBodyHold> {
  const state = handle.store.getState();
  let release: (() => void) | null = null;
  try {
    // AWAITED, and this is the `await` this module's header promised: the
    // lease is a bridge call, so a fragment read in the same tick as the
    // acquire reads a doc no grant has installed yet. On the lane arm's
    // ordinary cold open that is the NORMAL path - the grant resolves
    // `"awaiting-seed"` with no bytes and the install lands milliseconds
    // later - so the same-tick read reported "still loading" for a body that
    // was on its way. `resident` rejects for the one grant that owes nothing,
    // so an artifact this client genuinely cannot be served still fails fast
    // rather than parking the caller.
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
 * Content-addressed attachment bytes, WAITING for the hash if it has not
 * arrived yet. `null` only when `signal` aborts.
 *
 * This is the artifact-image contract and the waiting is the feature, not an
 * oversight: an artifact is epic-shared by nature, so doc replication IS its
 * access model, and an image referenced by an artifact whose bytes are still
 * replicating resolves when they land - across replica swaps included. The
 * render layer shows "unavailable" after its own grace window while this
 * acquisition stays live underneath, so bytes arriving late still paint.
 *
 * Guarding this with a presence check would turn "still syncing" into
 * "missing" for exactly the images the design expects to be late.
 */
export async function readEpicAttachmentBytes(
  handle: OpenEpicStoreHandle,
  hash: string,
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  // The WAITING member, which is a different call than the prompt read below
  // - `attachment/await` rather than `attachment/read`. They were briefly the
  // same store member, which silently made this leg answer `null` for an
  // image still replicating: the exact "still syncing becomes missing" this
  // function's header exists to prevent.
  return handle.store.getState().awaitAttachmentBytes(hash, signal);
}

/**
 * Content-addressed attachment bytes from what the replica ALREADY holds.
 * `null` immediately when it does not hold them.
 *
 * The other contract, and the distinction is load-bearing rather than a
 * convenience: this is the legacy leg of the CHAT byte chain, where a hash the
 * epic doc never held belongs to a different leg entirely (the host's chat
 * attachment read). Waiting here parks the chain forever on the case the other
 * leg is supposed to own, and the blob cache never retries the leg that could
 * have succeeded.
 *
 * ONE call, as of the relocation. It was two reads - a synchronous presence
 * check and then the read it guarded - because that was the only way to
 * express "do not wait" against a store whose read had no such mode. The
 * worker now answers `{ bytes: null }` for a hash it does not hold, so the
 * presence predicate stopped being a separate thing that can be forgotten.
 * That collapse is why both live behind this seam rather than at their call
 * sites - and it applies to THIS leg only. The waiting leg above still waits;
 * collapsing that one is the regression this file's header names.
 *
 * **Do not merge this with {@link readEpicAttachmentBytes}.** They look like
 * one function with a flag and they are not: collapsing them is a regression
 * one way and a hang the other. Guarding the artifact-image path turns "still
 * replicating" into "missing" for exactly the images that are expected to be
 * late; dropping the guard here parks the chat chain forever on a hash the
 * epic doc never held and never will, so the host leg that could have served
 * it is never retried.
 */
export async function readHeldEpicAttachmentBytes(
  handle: OpenEpicStoreHandle,
  hash: string,
): Promise<Uint8Array | null> {
  // ONE call now, exactly as this function's own comment predicted: "the
  // worker answers `{ bytes: null }` for a hash it does not hold, and the
  // presence predicate stops being a separate thing that can be forgotten."
  // The guard moved INTO the worker, where it is a local synchronous read
  // ahead of a read that would otherwise wait.
  //
  // No `signal` either: there is nothing to abort. The waiting is what a
  // signal bounded, and this leg does not wait.
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
