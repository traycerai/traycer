import { useState, type ReactNode } from "react";
import {
  AddImageToArtifactButton,
  type AddToArtifactImageSource,
} from "@/components/artifacts/add-image-to-artifact-button";
import { cn } from "@/lib/utils";
import { CHAT_IMAGE_MAX_EDGE } from "./chat-image-size";
import { ImageLightbox } from "./image-lightbox";

export function AttachmentImageLoading(props: {
  readonly label: string;
}): ReactNode {
  return (
    <span
      className="flex aspect-video w-full animate-pulse items-center justify-center bg-muted/60 text-ui-sm text-muted-foreground"
      style={{ maxWidth: CHAT_IMAGE_MAX_EDGE }}
      role="status"
    >
      {props.label}
    </span>
  );
}

export function AttachmentImageFailure(props: {
  readonly alt: string;
  readonly source: string;
  readonly reason: string;
}): ReactNode {
  return (
    <span
      className="my-2 inline-block max-w-full text-ui-sm leading-relaxed text-muted-foreground"
      role="status"
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
  readonly addToArtifactSource: AddToArtifactImageSource | null;
}): ReactNode {
  const [status, setStatus] = useState<"loading" | "ready" | "error">(
    "loading",
  );
  if (status === "error") {
    return (
      <span className="group inline-flex max-w-full items-center gap-2">
        <AttachmentImageFailure
          alt={props.alt}
          source={props.src}
          reason={
            props.mediaType === "image/svg+xml"
              ? "Couldn't display this SVG."
              : "Couldn't display this image."
          }
        />
        {props.addToArtifactSource === null ? null : (
          <AddImageToArtifactButton
            source={props.addToArtifactSource}
            alt={props.alt}
            className="shrink-0"
          />
        )}
      </span>
    );
  }
  return (
    <div className="group relative my-3 w-fit max-w-full overflow-hidden rounded-lg border border-border/70 bg-muted/30">
      {props.addToArtifactSource === null ? null : (
        <AddImageToArtifactButton
          source={props.addToArtifactSource}
          alt={props.alt}
          className="absolute right-2 top-2 z-10"
        />
      )}
      {status === "loading" ? (
        <span
          className="absolute inset-0 z-10 flex items-center justify-center bg-muted/60 text-ui-sm text-muted-foreground"
          role="status"
        >
          Loading image
        </span>
      ) : null}
      <ImageLightbox
        src={props.src}
        alt={props.alt}
        mediaType={props.mediaType}
        suggestedName={props.suggestedName}
        className="w-fit max-w-full"
      >
        <img
          src={props.src}
          alt={props.alt}
          className={cn(
            "block h-auto w-auto max-w-full object-contain",
            status === "loading" && "opacity-0",
          )}
          style={{
            maxHeight: CHAT_IMAGE_MAX_EDGE,
            maxWidth: `min(100%, ${CHAT_IMAGE_MAX_EDGE})`,
          }}
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
        />
      </ImageLightbox>
    </div>
  );
}
