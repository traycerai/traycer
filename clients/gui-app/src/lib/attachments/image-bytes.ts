/** A view guaranteed to be backed by a plain `ArrayBuffer` (not shared). */
export type ImageBytes = Uint8Array<ArrayBuffer>;

/** Bytes plus the canonical MIME resolved for them. */
export interface ImageBlob {
  readonly bytes: ImageBytes;
  readonly mimeType: string;
}

/** A blob some content references was not resolvable from durable storage. */
export class ImageBlobMissingError extends Error {
  constructor() {
    super("A stashed image is missing from durable storage.");
    this.name = "PromptStashMissingBlobError";
  }
}

/** A referenced blob exists but failed byte-level validation. */
export class ImageBlobCorruptError extends Error {
  constructor() {
    super("A stashed image is damaged and could not be verified.");
    this.name = "PromptStashCorruptBlobError";
  }
}
