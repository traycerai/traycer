/**
 * The root-state port, inert, for hand-built `OpenEpicStoreHandle` fixtures.
 *
 * ONE source for eight literals across seven files. `OpenEpicStoreHandle` is a
 * type test fixtures MIRROR by hand, so every member added to it is a compile
 * error at each of them - which is how a two-member port turned into eight
 * failures. Spreading this means the next member lands here and nowhere else.
 *
 * Both answers FAIL CLOSED. `applyRootUpdate` resolves `false`, never `true`:
 * that boolean is what tells a caller its edits are already in the
 * replacement, and a fixture claiming `true` would let a retention decision
 * retire the only copy of a document. An empty `encodeRootState` is the honest
 * counterpart - a fake handle holds no state to transfer.
 */
export const INERT_ROOT_STATE_PORT = {
  encodeRootState: (): Promise<Uint8Array> => Promise.resolve(new Uint8Array()),
  applyRootUpdate: (): Promise<boolean> => Promise.resolve(false),
};
