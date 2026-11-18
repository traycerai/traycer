/**
 * A draft-aware byte source for surfaces that render an image a composer is
 * still holding.
 *
 * The epic and chat fetchers answer for a SENT image - the epic doc's
 * attachments map, `epic.readChatAttachment` on the tile's host. Neither can
 * answer for a draft image that has not been sent yet: the chat fetcher does
 * reach this window's image partition as its last leg, but the EPIC fetcher has
 * no local leg at all, so a hash a composer minted moments ago renders blank on
 * the surfaces wired to it even in the very window that minted it.
 *
 * `resolveDraftImageBytes` is the missing source. It is composed with an
 * existing fetcher rather than replacing one, because a composer's document can
 * legitimately hold both kinds of hash at once - a fresh paste beside an image
 * carried in from a sent message - and which one a given node is, is not
 * something the node itself says.
 */
import { useMemo } from "react";

import type {
  ImageBytesResult,
  ScopedImageBytesFetcher,
} from "@/lib/attachments/image-blob-cache";
import { draftImageByteTargetForHost } from "@/lib/drafts/draft-image-byte-target";
import { resolveDraftImageBytes } from "@/lib/drafts/resolve-draft-image-bytes";

/**
 * A fetcher that asks draft custody FIRST and falls back to `base`.
 *
 * Draft-first, and the order is not a preference: `useEpicImageFetcher`'s
 * legacy arm is a WAITING read - an artifact image whose bytes are still
 * replicating must resolve when they land rather than read as missing - so a
 * draft leg placed after it would never run for a hash the epic will never
 * hold. The wait is correct for what that fetcher is for and fatal as a
 * predecessor.
 *
 * The composed source gets its OWN cache namespace. Its bytes can come from
 * this window's image partition, which is not the subject `base.scopeKey`
 * names; sharing a key would let a hash authorized against one subject be
 * served from the other's bytes, which is the exact aliasing every scoped
 * fetcher in this directory is keyed to prevent.
 */
export function useDraftFirstImageFetcher(
  base: ScopedImageBytesFetcher,
  hostId: string | null,
): ScopedImageBytesFetcher {
  return useMemo<ScopedImageBytesFetcher>(
    () => ({
      scopeKey: JSON.stringify(["draft-image", hostId ?? "", base.scopeKey]),
      fetch: async (hash, signal): Promise<ImageBytesResult> => {
        // The target is resolved per FETCH: a draft mirror is acquired and
        // released as tiles mount, so one captured at render time can name a
        // session that is already gone.
        const bytes = await resolveDraftImageBytes(
          hash,
          draftImageByteTargetForHost(hostId),
        );
        if (bytes !== null) {
          // The draft stores keep raw bytes with no sniffed header, so this
          // leg has no media-type verdict of its own and the chip's declared
          // type stands - the same answer the landing fetcher gives.
          return { bytes, mediaType: null };
        }
        return base.fetch(hash, signal);
      },
    }),
    [base, hostId],
  );
}
