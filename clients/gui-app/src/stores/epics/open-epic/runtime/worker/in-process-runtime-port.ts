/**
 * A `RuntimeWorkerPort` served by the LOCAL runtime, with no worker.
 *
 * "Seams before relocation": the lease bridge is written against the port, so
 * it can be wired and pinned while the replica is still in-process. At the flip
 * this module is replaced by the spawned worker's port and the bridge does not
 * change - which is the point of introducing the seam first.
 *
 * Every answer resolves through a promise over a synchronous call. Not a
 * pretence of asynchrony: the port's contract IS async and callers already
 * await it, so answering same-tick here would let one accidentally depend on
 * delivery the worker will never provide.
 */
import type { SendOutcome } from "@traycer-clients/shared/replica-runtime/adapter";
import type { RuntimeWorkerPort } from "@traycer-clients/shared/replica-runtime/worker/bridge-endpoint";
import { inertMutationResult } from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";
import type {
  ArtifactBodySeedMode,
  RuntimeWorkerCallKind,
  RuntimeWorkerCallRequest,
  RuntimeWorkerCallResponse,
} from "@traycer-clients/shared/replica-runtime/worker/bridge-protocol";

/** A body's cold state as the port needs it, plus the identity it was cut at. */
export interface InProcessColdState {
  readonly update: Uint8Array;
  readonly seedMode: ArtifactBodySeedMode;
  readonly hostStateVector: string | null;
  /** The identity these bytes were cut at - the tier's own doc guid. */
  readonly docGuid: string;
}

/**
 * What the port needs from the runtime, named member by member rather than
 * taking the runtime itself.
 *
 * The runtime has 44 members and the port serves four calls. A parameter typed
 * as the whole runtime would let a future member reach across this seam without
 * anyone noticing the seam had moved - which is the failure the seam exists to
 * make visible.
 */
export interface InProcessRuntimeSource {
  /** `null` when this artifact has no body doc on the installed arm. */
  bodyDocKey(artifactId: string): string | null;
  /**
   * `null` means NOT HELD, and it is a distinct outcome from empty bytes: a
   * zero-length update applies cleanly and yields an empty document, so a
   * caller conflating them would replace a body with nothing.
   */
  encodeColdState(docKey: string): InProcessColdState | null;
  settleColdState(
    docKey: string,
    update: Uint8Array,
    expectedDocGuid: string,
  ): { readonly accepted: boolean; readonly settledBytes: number };
  sendBodyUpdate(docKey: string, update: Uint8Array): SendOutcome;
}

/**
 * One handler per call, so a call added to the protocol without one does not
 * compile.
 *
 * A mapped type rather than a `switch`: `handlers[kind]` at a generic `K` has
 * type `(req: Request<K>) => Response<K>`, which is exactly what `call` needs
 * and needs no assertion - the same construction `CALL_RESPONSE_PARSERS` uses
 * in the bridge endpoint. A `switch` would have to widen its arms and cast.
 */
type InProcessHandlers = {
  readonly [K in RuntimeWorkerCallKind]: (
    request: RuntimeWorkerCallRequest<K>,
  ) => RuntimeWorkerCallResponse<K>;
};

/** The not-held answer, spelled once. */
const BODY_NOT_HELD: RuntimeWorkerCallResponse<"body/materialize"> = {
  docKey: null,
  update: null,
  docGuid: null,
  seedMode: "full",
  hostStateVector: null,
};

export function createInProcessRuntimePort(
  source: InProcessRuntimeSource,
): RuntimeWorkerPort {
  const handlers: InProcessHandlers = {
    // Inert until step 5, and `{ bytes: null }` is the CONTRACT's own answer
    // for "not available from here" - the same thing the worker host answers
    // before a core is installed, which every surviving read path already
    // treats as a skip. A member on the source for a call this port does not
    // serve would be dead surface pretending to be a seam.
    "attachment/read": () => ({ bytes: null }),
    // Inert for the same reason `attachment/read` is: this port serves the
    // BODY calls, which is what the lease bridge needed pinned before a worker
    // existed. Every arm answers "nothing happened", so a suite driving Arm A
    // through this port cannot mistake it for a replica that applied a
    // mutation. Adding eight source members for calls this port does not serve
    // would be dead surface pretending to be a seam.
    "mutation/apply": (request) => inertMutationResult(request),
    "body/materialize": (request) => {
      const docKey = source.bodyDocKey(request.artifactId);
      if (docKey === null) return BODY_NOT_HELD;
      const cold = source.encodeColdState(docKey);
      // `docKey: null` is the port's OWN not-held arm. Answering
      // `{ docKey, update: new Uint8Array() }` would be a zero-length update
      // that applies cleanly and produces an empty body - the exact conflation
      // this arm exists to prevent.
      if (cold === null) return BODY_NOT_HELD;
      return {
        docKey,
        update: cold.update,
        docGuid: cold.docGuid,
        seedMode: cold.seedMode,
        hostStateVector: cold.hostStateVector,
      };
    },
    "body/demote": (request) =>
      source.settleColdState(request.docKey, request.update, request.docGuid),
    "body/update": (request) => ({
      outcome: source.sendBodyUpdate(request.docKey, request.update),
    }),
  };
  return {
    call<K extends RuntimeWorkerCallKind>(
      kind: K,
      request: RuntimeWorkerCallRequest<K>,
      // Accepted and IGNORED, deliberately. In-process the caller's bytes and
      // the replica's are the same objects, so honouring a transfer list would
      // DETACH buffers the replica is still holding - the opposite of what the
      // list means across a real `postMessage`, where the sender is giving up
      // memory it will not touch again. Named rather than omitted so the
      // difference is visible at the seam that will stop being in-process.
      _transfer: readonly ArrayBuffer[],
    ): Promise<RuntimeWorkerCallResponse<K>> {
      const handler = handlers[kind];
      return Promise.resolve(handler(request));
    },
  };
}
