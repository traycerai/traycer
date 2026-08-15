import { createContext, useContext, type ReactNode } from "react";
import { Link } from "lucide-react";
import { MAX_ARTIFACT_IMAGE_BYTES } from "@traycer/protocol/host/epic/unary-schemas";
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
    return (
      <AttachmentImageFailure
        alt={props.alt}
        reason="Couldn't display this image."
      />
    );
  }
  return renderImageResolution(resolution, props.alt);
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
