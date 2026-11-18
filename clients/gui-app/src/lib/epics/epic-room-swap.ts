export interface EpicRoomSnapshotIdentity {
  readonly roomId: string | undefined;
}

/**
 * Decides whether a host re-point may union the prior Y.Doc into the incoming
 * snapshot. A merge is only safe when BOTH snapshots explicitly name the same
 * concrete collaboration room.
 *
 * This is intentionally asymmetric: a false plain swap only makes the user
 * wait for a fresh snapshot, while a false merge can union unrelated docs and
 * corrupt task state. `roomId` is absent on older hosts, so absence must stay
 * conservative even when the Epic id matches: schema migration can retain an
 * Epic id while moving it to a new room.
 *
 * Trip-wire for Local Room: when a non-cloud room backend is introduced, its
 * producer must define the explicit room identity carried in snapshot metadata
 * and this seam must consume it. Do not restore an Epic-id fallback here.
 */
export function shouldMergeEpicRoomSwap(
  previous: EpicRoomSnapshotIdentity,
  next: EpicRoomSnapshotIdentity,
): boolean {
  return (
    previous.roomId !== undefined &&
    next.roomId !== undefined &&
    previous.roomId === next.roomId
  );
}
