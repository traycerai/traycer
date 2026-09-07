export interface EpicRoomSnapshotIdentity {
  readonly roomId: string | undefined;
}

/**
 * Decides whether a host re-point may union the prior Y.Doc into the incoming snapshot.
 * A merge is only safe when BOTH snapshots explicitly name the same concrete collaboration room.
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
