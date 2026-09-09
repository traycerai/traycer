import {
  draftSubscribeFrameApplies,
  type DraftHeldRevisionState,
  type DraftSubscribeFrameFrontier,
} from "@traycer/protocol/host";

/**
 * Client apply rule for `drafts.subscribe` frames.
 *
 * The protocol helper is the merge rule against `snapshotSeq` / held
 * revision (T4 MUST: never treat an omitted list id as apply-any). The
 * extra local-dirty gate is the client-plan overlay: unsynced edits stay
 * in place and win by arriving last on the host LWW upsert.
 */
export function clientDraftSubscribeFrameApplies(input: {
  readonly held: DraftHeldRevisionState;
  readonly frame: DraftSubscribeFrameFrontier;
  readonly snapshotSeq: number;
  readonly localDirty: boolean;
}): boolean {
  if (input.localDirty) return false;
  return draftSubscribeFrameApplies(input.held, input.frame, input.snapshotSeq);
}
