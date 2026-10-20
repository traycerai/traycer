import { useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useChatAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import { CHAT_IMAGE_MAX_EDGE } from "./chat-image-size";
import { ImageLightbox } from "./image-lightbox";
import {
  recordedImageFrame,
  type RecordedImageFrame,
} from "./image-result-presentation";
import { useSanitizedSvg } from "./use-sanitized-svg";

export function AttachmentImageLoading(props: {
  readonly label: string;
  readonly fullWidth: boolean;
  readonly width: number | null;
  readonly height: number | null;
}): ReactNode {
  const frame = recordedImageFrame(props);
  return (
    <span
      className={cn(
        "flex w-[var(--image-width)] aspect-[var(--image-aspect)] animate-pulse items-center justify-center bg-foreground/10 text-ui-sm text-muted-foreground",
        !props.fullWidth && "max-w-[var(--image-max-edge)]",
        frame !== null && "my-3 rounded-lg border border-border/70",
      )}
      style={
        {
          "--image-width": imageFrameWidth(props.fullWidth, frame),
          "--image-aspect": frame?.aspectRatio ?? 16 / 9,
          "--image-max-edge": CHAT_IMAGE_MAX_EDGE,
        } as CSSProperties
      }
      role="status"
    >
      {props.label}
    </span>
  );
}

function imageFrameWidth(
  fullWidth: boolean,
  frame: RecordedImageFrame | null,
): string {
  if (fullWidth || frame === null) return "100%";
  return `min(100%, ${frame.width}px, ${CHAT_IMAGE_MAX_EDGE}, calc(${CHAT_IMAGE_MAX_EDGE} * ${frame.aspectRatio}))`;
}

function readyFrameWidthClass(
  fullWidth: boolean,
  frame: RecordedImageFrame | null,
): string {
  if (fullWidth) return "w-full";
  if (frame !== null)
    return "w-[var(--image-width)] max-w-[var(--image-max-edge)]";
  return "w-fit max-w-[min(100%,var(--image-max-edge))]";
}

function imageIntrinsicSize(frame: RecordedImageFrame | null): {
  readonly width: number | undefined;
  readonly height: number | undefined;
} {
  if (frame === null) return { width: undefined, height: undefined };
  return { width: frame.width, height: frame.height };
}

export function AttachmentImageFailure(props: {
  readonly alt: string;
  readonly reason: string;
}): ReactNode {
  return (
    <span
      className="my-2 inline-block max-w-full text-ui-sm leading-relaxed text-muted-foreground"
      role="status"
      aria-label={
        props.alt.length > 0 ? `${props.alt}: ${props.reason}` : props.reason
      }
      data-assistant-image-failure
    >
      {props.reason}
    </span>
  );
}

export function AttachmentImage(props: {
  readonly alt: string;
  readonly src: string;
  readonly mediaType: string | null;
  readonly suggestedName: string | null;
  readonly fullWidth: boolean;
  readonly width: number | null;
  readonly height: number | null;
}): ReactNode {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const shouldSanitizeSvg =
    props.mediaType === "image/svg+xml" && !props.src.startsWith("data:");
  const sanitizedSvg = useSanitizedSvg(props.src, shouldSanitizeSvg);
  const effectiveStatus = shouldSanitizeSvg ? sanitizedSvg.status : status;
  const frame = recordedImageFrame(props);
  const intrinsicSize = imageIntrinsicSize(frame);

  if (effectiveStatus === "error") {
    return (
      <span className="inline-flex max-w-full items-center gap-2">
        <AttachmentImageFailure
          alt={props.alt}
          reason={
            props.mediaType === "image/svg+xml"
              ? "Couldn't display this SVG."
              : "Couldn't display this image."
          }
        />
      </span>
    );
  }
  return (
    <span
      className={cn(
        "group relative my-3 block overflow-hidden rounded-lg border border-border/70 bg-foreground/6",
        readyFrameWidthClass(props.fullWidth, frame),
        frame !== null && "aspect-[var(--image-aspect)]",
      )}
      style={
        {
          "--image-width": imageFrameWidth(props.fullWidth, frame),
          "--image-aspect": frame?.aspectRatio,
          "--image-max-edge": CHAT_IMAGE_MAX_EDGE,
        } as CSSProperties
      }
    >
      {effectiveStatus === "loading" ? (
        <span
          className="absolute inset-0 z-10 flex items-center justify-center bg-foreground/10 text-ui-sm text-muted-foreground"
          role="status"
        >
          Loading image
        </span>
      ) : null}
      {shouldSanitizeSvg && sanitizedSvg.src === null ? null : (
        <ImageLightbox
          src={props.src}
          alt={props.alt}
          mediaType={props.mediaType}
          suggestedName={props.suggestedName}
          className={props.fullWidth ? "w-full" : "w-fit max-w-full"}
        >
          <img
            src={shouldSanitizeSvg ? (sanitizedSvg.src ?? "") : props.src}
            alt={props.alt}
            width={intrinsicSize.width}
            height={intrinsicSize.height}
            className={cn(
              "block h-auto object-contain",
              props.fullWidth ? "w-full" : "w-auto max-w-full",
              effectiveStatus === "loading" && "opacity-0",
            )}
            style={
              props.fullWidth
                ? undefined
                : {
                    maxHeight: CHAT_IMAGE_MAX_EDGE,
                    maxWidth: `min(100%, ${CHAT_IMAGE_MAX_EDGE})`,
                  }
            }
            draggable={false}
            onLoad={() => setStatus("ready")}
            onError={() => setStatus("error")}
          />
        </ImageLightbox>
      )}
    </span>
  );
}

export function ResolvedImage(props: {
  readonly alt: string;
  readonly hash: string;
  readonly mediaType: string;
  readonly suggestedName: string | null;
  readonly width: number | null;
  readonly height: number | null;
}): ReactNode {
  const image = useChatAttachmentBlobSrc(props.hash, props.mediaType, null);
  if (image.status === "loading") {
    return (
      <AttachmentImageLoading
        label="Waiting for image sync"
        fullWidth={false}
        width={props.width}
        height={props.height}
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
      suggestedName={props.suggestedName}
      fullWidth={false}
      width={props.width}
      height={props.height}
    />
  );
}
