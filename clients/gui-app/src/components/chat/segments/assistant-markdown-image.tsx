import { createContext, useContext, type ReactNode } from "react";
import { Link } from "lucide-react";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
import type { FileResolutionEntry } from "@traycer/protocol/persistence/epic/schemas";
import {
  useScrollToChatBlock,
  type ScrollToChatBlock,
} from "@/components/chat/chat-scroll-to-block";
import { useChatAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import type {
  AssistantMarkdownImageContext,
  AssistantMarkdownImageResolution,
  AssistantMarkdownImageTarget,
} from "@/stores/composer/chat-store";
import {
  AttachmentImage,
  AttachmentImageFailure,
  AttachmentImageLoading,
} from "./attachment-image";
import { base64ToBytes, bytesToBase64 } from "@/lib/composer/image-base64";
import {
  MAX_SVG_SOURCE_LENGTH,
  sanitizeUntrustedSvg,
} from "@/lib/images/untrusted-svg";
import { mediaTypeFamily } from "@/lib/files/media-type-family";
import { useFileBytes } from "@/lib/files/byte-source";
import { extractText } from "@/markdown/components/extract-react-node-text";
import { MarkdownAnchor } from "@/markdown/components/markdown-anchor";
import { InlineVideo } from "./inline-video";

const RASTER_DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/]+={0,2})$/i;
const SVG_DATA_URL_PATTERN = /^data:image\/svg\+xml(?:[;,])/i;
const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_PATH_PATTERN = /^(?:[a-z]:[\\/]|\\\\)/i;
const MAX_ASSISTANT_IMAGE_PIXELS = 32 * 1024 * 1024;

type AssistantImageSource =
  | { readonly kind: "https"; readonly src: string }
  | { readonly kind: "data-raster"; readonly src: string }
  | { readonly kind: "data-svg"; readonly src: string }
  | { readonly kind: "data-oversized"; readonly src: string }
  | { readonly kind: "local"; readonly src: string }
  | { readonly kind: "invalid-data"; readonly src: string }
  | { readonly kind: "unsupported"; readonly src: string };

export interface AssistantMarkdownImageProps {
  readonly alt: string;
  readonly src: string;
  readonly context: AssistantMarkdownImageContext;
}

const AssistantMarkdownImageContext =
  createContext<AssistantMarkdownImageContext | null>(null);

export function AssistantMarkdownImageProvider(props: {
  readonly context: AssistantMarkdownImageContext | null;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <AssistantMarkdownImageContext.Provider value={props.context}>
      {props.children}
    </AssistantMarkdownImageContext.Provider>
  );
}

export function AssistantMarkdownImageNode(
  props: Record<string, unknown>,
): ReactNode {
  const context = useContext(AssistantMarkdownImageContext);
  if (context === null) return null;
  const src = typeof props.src === "string" ? props.src : "";
  const alt = typeof props.alt === "string" ? props.alt : "";
  return <AssistantMarkdownImage src={src} alt={alt} context={context} />;
}

/**
 * The `a` renderer for ASSISTANT markdown only - registered beside the `img`
 * one in `text-segment.tsx`, and only for a segment that carries an image
 * context, so every other markdown surface keeps the plain
 * {@link MarkdownAnchor} it has today.
 *
 * A link is not an embed. The only target this takes over is a VIDEO the host
 * resolved to an epic file (D28) - `[the run](files/recordings/x.mp4)` is how
 * an agent embeds a clip, and rendering it as a dead-ish link would be the
 * whole feature missing - plus a resolved-to-nothing target, which gets the
 * same "no longer available" line an image does (D25). Every other kind falls
 * through to the ordinary anchor: an epic-file PDF or log is a file you open,
 * and this ticket adds no new opening seam for it.
 */
export function AssistantMarkdownLinkNode(
  props: Record<string, unknown>,
): ReactNode {
  const context = useContext(AssistantMarkdownImageContext);
  const href = typeof props.href === "string" ? props.href : "";
  const children = props.children as ReactNode;
  const entry =
    context === null ? null : findFileResolution(context.fileResolutions, href);
  if (context !== null && entry !== null) {
    const render = classifyFileResolution(entry);
    // The link TEXT is the only name a link carries; an embed needs one.
    const label = extractText(children).trim();
    if (render === "unavailable") {
      return <FileNoLongerAvailable label={label} />;
    }
    if (render === "video") {
      return (
        <InlineFileVideo entry={entry} epicId={context.epicId} label={label} />
      );
    }
  }
  return (
    <MarkdownAnchor
      // `""` and `undefined` are the same anchor to `MarkdownAnchor`: it drops
      // a blank href rather than letting it navigate to the current document.
      href={href}
      title={typeof props.title === "string" ? props.title : undefined}
      className={
        typeof props.className === "string" ? props.className : undefined
      }
    >
      {children}
    </MarkdownAnchor>
  );
}

function classifyAssistantImageSource(src: string): AssistantImageSource {
  const trimmed = src.trim();
  if (/^https:/i.test(trimmed)) return { kind: "https", src: trimmed };
  if (SVG_DATA_URL_PATTERN.test(trimmed)) {
    return classifySvgDataUrl(trimmed);
  }
  if (/^data:/i.test(trimmed)) {
    const match = RASTER_DATA_URL_PATTERN.exec(trimmed);
    if (match === null) {
      return { kind: "invalid-data", src: trimmed };
    }
    const byteLength = decodedBase64ByteLength(match[2]);
    if (byteLength === null) return { kind: "invalid-data", src: trimmed };
    if (byteLength > MAX_ARTIFACT_IMAGE_BYTES) {
      return { kind: "data-oversized", src: trimmed };
    }
    if (!hasRasterMagic(match[1], match[2])) {
      return { kind: "invalid-data", src: trimmed };
    }
    const pixelCount = rasterPixelCount(match[1], match[2]);
    if (pixelCount === null || pixelCount > MAX_ASSISTANT_IMAGE_PIXELS) {
      return { kind: "data-oversized", src: trimmed };
    }
    return { kind: "data-raster", src: trimmed };
  }
  const decoded = decodeImageSource(trimmed);
  if (
    /^file:/i.test(decoded) ||
    WINDOWS_PATH_PATTERN.test(decoded) ||
    !URI_SCHEME_PATTERN.test(decoded)
  ) {
    return { kind: "local", src: decoded };
  }
  return { kind: "unsupported", src: trimmed };
}

function classifySvgDataUrl(src: string): AssistantImageSource {
  const match = /^data:image\/svg\+xml([^,]*),(.*)$/is.exec(src);
  if (match === null) return { kind: "invalid-data", src };
  const metadata = match[1];
  const payload = match[2];
  let svgSource: string;
  try {
    if (/(?:^|;)base64(?:;|$)/i.test(metadata)) {
      const decodedByteLength = decodedBase64ByteLength(payload);
      if (decodedByteLength === null) return { kind: "invalid-data", src };
      if (decodedByteLength > MAX_SVG_SOURCE_LENGTH) {
        return { kind: "data-oversized", src };
      }
      const bytes = base64ToBytes(payload);
      if (bytes === null) return { kind: "invalid-data", src };
      svgSource = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } else {
      svgSource = decodeURIComponent(payload);
      if (
        new TextEncoder().encode(svgSource).byteLength > MAX_SVG_SOURCE_LENGTH
      ) {
        return { kind: "data-oversized", src };
      }
    }
    const sanitized = sanitizeUntrustedSvg(svgSource);
    const sanitizedBytes = new TextEncoder().encode(sanitized);
    if (sanitizedBytes.byteLength > MAX_ARTIFACT_IMAGE_BYTES) {
      return { kind: "data-oversized", src };
    }
    return {
      kind: "data-svg",
      src:
        sanitized === svgSource
          ? src
          : `data:image/svg+xml;base64,${bytesToBase64(sanitizedBytes)}`,
    };
  } catch {
    return { kind: "invalid-data", src };
  }
}

function decodeImageSource(source: string): string {
  try {
    return decodeURIComponent(source);
  } catch {
    return source;
  }
}

function decodedBase64ByteLength(payload: string): number | null {
  if (payload.length === 0 || payload.length % 4 !== 0) return null;
  let padding = 0;
  if (payload.endsWith("==")) padding = 2;
  else if (payload.endsWith("=")) padding = 1;
  const byteLength = (payload.length / 4) * 3 - padding;
  return byteLength;
}

function rasterPixelCount(mediaType: string, payload: string): number | null {
  const bytes = decodeBase64Prefix(payload, 64 * 1024);
  if (bytes === null) return 0;
  if (mediaType === "image/png" && bytes.length >= 24) {
    return readUint32(bytes, 16) * readUint32(bytes, 20);
  }
  if (mediaType === "image/gif" && bytes.length >= 10) {
    return readUint16(bytes, 6) * readUint16(bytes, 8);
  }
  if (mediaType === "image/webp" && bytes.length >= 30) {
    if (ascii(bytes, 12, 4) === "VP8X") {
      const width = 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16);
      const height = 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16);
      return width * height;
    }
    if (ascii(bytes, 12, 4) === "VP8L" && bytes.length >= 25) {
      const width = 1 + ((bytes[21] | (bytes[22] << 8)) & 0x3fff);
      const height =
        1 +
        (((bytes[22] >> 6) | (bytes[23] << 2) | (bytes[24] << 10)) & 0x3fff);
      return width * height;
    }
    if (ascii(bytes, 12, 4) === "VP8 " && bytes.length >= 30) {
      const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
      const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
      return width * height;
    }
  }
  if (mediaType === "image/jpeg") return jpegPixelCount(bytes);
  return 0;
}

function decodeBase64Prefix(
  payload: string,
  maxBytes: number,
): Uint8Array | null {
  try {
    const binary = atob(payload.slice(0, Math.ceil(maxBytes / 3) * 4));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + (bytes[offset + 1] << 8);
}

function readUint16BigEndian(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) + bytes[offset + 1];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 2 ** 24 +
    bytes[offset + 1] * 2 ** 16 +
    bytes[offset + 2] * 2 ** 8 +
    bytes[offset + 3]
  );
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length));
}

function jpegPixelCount(bytes: Uint8Array): number | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    const length = readUint16BigEndian(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
    if (isSof && length >= 7) {
      return (
        readUint16BigEndian(bytes, offset + 3) *
        readUint16BigEndian(bytes, offset + 5)
      );
    }
    offset += length;
  }
  return null;
}

function hasRasterMagic(mediaType: string, payload: string): boolean {
  let prefix: string;
  try {
    prefix = atob(payload.slice(0, 16));
  } catch {
    return false;
  }
  const byte = (index: number): number => prefix.charCodeAt(index);
  switch (mediaType.toLowerCase()) {
    case "image/png":
      return (
        byte(0) === 0x89 &&
        prefix.slice(1, 4) === "PNG" &&
        byte(4) === 0x0d &&
        byte(5) === 0x0a &&
        byte(6) === 0x1a &&
        byte(7) === 0x0a
      );
    case "image/jpeg":
      return byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff;
    case "image/gif":
      return prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a");
    case "image/webp":
      return prefix.startsWith("RIFF") && prefix.slice(8, 12) === "WEBP";
    default:
      return false;
  }
}

function AssistantMarkdownImage(props: AssistantMarkdownImageProps): ReactNode {
  const source = classifyAssistantImageSource(props.src);
  const scrollToBlock = useScrollToChatBlock();
  const deduplicatedTarget = props.context.deduplicatedTargetsBySource.get(
    source.src,
  );
  if (deduplicatedTarget !== undefined) {
    return (
      <DeduplicatedImageChip
        alt={props.alt}
        target={deduplicatedTarget}
        scrollToBlock={scrollToBlock}
      />
    );
  }
  const resolution = findResolution(props.context.resolutions, source.src);
  if (source.kind === "https") {
    if (resolution !== null) {
      return renderImageResolution(resolution, props.alt);
    }
    return (
      <AttachmentImage
        key={source.src}
        src={source.src}
        alt={props.alt}
        mediaType={null}
        suggestedName={null}
        fullWidth={false}
      />
    );
  }
  if (source.kind === "data-raster") {
    return (
      <AttachmentImage
        key={source.src}
        src={source.src}
        alt={props.alt}
        mediaType={dataMediaType(source.src)}
        suggestedName={null}
        fullWidth={false}
      />
    );
  }
  if (source.kind === "data-svg") {
    return (
      <AttachmentImage
        key={source.src}
        src={source.src}
        alt={props.alt}
        mediaType="image/svg+xml"
        suggestedName={null}
        fullWidth={false}
      />
    );
  }
  if (source.kind === "invalid-data") {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        reason="Couldn't display this image."
      />
    );
  }
  if (source.kind === "data-oversized") {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        reason="This image is too large to show here."
      />
    );
  }
  if (source.kind === "unsupported") {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        reason="Couldn't display this image."
      />
    );
  }

  if (resolution === null) {
    // Only the `local` arm reaches here, and only with no image resolution -
    // which is exactly the PRECEDENCE rule: an `imageResolutions` entry always
    // wins over a `fileResolutions` one for the same target. That record is the
    // released path and carries user-facing decisions a file entry has no way
    // to express (`blocked`, `consent-required`, `oversized`), so a message
    // whose target appears in both must keep rendering the answer it renders
    // today. `https:` and `data:` sources never consult the file record at all.
    const fileEntry = findFileResolution(
      props.context.fileResolutions,
      source.src,
    );
    if (fileEntry !== null) {
      return renderFileResolution(fileEntry, props.context.epicId, props.alt);
    }
    return (
      <AttachmentImageFailure
        alt={props.alt}
        reason="Couldn't display this image."
      />
    );
  }
  return renderImageResolution(resolution, props.alt);
}

/**
 * What one epic-file resolution renders as.
 *
 * `unavailable` is decided STRUCTURALLY rather than by matching the state
 * string: `state` is an open string on the wire (`fileResolutionEntrySchema`)
 * and `path`/`sha256`/`mediaType` are null on every arm that resolved to no
 * object, so "we have an address" is the honest test and an unrecognized
 * future state degrades to the chip instead of to a broken element.
 *
 * `kind === "recording"` decides video ahead of the media type because a
 * recording IS the clip of D14; the family check then covers a plain `.mp4`
 * dropped into `files/` that carries no recording identity.
 */
type FileResolutionRender = "video" | "image" | "unavailable" | "other";

function classifyFileResolution(
  entry: FileResolutionEntry,
): FileResolutionRender {
  if (
    entry.state !== "resolved" ||
    entry.path === null ||
    entry.sha256 === null ||
    entry.mediaType === null
  ) {
    return "unavailable";
  }
  if (entry.kind === "recording") return "video";
  const family = mediaTypeFamily(entry.mediaType);
  if (family === "video") return "video";
  return family === "image" ? "image" : "other";
}

function renderFileResolution(
  entry: FileResolutionEntry,
  epicId: string,
  alt: string,
): ReactNode {
  const render = classifyFileResolution(entry);
  if (render === "unavailable") return <FileNoLongerAvailable label={alt} />;
  if (render === "video") {
    return <InlineFileVideo entry={entry} epicId={epicId} label={alt} />;
  }
  if (render === "image") {
    return <EpicFileImage entry={entry} epicId={epicId} alt={alt} />;
  }
  // A resolved non-image, non-video target written as an IMAGE: unchanged from
  // today, which is the same line a `local` source with no resolution gets.
  return (
    <AttachmentImageFailure alt={alt} reason="Couldn't display this image." />
  );
}

/** D25's chip, in the placeholder styling every other chat failure uses. */
function FileNoLongerAvailable(props: { readonly label: string }): ReactNode {
  return (
    <AttachmentImageFailure
      alt={props.label}
      reason="This file is no longer available."
    />
  );
}

/**
 * The narrowing both video call sites need. `classifyFileResolution` already
 * proved the three address fields non-null, but that proof does not survive
 * the function boundary, so it is re-read here rather than asserted.
 */
function InlineFileVideo(props: {
  readonly entry: FileResolutionEntry;
  readonly epicId: string;
  readonly label: string;
}): ReactNode {
  const { path, sha256, mediaType } = props.entry;
  if (path === null || sha256 === null || mediaType === null) {
    return <FileNoLongerAvailable label={props.label} />;
  }
  return (
    <InlineVideo
      epicId={props.epicId}
      path={path}
      sha256={sha256}
      mediaType={mediaType}
      // A `<video>` has no text of its own, so an empty alt / link text would
      // leave it with no accessible name at all. The manifest key's last
      // segment is the file's name and always non-empty.
      label={
        props.label.length > 0 ? props.label : (path.split("/").pop() ?? path)
      }
    />
  );
}

/**
 * An epic-file image, rendered through the SAME `attachment-image.tsx`
 * primitives as a chat-attachment one - only the byte source differs (ticket
 * 13). A pixel of this must not look different from an image the host ingested
 * as an attachment.
 */
function EpicFileImage(props: {
  readonly entry: FileResolutionEntry;
  readonly epicId: string;
  readonly alt: string;
}): ReactNode {
  const { path, sha256, mediaType } = props.entry;
  const bytes = useFileBytes(
    path === null || sha256 === null || mediaType === null
      ? null
      : {
          kind: "epic-file",
          epicId: props.epicId,
          path,
          sha256,
          mediaType,
        },
  );
  if (path === null || sha256 === null || mediaType === null) {
    return <FileNoLongerAvailable label={props.alt} />;
  }
  if (bytes.status === "loading") {
    return (
      <AttachmentImageLoading label="Waiting for file sync" fullWidth={false} />
    );
  }
  if (bytes.status !== "ready") {
    return <FileNoLongerAvailable label={props.alt} />;
  }
  return (
    <AttachmentImage
      key={bytes.src}
      src={bytes.src}
      // The DELIVERED type, not the manifest's claim - same reason as
      // `ResolvedImage`: `AttachmentImage` gates SVG sanitization on what it is
      // handed, so bytes that are really SVG must not arrive labelled png.
      mediaType={bytes.mediaType}
      alt={props.alt}
      suggestedName={null}
      fullWidth={false}
    />
  );
}

/**
 * Match by EXACT string equality on the entry's `src`, which the host emits as
 * the markdown target verbatim - the same contract `findResolution` matches
 * `imageResolutions` on, and the reason neither side needs to agree on path
 * normalization.
 *
 * Percent-encoding is the one wrinkle, and it is the same one the image record
 * has: the markdown parser encodes a destination before any renderer sees it,
 * so the authored `files/my clip.mp4` arrives here as `files/my%20clip.mp4`
 * while the host recorded what the agent wrote. Both sides are decoded once so
 * either direction matches.
 */
function findFileResolution(
  entries: ReadonlyArray<FileResolutionEntry>,
  source: string,
): FileResolutionEntry | null {
  const trimmed = source.trim();
  if (trimmed.length === 0) return null;
  const decoded = decodeImageSource(trimmed);
  return (
    entries.find(
      (entry) =>
        entry.src === trimmed ||
        entry.src === decoded ||
        decodeImageSource(entry.src) === decoded,
    ) ?? null
  );
}

function renderImageResolution(
  resolution: AssistantMarkdownImageResolution,
  alt: string,
): ReactNode {
  if (resolution.entry.state === "resolved") {
    return (
      <ResolvedImage
        alt={alt}
        hash={resolution.entry.attachmentHash}
        mediaType={resolution.entry.mediaType}
      />
    );
  }
  return (
    <AttachmentImageFailure
      alt={alt}
      reason={resolutionFailureReason(resolution.entry.state)}
    />
  );
}

function findResolution(
  resolutions: ReadonlyArray<AssistantMarkdownImageResolution>,
  source: string,
): AssistantMarkdownImageResolution | null {
  let decoded = source;
  try {
    decoded = decodeURIComponent(source);
  } catch {
    // The host preserves malformed percent escapes as-authored.
  }
  return (
    resolutions.find(
      (resolution) =>
        resolution.entry.source === source ||
        resolution.entry.source === decoded ||
        resolution.entry.canonicalSource === source ||
        resolution.entry.canonicalSource === decoded,
    ) ?? null
  );
}

function resolutionFailureReason(
  state: "blocked" | "consent-required" | "oversized" | "not-found",
): string {
  if (state === "blocked" || state === "consent-required") {
    return "Couldn't display this image.";
  }
  if (state === "oversized") return "This image is too large to show here.";
  return "This image is no longer available.";
}

function ResolvedImage(props: {
  readonly alt: string;
  readonly hash: string;
  readonly mediaType: string;
}): ReactNode {
  const image = useChatAttachmentBlobSrc(props.hash, props.mediaType, null);
  if (image.status === "loading") {
    return (
      <AttachmentImageLoading
        label="Waiting for image sync"
        fullWidth={false}
      />
    );
  }
  if (image.status === "unavailable") {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        reason="This image is no longer available."
      />
    );
  }
  return (
    <AttachmentImage
      key={image.src}
      src={image.src}
      // The resolved blob's OWN type, not `props.mediaType`: the latter is the
      // claim stored on the message, and `AttachmentImage` gates SVG
      // sanitization on what it is handed. A host-sniffed type overrides the
      // claim (see `ImageBlobResolution`), so bytes that are really SVG cannot
      // slip past the gate behind a stored `image/png`.
      mediaType={image.mediaType}
      alt={props.alt}
      suggestedName={null}
      fullWidth={false}
    />
  );
}

function dataMediaType(src: string): string | null {
  const match = /^data:([^;,]+)/i.exec(src);
  return match?.[1] ?? null;
}

function DeduplicatedImageChip(props: {
  readonly alt: string;
  readonly target: AssistantMarkdownImageTarget;
  readonly scrollToBlock: ScrollToChatBlock | null;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={() => {
        const card = mountedGenerationCard(props.target);
        if (card !== null) {
          card.scrollIntoView({ behavior: "smooth", block: "nearest" });
          card.focus({ preventScroll: true });
          return;
        }
        props.scrollToBlock?.(props.target.toolBlockId, "tool");
      }}
      className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-ui-sm text-muted-foreground"
      data-assistant-image-deduplicated
    >
      <Link className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {props.alt.length > 0 ? props.alt : "Generated image"}
      </span>
    </button>
  );
}

function mountedGenerationCard(
  target: AssistantMarkdownImageTarget,
): HTMLElement | null {
  const row = [
    ...document.querySelectorAll<HTMLElement>("[data-message-id]"),
  ].find((element) => element.dataset.messageId === target.rowId);
  if (row === undefined) return null;
  return (
    [...row.querySelectorAll<HTMLElement>("[data-image-generation-card]")].find(
      (element) => element.dataset.imageGenerationCard === target.toolBlockId,
    ) ?? null
  );
}
