import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { CHAT_IMAGE_MAX_EDGE } from "./chat-image-size";
import { ImageLightbox } from "./image-lightbox";
import { useSanitizedSvg } from "./use-sanitized-svg";

export function AttachmentImageLoading(props: {
  readonly label: string;
  readonly fullWidth: boolean;
}): ReactNode {
  return (
    <span
      className="flex aspect-video w-full animate-pulse items-center justify-center bg-muted/60 text-ui-sm text-muted-foreground"
      style={props.fullWidth ? undefined : { maxWidth: CHAT_IMAGE_MAX_EDGE }}
      role="status"
    >
      {props.label}
    </span>
  );
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
}): ReactNode {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  const shouldSanitizeSvg =
    props.mediaType === "image/svg+xml" && !props.src.startsWith("data:");
  const sanitizedSvg = useSanitizedSvg(props.src, shouldSanitizeSvg);
  const effectiveStatus = shouldSanitizeSvg ? sanitizedSvg.status : status;

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
        "group relative my-3 block overflow-hidden rounded-lg border border-border/70 bg-muted/30",
        props.fullWidth ? "w-full" : "w-fit",
      )}
      style={
        props.fullWidth
          ? undefined
          : { maxWidth: `min(100%, ${CHAT_IMAGE_MAX_EDGE})` }
      }
    >
      {effectiveStatus === "loading" ? (
        <span
          className="absolute inset-0 z-10 flex items-center justify-center bg-muted/60 text-ui-sm text-muted-foreground"
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
