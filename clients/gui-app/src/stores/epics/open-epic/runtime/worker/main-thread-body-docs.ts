/**
 * {@link MainThreadBodyDocs} that actually owns the documents — owed #3, the
 * hot half of the hot/cold split.
 *
 * `tier-body-docs.ts` is the other implementation and it is scaffolding with a
 * known expiry, which its own header says: in-process it round-trips through
 * ONE object, so bytes leave the tier through `encodeColdState` and come back
 * into the same tier through `install`. That exercises the LIFECYCLE and not
 * the split, because in-process there is no split. This is the destination:
 * the tier becomes cold-only and these docs are the only live copies.
 *
 * Everything here is deliberately keyed by `docKey` and knows nothing about
 * leases, generations or demote state - the lease bridge owns all of that and
 * is free of `yjs` precisely so the two can be tested apart.
 *
 * **The seed rule is the dangerous part.** A `"full"` snapshot whose `docGuid`
 * DIFFERS from what is installed REPLACES the document; it is never applied on
 * top. A body that was deleted and recreated shares no ancestor with what is
 * held, and merging two unrelated Yjs histories is unrecoverable rather than
 * lossy - the result is a document containing both, which no user action can
 * undo. Same guid means same lineage, and Yjs merges those idempotently, so
 * applying is correct there whether the bytes are a snapshot or a delta.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";

import type { MainThreadBodyDocs } from "./artifact-body-lease-bridge";

/**
 * The origin every byte this store applies ON BEHALF OF THE WORKER carries.
 *
 * Module-private and never exported: its whole purpose is that no other
 * module can produce it, so "did this change come from the editor?" is
 * answerable here by identity rather than by convention.
 *
 * It does DOUBLE DUTY, and missing either half breaks a different thing:
 *  - `installRemote`/`applyRemote`, so a collaborator's edit arriving from the
 *    worker is not observed as local and sent straight back out - an echo the
 *    far end would apply as a no-op, but which loops for as long as two peers
 *    are typing;
 *  - the initial SEED in `install`, which is the half that looks unnecessary.
 *    Without it, materializing a body emits its entire contents as a local
 *    edit the instant it becomes resident. Yjs would merge that harmlessly at
 *    the far end, so nothing breaks visibly - it just ships the whole document
 *    over the wire on every open, which reads as a slow network rather than as
 *    a bug.
 */
const MAIN_BODY_REMOTE_ORIGIN = Symbol("open-epic/main-body-remote");

/**
 * The traffic this store produces, going OUT to the worker.
 *
 * A named pair rather than positional callbacks: both are
 * `(docKey, Uint8Array) => void`, so an ordering slip compiles clean and
 * routes document updates into the presence channel.
 */
export interface MainThreadBodyDocSinks {
  readonly onResidencyChange: () => void;
  /** A local edit to a resident body: `body/update`. */
  readonly onLocalDocUpdate: (docKey: string, update: Uint8Array) => void;
  /**
   * Local presence for a resident body: `body/awareness-out`.
   *
   * `localClientId` is read off the very `Awareness` that produced the frame,
   * rather than looked up by `docKey` at the call site. A lookup would be a
   * second path to the same fact, and the two diverge exactly when a body has
   * just been replaced - the moment the id matters most.
   */
  readonly onLocalAwareness: (
    docKey: string,
    frame: Uint8Array,
    localClientId: number,
  ) => void;
}

interface LiveBody {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /**
   * Retained so teardown can detach them. Held on the entry rather than in a
   * side map because they are only ever attached and released with the doc
   * itself, and a listener outliving its document is the leak this whole
   * module is otherwise careful about.
   */
  readonly docHandler: (update: Uint8Array, origin: unknown) => void;
  readonly awarenessHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  /**
   * The identity this document's history descends from, or `null` when none
   * was stated.
   *
   * `null` is the `@1` arm's truth, not an absence this side may fill in:
   * `artifact-room-tier.ts:325` forbids fabricating one because "a fabricated
   * guid would be indistinguishable from a stated one, and the replace rule
   * below would then be deciding on a value this client invented".
   */
  docGuid: string | null;
  /**
   * The authority's state vector at the last install, carried for the demote
   * that returns these bytes. Not read here; held so the one object that owns
   * the doc also owns everything said about it.
   */
  hostStateVector: string | null;
}

/**
 * The live docs, plus the two reads the store answers synchronously from them.
 *
 * `fragment` and `awareness` are the members that make this owed #3 rather
 * than a refactor: after the flip they are the ONLY way a main-thread editor
 * can reach a body, because a `Y.XmlFragment` cannot cross a worker boundary
 * and the runtime that used to answer them is on the other side.
 */
export interface MainThreadBodyDocStore extends MainThreadBodyDocs {
  /**
   * The live fragment Tiptap binds to, or `null` when this body is not
   * resident.
   *
   * `null` is the same answer the runtime gave for a room with no lease, and
   * for the same reason: every caller that needs a live fragment must take a
   * lease first. The fragment NAME comes from the protocol's own helper - the
   * convention is shared with the host and is not this module's to restate.
   */
  fragment(docKey: string, artifactId: string): Y.XmlFragment | null;
  /**
   * The per-body presence channel, or `null` when not resident.
   *
   * Per BODY, never the root epic's: a `CollaborationCaret` bound to a body
   * fragment must consume the awareness that belongs to that fragment's doc,
   * or per-artifact carets are mis-routed through the root channel and the
   * per-body topology is lost.
   */
  awareness(docKey: string): Awareness | null;
  /**
   * A body update from the worker: `body/doc-in`.
   *
   * Separate from `install` because the two say different things. `install`
   * establishes or REPLACES a document and decides lineage; this applies a
   * delta to one already resident and decides nothing. Folding them would put
   * the replace rule - the unrecoverable one - on the hot path of every
   * keystroke a collaborator makes.
   */
  applyRemote(docKey: string, update: Uint8Array): void;
  /** A remote presence frame from the worker: `body/awareness-in`. */
  applyRemoteAwareness(docKey: string, frame: Uint8Array): void;
  /** Every resident doc key. The main-side answer to `materializedRoomIds`. */
  residentDocKeys(): readonly string[];
  /** Drop every doc. For session teardown, where nothing will be demoted. */
  dropAll(): void;
}

/**
 * Fires whenever the resident SET changes - an install that adds a body, or a
 * drop that removes one.
 *
 * Without it the hot half is invisible to React. Availability is a projection
 * and says the room is `ready`; residency is a main-thread fact and says the
 * fragment exists. An editor that re-rendered only on availability would read
 * `null` at `ready` and never look again, because nothing else changes when
 * the materialize finally lands. Not fired for an install that merely applies
 * an update to a body already resident: the fragment reference is unchanged
 * and Yjs notifies its own observers.
 */
export function createMainThreadBodyDocStore(
  sinks: MainThreadBodyDocSinks,
): MainThreadBodyDocStore {
  const bodies = new Map<string, LiveBody>();

  function destroy(body: LiveBody): void {
    // Detach BEFORE destroying either object. `Awareness.destroy()` removes
    // this client's state, which emits an update - so a still-attached
    // handler would send a presence frame for a body that is being torn down,
    // out of a store that has already stopped tracking it.
    body.doc.off("update", body.docHandler);
    body.awareness.off("update", body.awarenessHandler);
    // Awareness first: it holds a listener on the doc, and destroying the doc
    // underneath it leaves that listener firing against a destroyed target.
    body.awareness.destroy();
    body.doc.destroy();
  }

  function track(docKey: string, doc: Y.Doc, awareness: Awareness): LiveBody {
    const docHandler = (update: Uint8Array, origin: unknown): void => {
      // The ONLY filter on this leg - see `observeBodyDoc`'s comment on the
      // worker side, which defers to this one deliberately.
      if (origin === MAIN_BODY_REMOTE_ORIGIN) return;
      sinks.onLocalDocUpdate(docKey, update);
    };
    const awarenessHandler = (
      changes: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === MAIN_BODY_REMOTE_ORIGIN) return;
      const touched = changes.added
        .concat(changes.updated)
        .concat(changes.removed);
      if (touched.length === 0) return;
      sinks.onLocalAwareness(
        docKey,
        encodeAwarenessUpdate(awareness, touched),
        awareness.clientID,
      );
    };
    doc.on("update", docHandler);
    awareness.on("update", awarenessHandler);
    return {
      doc,
      awareness,
      docHandler,
      awarenessHandler,
      docGuid: null,
      hostStateVector: null,
    };
  }

  return {
    install(input): void {
      const held = bodies.get(input.docKey);
      if (held !== undefined) {
        // A second install for a RESIDENT key does not happen: the lease
        // bridge revives an existing entry (`findByArtifact`, and the `raced`
        // check for `@1`, where the key is a room id) instead of materializing
        // again. Kept as a total function rather than a throw, and the pin for
        // that invariant lives with the bridge.
        //
        // Same lineage: apply. Yjs merges an update from the same ancestry
        // idempotently, so a re-delivered snapshot is a no-op rather than a
        // duplication - which is why `seedMode` does not need to branch here.
        // A guid-less FULL seed REPLACES. `null === null` is not evidence of
        // shared lineage - it is two bodies both declining to state one, and
        // the `@1` arm declines by design. Reading it as "same lineage" made
        // every re-seed a merge, so a body the tier had DISCARDED (a viewer
        // downgrade clearing unsent edits, fail-closed) came back with those
        // edits still in main's copy: the discard happened worker-side and
        // main never heard it.
        //
        // Safe to replace precisely because this arm relays: every `@1` edit
        // is posted through `body/update` when it is made, so a full snapshot
        // from the tier already contains anything main legitimately holds.
        // What it does NOT contain is what the tier deliberately threw away,
        // which is the whole point.
        //
        // A DELTA still applies - it describes a change to what is held, not a
        // replacement for it - so this is scoped to `"full"` rather than to
        // guid-lessness alone.
        if (
          held.docGuid === null &&
          input.docGuid === null &&
          input.seedMode === "full"
        ) {
          destroy(held);
          bodies.delete(input.docKey);
        } else if (held.docGuid === input.docGuid) {
          // Origin-stamped: this is the worker's copy of the body arriving,
          // not something the editor typed. See MAIN_BODY_REMOTE_ORIGIN.
          Y.applyUpdate(held.doc, input.update, MAIN_BODY_REMOTE_ORIGIN);
          held.hostStateVector = input.hostStateVector;
          return;
        }
        // DIFFERENT lineage. Replace, never splice - see this module's header.
        // The old doc is destroyed rather than left for the GC because its
        // awareness holds a listener on it and because any editor still bound
        // to it must fail loudly rather than keep editing a document nothing
        // will ever demote.
        destroy(held);
        bodies.delete(input.docKey);
      }
      const doc = new Y.Doc();
      const tracked = track(input.docKey, doc, new Awareness(doc));
      // Observers are attached BEFORE the seed, and the seed is origin-stamped
      // so they do not report it as a local edit. Attaching afterwards instead
      // would look equivalent and quietly lose any update that lands between
      // the two statements.
      Y.applyUpdate(doc, input.update, MAIN_BODY_REMOTE_ORIGIN);
      tracked.docGuid = input.docGuid;
      tracked.hostStateVector = input.hostStateVector;
      bodies.set(input.docKey, tracked);
      sinks.onResidencyChange();
    },

    applyRemote(docKey, update): void {
      const held = bodies.get(docKey);
      // Not resident: drop. A body/doc-in for a key this side never
      // materialized, or already demoted, has nowhere to land - and the worker
      // still holds the authoritative copy, so nothing is lost by ignoring it.
      if (held === undefined) return;
      Y.applyUpdate(held.doc, update, MAIN_BODY_REMOTE_ORIGIN);
    },

    applyRemoteAwareness(docKey, frame): void {
      const held = bodies.get(docKey);
      if (held === undefined) return;
      applyAwarenessUpdate(held.awareness, frame, MAIN_BODY_REMOTE_ORIGIN);
    },

    encode(docKey): Uint8Array {
      const held = bodies.get(docKey);
      // An empty update for a doc that is not held, rather than a throw: the
      // caller is the demote path, and the lease bridge already refuses to
      // post a demote for an entry it does not have. A throw here would turn a
      // benign race into a failed teardown.
      return held === undefined
        ? new Uint8Array()
        : Y.encodeStateAsUpdate(held.doc);
    },

    drop(docKey): void {
      const held = bodies.get(docKey);
      if (held === undefined) return;
      bodies.delete(docKey);
      destroy(held);
      sinks.onResidencyChange();
    },

    has(docKey): boolean {
      return bodies.has(docKey);
    },

    fragment(docKey, artifactId): Y.XmlFragment | null {
      const held = bodies.get(docKey);
      if (held === undefined) return null;
      return held.doc.getXmlFragment(artifactBodyFragmentName(artifactId));
    },

    awareness(docKey): Awareness | null {
      return bodies.get(docKey)?.awareness ?? null;
    },

    residentDocKeys(): readonly string[] {
      return [...bodies.keys()];
    },

    dropAll(): void {
      const held = [...bodies.values()];
      // Cleared BEFORE destroying, so a destroy handler that reads this store
      // sees the post-teardown state rather than a half-emptied map.
      bodies.clear();
      for (const body of held) destroy(body);
      if (held.length > 0) sinks.onResidencyChange();
    },
  };
}
