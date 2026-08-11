import { useState, type ReactNode } from "react";
import { ImageOff } from "lucide-react";
import {
  AddImageToArtifactButton,
  type AddToArtifactImageSource,
} from "@/components/artifacts/add-image-to-artifact-button";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import { cn } from "@/lib/utils";
import { ImageLightbox } from "./image-lightbox";

export function AttachmentImageLoading(props: {
  readonly label: string;
}): ReactNode {
  return (
    <span
      className="flex aspect-video w-full animate-pulse items-center justify-center bg-muted/60 text-ui-sm text-muted-foreground"
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
          reason="Image could not be loaded"
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
    <div className="group relative my-3 w-full max-w-3xl overflow-hidden rounded-lg border border-border/70 bg-muted/30">
      {props.addToArtifactSource === null ? null : (
        <AddImageToArtifactButton
          source={props.addToArtifactSource}
          alt={props.alt}
          className="absolute right-2 top-2 z-10"
        />
      )}
      {status === "loading" ? (
        <AttachmentImageLoading label="Loading image" />
      ) : null}
      <ImageLightbox
        src={props.src}
        alt={props.alt}
        mediaType={props.mediaType}
        suggestedName={props.suggestedName}
        className={status === "loading" ? "absolute inset-0" : undefined}
      >
        <img
          src={props.src}
          alt={props.alt}
          className={cn(
            status === "loading"
              ? "size-full object-contain opacity-0"
              : "block max-h-[70vh] max-w-full object-contain",
          )}
          draggable={false}
          onLoad={() => setStatus("ready")}
          onError={() => setStatus("error")}
        />
      </ImageLightbox>
    </div>
  );
}
