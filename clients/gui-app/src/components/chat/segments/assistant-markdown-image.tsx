import { useState, type ReactNode } from "react";
import { ImageOff, Link, ShieldQuestion } from "lucide-react";
import type { RequestImageIngestRequest } from "@traycer/protocol/host/agent/gui/unary-schemas";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { useHostMutation } from "@/hooks/host/use-host-query";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import { epicMutationKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { AssistantMarkdownImageResolution } from "@/stores/composer/chat-store";

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
  readonly epicId: string;
  readonly chatId: string;
  readonly resolutions: ReadonlyArray<AssistantMarkdownImageResolution>;
  readonly deduplicatedSources: ReadonlySet<string>;
}

function classifyAssistantImageSource(src: string): AssistantImageSource {
  const trimmed = src.trim();
  if (/^https:/i.test(trimmed)) return { kind: "https", src: trimmed };
  if (SVG_DATA_URL_PATTERN.test(trimmed)) {
    return { kind: "data-svg", src: trimmed };
  }
  if (/^data:/i.test(trimmed)) {
    const match = RASTER_DATA_URL_PATTERN.exec(trimmed);
    if (match === null || decodedBase64ByteLength(match[2]) === null) {
      return { kind: "invalid-data", src: trimmed };
    }
    return { kind: "data-raster", src: trimmed };
  }
  if (
    /^file:/i.test(trimmed) ||
    WINDOWS_PATH_PATTERN.test(trimmed) ||
    !URI_SCHEME_PATTERN.test(trimmed)
  ) {
    return { kind: "local", src: trimmed };
  }
  return { kind: "unsupported", src: trimmed };
}

function decodedBase64ByteLength(payload: string): number | null {
  if (payload.length === 0 || payload.length % 4 !== 0) return null;
  let padding = 0;
  if (payload.endsWith("==")) padding = 2;
  else if (payload.endsWith("=")) padding = 1;
  const byteLength = (payload.length / 4) * 3 - padding;
  return byteLength <= MAX_INLINE_IMAGE_BYTES ? byteLength : null;
}

export function AssistantMarkdownImage(
  props: AssistantMarkdownImageProps,
): ReactNode {
  const source = classifyAssistantImageSource(props.src);
  if (props.deduplicatedSources.has(source.src)) {
    return <DeduplicatedImageChip alt={props.alt} />;
  }
  if (source.kind === "https" || source.kind === "data-raster") {
    return <LoadableImage key={source.src} src={source.src} alt={props.alt} />;
  }
  if (source.kind === "data-svg") {
    return (
      <ImageFailureChip
        alt={props.alt}
        source={source.src}
        reason="SVG preview will be available with the secure SVG viewer"
      />
    );
  }
  if (source.kind === "invalid-data") {
    return (
      <ImageFailureChip
        alt={props.alt}
        source={source.src}
        reason="Inline image is invalid or exceeds the 30 MB limit"
      />
    );
  }
  if (source.kind === "unsupported") {
    return (
      <ImageFailureChip
        alt={props.alt}
        source={source.src}
        reason="Unsupported image source"
      />
    );
  }

  const resolution = findResolution(props.resolutions, source.src);
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
          epicId: props.epicId,
          chatId: props.chatId,
          messageId: resolution.messageId,
          source: resolution.entry.canonicalSource,
        }}
      />
    );
  }
  return (
    <ImageFailureChip
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
    return <ImageLoadingSkeleton label="Waiting for image sync" />;
  }
  return <LoadableImage key={image.src} src={image.src} alt={props.alt} />;
}

function LoadableImage(props: {
  readonly alt: string;
  readonly src: string;
}): ReactNode {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  if (status === "error") {
    return (
      <ImageFailureChip
        alt={props.alt}
        source={props.src}
        reason="Image could not be loaded"
      />
    );
  }
  return (
    <span className="relative my-3 block w-full max-w-3xl overflow-hidden rounded-lg border border-border/70 bg-muted/30">
      {status === "loading" ? (
        <ImageLoadingSkeleton label="Loading image" />
      ) : null}
      <img
        src={props.src}
        alt={props.alt}
        className={cn(
          status === "loading"
            ? "absolute inset-0 size-full object-contain opacity-0"
            : "block max-h-[70vh] max-w-full object-contain",
        )}
        draggable={false}
        onLoad={() => setStatus("ready")}
        onError={() => setStatus("error")}
      />
    </span>
  );
}

function ImageLoadingSkeleton(props: { readonly label: string }): ReactNode {
  return (
    <span
      className="flex aspect-video w-full animate-pulse items-center justify-center bg-muted/60 text-ui-sm text-muted-foreground"
      role="status"
    >
      {props.label}
    </span>
  );
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
      <ImageFailureChip
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

function ImageFailureChip(props: {
  readonly alt: string;
  readonly source: string;
  readonly reason: string;
}): ReactNode {
  const chip = (
    <span
      className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-destructive/30 bg-destructive/5 px-2 py-1 text-ui-sm text-muted-foreground"
      role="status"
      data-assistant-image-failure
    >
      <ImageOff className="size-3.5 shrink-0 text-destructive" aria-hidden />
      <span className="truncate">
        {props.alt.length > 0 ? props.alt : "Image"}: {props.reason}
      </span>
    </span>
  );
  return (
    <TooltipWrapper
      label={`${props.reason}: ${props.source}`}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      {chip}
    </TooltipWrapper>
  );
}

function DeduplicatedImageChip(props: { readonly alt: string }): ReactNode {
  return (
    <span
      className="my-2 inline-flex max-w-full items-center gap-1.5 rounded-md border border-border/70 bg-muted/40 px-2 py-1 text-ui-sm text-muted-foreground"
      data-assistant-image-deduplicated
    >
      <Link className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        {props.alt.length > 0 ? props.alt : "Generated image"}
      </span>
    </span>
  );
}
