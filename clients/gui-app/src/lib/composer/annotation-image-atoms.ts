import { v4 as uuidv4 } from "uuid";
import type { BrowserAnnotationRecord } from "@traycer/protocol/persistence/epic/messages";
import { sniffImageMimeType } from "@/lib/attachments/image-mime-signature";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  getImageBytes,
  sessionImageBytes,
} from "@/lib/composer/landing-image-store";
import { appLogger } from "@/lib/logger";

/** A browser-annotation crop, shaped for `appendImageAttachmentAtoms`. */
export type AnnotationImageAtom = {
  readonly id: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly size: number | null;
  readonly b64content: string;
  readonly hash: string;
};

function atomFor(
  bytes: Uint8Array,
  fileName: string,
  hash: string,
): AnnotationImageAtom {
  return {
    id: uuidv4(),
    fileName,
    // SNIFFED, not assumed. A crop is a PNG when the browser view captures
    // it, and it is not one after a stash round trip: the stash canonicalizes
    // a large PNG to WebP and re-points the record at those bytes. Labelling
    // WebP bytes `image/png` was wrong in the atom, in the media type and in
    // the data URL a preview builds from them.
    mimeType: sniffImageMimeType(bytes) ?? "image/png",
    size: bytes.byteLength,
    b64content: bytesToBase64(bytes),
    hash,
  };
}

/**
 * The crops the records name, read from this window's image store. `null`
 * when one is missing: the send has nothing to attach for it, and the caller
 * says so instead of sending a card whose picture resolves nowhere.
 */
export async function resolveAnnotationImageAtoms(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): Promise<ReadonlyArray<AnnotationImageAtom> | null> {
  const atoms: AnnotationImageAtom[] = [];
  for (const record of records) {
    if (record.imageHash === null || record.imageFileName === null) continue;
    const sessionBytes = sessionImageBytes(record.imageHash);
    const bytes =
      sessionBytes ??
      // An IndexedDB open/transaction failure is "the crop is not available",
      // the same outcome as a missing key - and it must reach the caller as
      // `null` rather than a rejection, which nothing above awaits with a
      // `catch` and which would silently abandon the submit with no toast.
      (await getImageBytes(record.imageHash).catch((error: unknown) => {
        appLogger.error(
          "[chat-composer] annotation image read failed",
          { imageHash: record.imageHash },
          error,
        );
        return undefined;
      })) ??
      null;
    if (bytes === null) return null;
    atoms.push(atomFor(bytes, record.imageFileName, record.imageHash));
  }
  return atoms;
}

/**
 * The same crops from the session cache alone, for a caller that cannot
 * await: a sidecar that lives only in this window (the new-conversation
 * modal's) was filled in this session, so its bytes are still in memory.
 */
export function sessionAnnotationImageAtoms(
  records: ReadonlyArray<BrowserAnnotationRecord>,
): ReadonlyArray<AnnotationImageAtom> | null {
  const atoms: AnnotationImageAtom[] = [];
  for (const record of records) {
    if (record.imageHash === null || record.imageFileName === null) continue;
    const bytes = sessionImageBytes(record.imageHash);
    if (bytes === null) return null;
    atoms.push(atomFor(bytes, record.imageFileName, record.imageHash));
  }
  return atoms;
}
