/**
 * The renderer's local divergence arithmetic: has the host seen everything this
 * replica has written?
 *
 * Re-homed verbatim from the open-epic closure. It is pure state-vector
 * comparison over base64 payloads and has no dependency on a store, a socket
 * or React - it only ever lived beside them.
 *
 * Read direction matters and is the reason nothing here rounds: coverage
 * decides whether local work is durable, so over-reporting dirty work costs a
 * redundant reconcile while under-reporting it would claim unsynced edits are
 * safe. Every ambiguous case in this file resolves toward "still dirty".
 */
import * as Y from "yjs";

/**
 * A Yjs update carrying no operations. `Y.encodeStateAsUpdate(doc, sv)`
 * against a state vector the doc is already covered by still returns a
 * two-byte envelope, so length is what separates "nothing to send" from a real
 * delta.
 */
const EMPTY_Y_UPDATE_BYTES = 2;

export function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function decodeBase64(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export function encodeDocStateVectorBase64(doc: Y.Doc): string {
  return encodeBase64(Y.encodeStateVector(doc));
}

export function isNonTrivialYUpdate(updateBytes: Uint8Array): boolean {
  return updateBytes.length > EMPTY_Y_UPDATE_BYTES;
}

/**
 * The renderer-local divergence triple, published by the records plane.
 *
 * Structurally the `isDirty` / `dirtyWatermarkStateVectorBase64` /
 * `latestHostStateVectorBase64` fields of the records projection; named here
 * because this module is what computes them and nothing above it should be
 * spelling the shape out again.
 */
export interface DivergenceState {
  readonly isDirty: boolean;
  readonly dirtyWatermarkStateVectorBase64: string | null;
  readonly latestHostStateVectorBase64: string | null;
}

export function latestHostCoversDirtyWatermark(
  latestHostStateVectorBase64: string | null,
  dirtyWatermarkStateVectorBase64: string | null,
): boolean {
  if (dirtyWatermarkStateVectorBase64 === null) return true;
  if (latestHostStateVectorBase64 === null) return false;
  const latestHostStateVector = Y.decodeStateVector(
    decodeBase64(latestHostStateVectorBase64),
  );
  return Array.from(
    Y.decodeStateVector(
      decodeBase64(dirtyWatermarkStateVectorBase64),
    ).entries(),
  ).every(
    ([clientId, clock]) => (latestHostStateVector.get(clientId) ?? 0) >= clock,
  );
}

export function resolveDirtyState(
  dirtyWatermarkStateVectorBase64: string | null,
  latestHostStateVectorBase64: string | null,
): DivergenceState {
  if (
    latestHostCoversDirtyWatermark(
      latestHostStateVectorBase64,
      dirtyWatermarkStateVectorBase64,
    )
  ) {
    return {
      isDirty: false,
      dirtyWatermarkStateVectorBase64: null,
      latestHostStateVectorBase64,
    };
  }
  return {
    isDirty: true,
    dirtyWatermarkStateVectorBase64,
    latestHostStateVectorBase64,
  };
}

export function knownCleanDirtyState(): DivergenceState {
  return {
    isDirty: false,
    dirtyWatermarkStateVectorBase64: null,
    latestHostStateVectorBase64: null,
  };
}
