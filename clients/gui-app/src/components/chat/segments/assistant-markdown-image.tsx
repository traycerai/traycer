import { createContext, useContext, type ReactNode } from "react";
import { Link, ShieldQuestion } from "lucide-react";
import type { RequestImageIngestRequest } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import { epicMutationKeys } from "@/lib/query-keys";
import type {
  AssistantMarkdownImageContext,
  AssistantMarkdownImageResolution,
} from "@/stores/composer/chat-store";
import {
  AttachmentImage,
  AttachmentImageFailure,
  AttachmentImageLoading,
} from "./attachment-image";

const MAX_INLINE_IMAGE_BYTES = 30 * 1024 * 1024;
const RASTER_DATA_URL_PATTERN =
  /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z\d+/]+={0,2})$/i;
const SVG_DATA_URL_PATTERN = /^data:image\/svg\+xml(?:[;,])/i;
const URI_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const WINDOWS_PATH_PATTERN = /^(?:[a-z]:[\\/]|\\\\)/i;

type AssistantImageSource =
  | { readonly kind: "https"; readonly src: string }
  | { readonly kind: "data-raster"; readonly src: string }
  | { readonly kind: "data-svg"; readonly src: string }
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
    return { kind: "data-svg", src: trimmed };
  }
  if (/^data:/i.test(trimmed)) {
    const match = RASTER_DATA_URL_PATTERN.exec(trimmed);
    if (
      match === null ||
      decodedBase64ByteLength(match[2]) === null ||
      !hasRasterMagic(match[1], match[2])
    ) {
      return { kind: "invalid-data", src: trimmed };
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
  return byteLength <= MAX_INLINE_IMAGE_BYTES ? byteLength : null;
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
  if (props.context.deduplicatedSources.has(source.src)) {
    return <DeduplicatedImageChip alt={props.alt} />;
  }
  if (source.kind === "https" || source.kind === "data-raster") {
    return (
      <AttachmentImage
        key={source.src}
        src={source.src}
        alt={props.alt}
        mediaType={
          source.kind === "data-raster" ? dataMediaType(source.src) : null
        }
        suggestedName={null}
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
      />
    );
  }
  if (source.kind === "invalid-data") {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        source={source.src}
        reason="Inline image is invalid or exceeds the 30 MB limit"
      />
    );
  }
  if (source.kind === "unsupported") {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        source={source.src}
        reason="Unsupported image source"
      />
    );
  }

  const resolution = findResolution(props.context.resolutions, source.src);
  if (resolution === null) {
    return (
      <ConsentImageChip alt={props.alt} source={source.src} request={null} />
    );
  }
  if (resolution.entry.state === "resolved") {
    return (
      <ResolvedImage
        alt={props.alt}
        hash={resolution.entry.attachmentHash}
        mediaType={resolution.entry.mediaType}
      />
    );
  }
  if (resolution.entry.state === "consent-required") {
    return (
      <ConsentImageChip
        alt={props.alt}
        source={source.src}
        request={{
          epicId: props.context.epicId,
          chatId: props.context.chatId,
          messageId: resolution.messageId,
          source: resolution.entry.canonicalSource,
        }}
      />
    );
  }
  return (
    <AttachmentImageFailure
      alt={props.alt}
      source={source.src}
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
  state: "blocked" | "oversized" | "not-found",
): string {
  if (state === "blocked") return "Image blocked by policy";
  if (state === "oversized") return "Image exceeds the 30 MB limit";
  return "Image not found";
}

function ResolvedImage(props: {
  readonly alt: string;
  readonly hash: string;
  readonly mediaType: string;
}): ReactNode {
  const image = useAttachmentBlobSrc(props.hash, props.mediaType, null);
  if (image.status !== "ready") {
    return <AttachmentImageLoading label="Waiting for image sync" />;
  }
  return (
    <AttachmentImage
      key={image.src}
      src={image.src}
      alt={props.alt}
      mediaType={props.mediaType}
      suggestedName={null}
    />
  );
}

function dataMediaType(src: string): string | null {
  const match = /^data:([^;,]+)/i.exec(src);
  return match?.[1] ?? null;
}

function ConsentImageChip(props: {
  readonly alt: string;
  readonly source: string;
  readonly request: RequestImageIngestRequest | null;
}): ReactNode {
  const client = useTabHostClient();
  const mutation = useHostMutation<HostRpcRegistry, "chat.requestImageIngest">({
    client,
    method: "chat.requestImageIngest",
    mapVariables: (variables) => variables,
    options: {
      mutationKey: epicMutationKeys.requestImageIngest(
        props.request?.epicId ?? "",
        props.request?.chatId ?? "",
        props.request?.messageId ?? "",
        props.request?.source ?? props.source,
      ),
    },
  });
  if (mutation.error !== null) {
    return (
      <AttachmentImageFailure
        alt={props.alt}
        source={props.source}
        reason="Image load request failed"
      />
    );
  }
  const button = (
    <button
      type="button"
      disabled={props.request === null || mutation.isPending}
      onClick={() => {
        if (props.request !== null) mutation.mutate(props.request);
      }}
      className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-left text-ui-sm text-muted-foreground transition-colors enabled:hover:border-foreground/30 enabled:hover:text-foreground disabled:cursor-default"
      data-assistant-image-consent
    >
      {mutation.isPending ? (
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
        />
      ) : (
        <ShieldQuestion className="size-3.5 shrink-0" aria-hidden />
      )}
      <span className="truncate">
        {props.alt.length > 0 ? props.alt : "Load local image"}
      </span>
    </button>
  );
  return (
    <TooltipWrapper
      label={props.source}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {button}
    </TooltipWrapper>
  );
}

function DeduplicatedImageChip(props: { readonly alt: string }): ReactNode {
  return (
    <button
      type="button"
      onClick={(event) => {
        const card = event.currentTarget
          .closest("[data-assistant-turn]")
          ?.querySelector<HTMLElement>("[data-image-generation-card]");
        card?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        card?.focus({ preventScroll: true });
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
