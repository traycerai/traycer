import type {
  SyncLinksFolder,
  SyncLinksPeer,
} from "@traycer/protocol/host/sync-links-schemas";
import {
  UNNAMED_PEER_NAME,
  heldForPersonalText,
} from "@/components/sync-links/sync-links-copy";

/** A linked computer as the ask names it: by its name, once. */
export interface NamedPeer {
  readonly hostId: string;
  readonly name: string;
  /** Still on 1.5.4. A version the host could not read is not this. */
  readonly needsUpdate: boolean;
}

export function peerName(peer: SyncLinksPeer): string {
  return peer.displayName ?? UNNAMED_PEER_NAME;
}

/**
 * The linked computers this computer's own list names (I7), each once, in
 * the order its folders first name them.
 */
export function namedPeers(
  folders: readonly SyncLinksFolder[],
): readonly NamedPeer[] {
  const seen = new Map<string, NamedPeer>();
  for (const folder of folders) {
    for (const peer of folder.peers) {
      if (seen.has(peer.hostId)) continue;
      seen.set(peer.hostId, {
        hostId: peer.hostId,
        name: peerName(peer),
        needsUpdate: peer.version === "needs-update",
      });
    }
  }
  return [...seen.values()];
}

/**
 * Board 4's line for an account answered with Move whose linked computers
 * have not moved yet, or `null` when the account is not held.
 */
export function heldForPersonalLine(
  folders: readonly SyncLinksFolder[],
  providerId: string,
  profileId: string,
): string | null {
  const folder = folders.find(
    (candidate) =>
      candidate.hold === "held-for-personal" &&
      candidate.providerId === providerId &&
      candidate.profileId === profileId,
  );
  return folder === undefined
    ? null
    : heldForPersonalText(folder.peers.map(peerName));
}
