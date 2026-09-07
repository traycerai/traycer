/**
 * {@link MainThreadBodyDocs} that actually owns the documents - owed #3, the hot half of the
 * hot/cold split.
 */
import * as Y from "yjs";
import {
  Awareness,
  applyAwarenessUpdate,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";
import { artifactBodyFragmentName } from "@traycer/protocol/persistence/epic/artifacts";

import type { MainThreadBodyDocs } from "./artifact-body-lease-bridge";

/** The origin every byte this store applies ON BEHALF OF THE WORKER carries. */
const MAIN_BODY_REMOTE_ORIGIN = Symbol("open-epic/main-body-remote");

/** The traffic this store produces, going OUT to the worker. */
export interface MainThreadBodyDocSinks {
  readonly onResidencyChange: () => void;
  /** A resident doc was retired or replaced. */
  readonly onDocRetired: (docKey: string) => void;
  /** A local edit to a resident body: `body/update`. */
  readonly onLocalDocUpdate: (docKey: string, update: Uint8Array) => void;
  /**
   * Local presence for a resident body: `body/awareness-out`. `localClientId` is read off the very
   * `Awareness` that produced the frame, rather than looked up by `docKey` at the call site.
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
  /** Retained so teardown can detach them. */
  readonly docHandler: (update: Uint8Array, origin: unknown) => void;
  readonly awarenessHandler: (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  /** The identity this document's history descends from, or `null` when none was stated. */
  docGuid: string | null;
  /**
   * The authority's state vector at the last install, carried for the demote that returns these
   * bytes.
   */
  hostStateVector: string | null;
}

/** The live docs, plus the two reads the store answers synchronously from them. */
export interface MainThreadBodyDocStore extends MainThreadBodyDocs {
  /** The live fragment Tiptap binds to, or `null` when this body is not resident. */
  fragment(docKey: string, artifactId: string): Y.XmlFragment | null;
  /** The per-body presence channel, or `null` when not resident. */
  awareness(docKey: string): Awareness | null;
  /**
   * A body update from the worker: `body/doc-in`. Separate from `install` because the two say
   * different things.
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
 * Fires whenever the resident SET changes - an install that adds a body, or a drop that removes
 * one. Without it the hot half is invisible to React.
 */
export function createMainThreadBodyDocStore(
  sinks: MainThreadBodyDocSinks,
): MainThreadBodyDocStore {
  const bodies = new Map<string, LiveBody>();

  function destroy(body: LiveBody): void {
    // Detach BEFORE destroying either object.
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
        if (
          held.docGuid === null &&
          input.docGuid === null &&
          input.seedMode === "full"
        ) {
          destroy(held);
          bodies.delete(input.docKey);
          sinks.onDocRetired(input.docKey);
        } else if (held.docGuid === input.docGuid) {
          // Origin-stamped: this is the worker's copy of the body arriving,
          // not something the editor typed. See MAIN_BODY_REMOTE_ORIGIN.
          Y.applyUpdate(held.doc, input.update, MAIN_BODY_REMOTE_ORIGIN);
          held.hostStateVector = input.hostStateVector;
          return;
        } else {
          // DIFFERENT lineage. Replace, never splice - see this module's header.
          destroy(held);
          bodies.delete(input.docKey);
          sinks.onDocRetired(input.docKey);
        }
      }
      const doc = new Y.Doc();
      const tracked = track(input.docKey, doc, new Awareness(doc));
      // Observers are attached BEFORE the seed, and the seed is origin-stamped so they do not report it
      // as a local edit.
      Y.applyUpdate(doc, input.update, MAIN_BODY_REMOTE_ORIGIN);
      tracked.docGuid = input.docGuid;
      tracked.hostStateVector = input.hostStateVector;
      bodies.set(input.docKey, tracked);
      sinks.onResidencyChange();
    },

    applyRemote(docKey, update): void {
      const held = bodies.get(docKey);
      // Not resident: drop.
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
      // An empty update for a doc that is not held, rather than a throw: the caller is the demote path,
      // and the lease bridge already refuses to post a demote for an entry it does not have.
      return held === undefined
        ? new Uint8Array()
        : Y.encodeStateAsUpdate(held.doc);
    },

    drop(docKey): void {
      const held = bodies.get(docKey);
      if (held === undefined) return;
      bodies.delete(docKey);
      destroy(held);
      sinks.onDocRetired(docKey);
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
      const held = [...bodies.entries()];
      // Cleared BEFORE destroying, so a destroy handler that reads this store
      // sees the post-teardown state rather than a half-emptied map.
      bodies.clear();
      for (const [docKey, body] of held) {
        destroy(body);
        sinks.onDocRetired(docKey);
      }
      if (held.length > 0) sinks.onResidencyChange();
    },
  };
}
