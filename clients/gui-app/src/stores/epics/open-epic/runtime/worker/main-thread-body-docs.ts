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
import { Awareness } from "y-protocols/awareness";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";

import type { MainThreadBodyDocs } from "./artifact-body-lease-bridge";

interface LiveBody {
  readonly doc: Y.Doc;
  readonly awareness: Awareness;
  /** The identity this document's history descends from. */
  docGuid: string;
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
  onResidencyChange: () => void,
): MainThreadBodyDocStore {
  const bodies = new Map<string, LiveBody>();

  function destroy(body: LiveBody): void {
    // Awareness first: it holds a listener on the doc, and destroying the doc
    // underneath it leaves that listener firing against a destroyed target.
    body.awareness.destroy();
    body.doc.destroy();
  }

  return {
    install(input): void {
      const held = bodies.get(input.docKey);
      if (held !== undefined) {
        // Same lineage: apply. Yjs merges an update from the same ancestry
        // idempotently, so a re-delivered snapshot is a no-op rather than a
        // duplication - which is why `seedMode` does not need to branch here.
        if (held.docGuid === input.docGuid) {
          Y.applyUpdate(held.doc, input.update);
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
      Y.applyUpdate(doc, input.update);
      bodies.set(input.docKey, {
        doc,
        awareness: new Awareness(doc),
        docGuid: input.docGuid,
        hostStateVector: input.hostStateVector,
      });
      onResidencyChange();
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
      onResidencyChange();
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
      if (held.length > 0) onResidencyChange();
    },
  };
}
