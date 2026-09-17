/**
 * The image formats the HOST's disk writer accepts, and therefore the only ones
 * this client may store content-addressed.
 *
 * In `lib/` rather than beside the paste hook that first needed it, because
 * three different layers have to reach the same verdict and they must not
 * disagree:
 *
 *  - the file ingest, deciding whether to hash a pasted file or leave it inline;
 *  - the rewrite paths, deciding whether an inline node is theirs to claim;
 *  - the draft COLLECTORS, deciding whether an inline node is a rewrite still in
 *    flight (withhold the write) or a node that is deliberately, permanently
 *    inline (publish it).
 *
 * That third reader is the one that made this a shared module. While it asked
 * only "does this node carry bytes", a declared BMP - kept inline on purpose -
 * read as forever-pending and withheld the entire draft, text and all, for the
 * life of the composer.
 *
 * Declared type, never sniffed: sniffing would make the renderer a second
 * authority on format, and the authority that matters is the host's writer. A
 * file that lies about its type fails at the host with the reason the host plan
 * defines, which is where it would have failed anyway.
 */
const HOST_STORABLE_IMAGE_MIME_TYPES: ReadonlySet<string> = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

/**
 * The default every reader applies to a node with no `mimeType` attr, matching
 * `collectImageAtoms`. It has to be shared: if the collectors defaulted one way
 * and the rewrite the other, a node with no declared type would be withheld by
 * one and ignored by the other - withheld forever, which is the F2 shape again
 * through a different door.
 */
export const DEFAULT_IMAGE_MIME_TYPE = "image/png";

export function isHostStorableImageMimeType(mimeType: string): boolean {
  return HOST_STORABLE_IMAGE_MIME_TYPES.has(mimeType);
}
