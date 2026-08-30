/**
 * {@link EpicRuntimeCorePorts} over a composed {@link EpicReplicaRuntime}.
 *
 * Its own module rather than a closure inside `install-epic-runtime-core.ts`
 * for one reason: the attachments port has a property that must be pinned -
 * it never waits - and pinning it through the whole install would need a host,
 * a bridge and a bootstrap to observe one promise settling.
 *
 * Named members rather than the runtime itself, the same discipline
 * `in-process-runtime-port.ts` uses: the runtime has 42 members and these
 * ports need eight. A parameter typed as the whole runtime would let a future
 * member reach across this seam without anyone noticing the seam had moved.
 */
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import type { ArtifactRoomColdState } from "../artifact-room-tier";
import type { EpicRuntimeCorePorts } from "./epic-runtime-core";

export interface EpicRuntimeCorePortSource {
  /** Synchronous and local: whether the root replica holds these bytes now. */
  hasAttachmentBytes(hash: string): boolean;
  /**
   * WAITS for a hash that has not synced yet, resolving `null` only when the
   * signal aborts. That is the contract, not a defect - see the guard below.
   */
  readAttachmentBytes(
    hash: string,
    signal: AbortSignal,
  ): Promise<Uint8Array | null>;
  bodyDocKey(artifactId: string): string | null;
  encodeColdState(docKey: string): ArtifactRoomColdState | null;
  settleColdState(
    docKey: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ):
    | { readonly accepted: true; readonly settledBytes: number }
    | { readonly accepted: false };
  sendBodyUpdate(docKey: string, update: Uint8Array): SendOutcome;
  renameArtifact(artifactId: string, nextTitle: string): boolean;
  deleteArtifact(artifactId: string): boolean;
  /** MAY THROW for an illegal move - the caller turns that into an error result. */
  reparentArtifact(artifactId: string, newParentId: string | null): boolean;
  beginRenameMutation(nodeId: string, nextTitle: string): string | null;
  beginEpicTitleMutation(nextTitle: string): string | null;
  beginReparentMutation(
    nodeId: string,
    newParentId: string | null,
  ): string | null;
  retirePendingMutation(
    requestId: string,
    outcome: "landed" | "failed",
  ): boolean;
  isLatestRenameStamp(nodeId: string, requestId: string): boolean;
  detachTransport(): void;
  dispose(): void;
}

export function buildEpicRuntimeCorePorts(
  source: EpicRuntimeCorePortSource,
): EpicRuntimeCorePorts {
  return {
    attachments: {
      /**
       * NON-WAITING, which is this port's whole contract.
       *
       * The runtime's own read waits indefinitely for a hash that has not
       * synced and resolves `null` only when its signal aborts - deliberately,
       * for a main-thread caller that holds one. Across the bridge there is no
       * signal to abort, so an unguarded read parks the call forever and holds
       * a call slot open for the life of the worker.
       *
       * The guard that used to live on main - `hasAttachmentBytes`, which
       * every caller was required to check first and which was documented as
       * "not optional" - lives HERE now, where it is a local synchronous read
       * and cannot be forgotten by a caller.
       */
      read: (hash) =>
        source.hasAttachmentBytes(hash)
          ? source.readAttachmentBytes(hash, new AbortController().signal)
          : Promise.resolve(null),
    },
    bodies: {
      materialize: (artifactId) => {
        const docKey = source.bodyDocKey(artifactId);
        if (docKey === null) return Promise.resolve(null);
        const cold = source.encodeColdState(docKey);
        // `null` is NOT empty bytes: a zero-length update applies cleanly and
        // yields an empty document, so conflating them replaces a body with
        // nothing.
        if (cold === null) return Promise.resolve(null);
        return Promise.resolve({
          docKey,
          update: cold.update,
          docGuid: cold.docGuid,
          seedMode: cold.seedMode,
          hostStateVector: cold.hostStateVector,
        });
      },
      settle: (input) => {
        const settlement = source.settleColdState(
          input.docKey,
          input.update,
          input.docGuid,
        );
        // The refusal REASON ("not-held" / "newer-generation") stops here: the
        // response carries the verdict and the bytes, the main thread keeps
        // the live doc on either refusal, and the in-process port drops it at
        // the same seam.
        return Promise.resolve(
          settlement.accepted
            ? { accepted: true, settledBytes: settlement.settledBytes }
            : { accepted: false, settledBytes: 0 },
        );
      },
      sendUpdate: (input) =>
        Promise.resolve(source.sendBodyUpdate(input.docKey, input.update)),
    },
    mutations: {
      /**
       * One branch per kind rather than a generic dispatch, and the repetition
       * is the safety - the same reasoning `CALL_BUILDERS` states in the
       * protocol. Inside each branch the kind is a literal, so TypeScript
       * checks the answer against THAT kind's response type; a generic
       * dispatch over the union can only be made to compile with an assertion,
       * at exactly the point where a wrong-shaped answer would be bound to a
       * kind.
       */
      apply: (mutation) => {
        switch (mutation.kind) {
          case "rename-artifact":
            return {
              kind: "rename-artifact",
              value: {
                changed: source.renameArtifact(
                  mutation.request.artifactId,
                  mutation.request.title,
                ),
              },
            };
          case "delete-artifact":
            return {
              kind: "delete-artifact",
              value: {
                changed: source.deleteArtifact(mutation.request.artifactId),
              },
            };
          case "reparent-artifact":
            return {
              kind: "reparent-artifact",
              value: {
                changed: source.reparentArtifact(
                  mutation.request.artifactId,
                  mutation.request.newParentId,
                ),
              },
            };
          case "begin-rename":
            return {
              kind: "begin-rename",
              value: {
                requestId: source.beginRenameMutation(
                  mutation.request.nodeId,
                  mutation.request.title,
                ),
              },
            };
          case "begin-epic-title":
            return {
              kind: "begin-epic-title",
              value: {
                requestId: source.beginEpicTitleMutation(
                  mutation.request.title,
                ),
              },
            };
          case "begin-reparent":
            return {
              kind: "begin-reparent",
              value: {
                requestId: source.beginReparentMutation(
                  mutation.request.nodeId,
                  mutation.request.newParentId,
                ),
              },
            };
          case "retire-pending":
            return {
              kind: "retire-pending",
              value: {
                retired: source.retirePendingMutation(
                  mutation.request.requestId,
                  mutation.request.outcome,
                ),
              },
            };
          case "is-latest-rename-stamp":
            return {
              kind: "is-latest-rename-stamp",
              value: {
                latest: source.isLatestRenameStamp(
                  mutation.request.nodeId,
                  mutation.request.requestId,
                ),
              },
            };
        }
      },
    },
    // The core's documented shutdown order, mapped onto the runtime's two
    // teardown members: the core stops serving, then the transport closes,
    // then the durable store. `dispose()` owns the store, so it goes last.
    transport: {
      close: () => {
        source.detachTransport();
      },
    },
    durableStore: {
      close: () => {
        source.dispose();
      },
    },
  };
}
