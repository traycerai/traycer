/**
 * The one byte source for a DRAFT image that travels as a bare content hash.
 *
 * A draft image's bytes live in exactly three places, and no single one of them
 * is reliable on its own:
 *
 *  1. **This window's image partition** (`landing-image-store`) - where the
 *     paste that minted the hash wrote them. Missing after a reload, after
 *     `landing-image-gc` reclaimed them, and in every OTHER window of the same
 *     device (the partition is per runtime).
 *  2. **The target host's draft blob store** - `drafts.readBlob`, which the
 *     mirror uploaded to with `drafts.putBlob`. Missing when the host predates
 *     the blob methods, when the upload never happened, and when the owner host
 *     is not the host this surface targets.
 *  3. **The cloud `image-attachment` blob** that `DraftPublicationService`
 *     already publishes. Missing when the draft was never published, and when
 *     nothing has told this window where the blob lives - see
 *     `cloud-draft-image-recovery.ts`.
 *
 * So the resolver tries them in that order - cheapest and most local first -
 * and answers `null` rather than throwing when none of them has the bytes. A
 * miss is an ordinary outcome here, not a fault: the caller's contract in every
 * case is to leave the node hash-only and let the HOST's dangling-hash guard be
 * the authority on whether that send may proceed. The client never refuses a
 * send because its own replica came up empty.
 *
 * This is deliberately NOT a reader for a SENT image. A sent image's bytes are
 * in the epic attachment store, which `useChatImageFetcher` /
 * `useEpicImageFetcher` read; those are different subjects with different
 * authorization, and conflating them is how a hash from one surface ends up
 * serving another's bytes.
 */
import type { ImageBytes } from "@/lib/attachments/image-bytes";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { appLogger, describeLogError } from "@/lib/logger";

import { readCloudDraftImageBytes } from "./cloud-draft-image-recovery";
import {
  readDraftBlobsIntoLocalStore,
  type DraftBlobClient,
} from "./draft-blob-transport";

/**
 * Where a surface's draft blobs live on the wire: the host this composer
 * submits to, and a requester that addresses it.
 *
 * Both halves are nullable and are checked together, because a host id with no
 * client (the directory row is gone, the user is signed out) can serve nothing
 * and must degrade to the local legs rather than throw.
 */
export interface DraftImageByteTarget {
  readonly hostId: string | null;
  readonly client: DraftBlobClient | null;
}

/** For a surface with no host to ask - local legs only. */
export const NO_DRAFT_IMAGE_BYTE_TARGET: DraftImageByteTarget = {
  hostId: null,
  client: null,
};

/**
 * Bytes for a draft image `hash`, or `null` when no leg has them.
 *
 * Never throws, including when IndexedDB is absent (tests, a locked-down
 * runtime) or the host RPC fails - both are "these bytes are not obtainable
 * here", which is the same answer as a miss and must not abandon a submit.
 */
export async function resolveDraftImageBytes(
  hash: string,
  target: DraftImageByteTarget,
): Promise<ImageBytes | null> {
  const local = await readLocalDraftImageBytes(hash);
  if (local !== null) return local;
  const fromHost = await readHostDraftImageBytes(hash, target);
  if (fromHost !== null) return fromHost;
  return readCloudDraftImageBytes(hash);
}

/**
 * Leg 1. `getImageBytes` already consults this session's cache before the
 * partition's IndexedDB, so the just-pasted case costs no round trip.
 */
async function readLocalDraftImageBytes(
  hash: string,
): Promise<ImageBytes | null> {
  try {
    return (await getImageBytes(hash)) ?? null;
  } catch (error: unknown) {
    appLogger.warn("[draft-image] local image read failed", {
      hash,
      error: describeLogError(error),
    });
    return null;
  }
}

/**
 * Leg 2. Through `readDraftBlobsIntoLocalStore` rather than a bare
 * `drafts.readBlob` so this leg inherits the two behaviours that already make
 * that path safe: the host-withholds-blob-methods memo (an old host is never
 * re-probed per image), and the write-back into this window's partition, which
 * turns the next resolution of the same hash into a leg-1 hit.
 *
 * That helper already swallows its own transport failures and answers an empty
 * map, so there is nothing left here to catch.
 */
async function readHostDraftImageBytes(
  hash: string,
  target: DraftImageByteTarget,
): Promise<ImageBytes | null> {
  const { hostId, client } = target;
  if (hostId === null || client === null) return null;
  try {
    const images = await readDraftBlobsIntoLocalStore(hostId, client, [hash]);
    return images.get(hash)?.bytes ?? null;
  } catch (error: unknown) {
    // Belt and braces over the transport's own containment. This function's
    // whole contract to three submit continuations is bytes-or-null, and they
    // discard the promise with `void` - so anything that escapes here is an
    // unhandled rejection that abandons a send with no message and no
    // missing-byte fallback, which is strictly worse than a miss.
    appLogger.warn("[draft-image] host blob read failed", {
      hash,
      error: describeLogError(error),
    });
    return null;
  }
}

// Leg 3 is `readCloudDraftImageBytes` from `cloud-draft-image-recovery.ts`: the
// published `image-attachment` blob, read through whatever host this DEVICE
// runs, digest-verified on the way into this window's partition. It is last
// because it is the only leg that leaves the device, and it answers `null` for
// a hash no cloud draft has named - which keeps this module's contract
// unchanged for every surface that never sees a replica.
