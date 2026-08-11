import { type CSSProperties, type ReactNode } from "react";
import type {
  ImageGenerationResult,
  ToolInputDetail,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { AddImageToArtifactButton } from "@/components/artifacts/add-image-to-artifact-button";
import { useAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import { cn } from "@/lib/utils";
import { CHAT_IMAGE_MAX_EDGE } from "./chat-image-size";
import {
  ImageGeneration,
  type ImageGenerationStatus,
} from "./image-generation/image-generation";
import { ImageLightbox } from "./image-lightbox";

interface ImageGenerationCardProps {
  readonly id: string;
  readonly inputSummary: string | null;
  readonly inputDetail: ToolInputDetail | null;
  readonly error: string | null;
  readonly isStreaming: boolean;
  readonly imageResults: ReadonlyArray<ImageGenerationResult>;
}

interface GenerationPresentation {
  readonly aspectRatio: number;
  readonly prompt: string;
}

interface KeyedImageResult {
  readonly key: string;
  readonly result: ImageGenerationResult;
}

export function ImageGenerationCard(
  props: ImageGenerationCardProps,
): ReactNode {
  const presentation = generationPresentation(
    props.inputSummary,
    props.inputDetail,
  );
  const caption =
    props.imageResults.find((result) => result.revisedPrompt !== null)
      ?.revisedPrompt ?? presentation.prompt;
  const status = generationStatus(
    props.error,
    props.isStreaming,
    props.imageResults.length,
  );
  const results = keyedImageResults(props.imageResults);

  return (
    <section
      tabIndex={-1}
      data-image-generation-card={props.id}
      className="w-fit max-w-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      aria-label="Image generation"
    >
      <div
        className={cn(
          "grid w-fit max-w-full gap-4",
          results.length > 1 && "sm:grid-cols-2",
        )}
      >
        {results.length > 0 ? (
          results.map(({ key, result }) => (
            <GenerationCell
              key={key}
              result={result}
              status={status}
              prompt={caption}
              fallbackAspectRatio={presentation.aspectRatio}
            />
          ))
        ) : (
          <GenerationCell
            result={null}
            status={status}
            prompt={caption}
            fallbackAspectRatio={presentation.aspectRatio}
          />
        )}
      </div>
    </section>
  );
}

function GenerationCell(props: {
  readonly result: ImageGenerationResult | null;
  readonly status: ImageGenerationStatus;
  readonly prompt: string;
  readonly fallbackAspectRatio: number;
}): ReactNode {
  const aspectRatio =
    props.result === null
      ? props.fallbackAspectRatio
      : resultAspectRatio(props.result, props.fallbackAspectRatio);
  const resolution =
    props.result !== null &&
    props.result.width !== null &&
    props.result.height !== null
      ? `${props.result.width} × ${props.result.height}`
      : "";

  return (
    <ImageGeneration
      status={props.status}
      prompt={props.prompt}
      resolution={resolution}
      aspectRatio={aspectRatio}
      size="fluid"
      mediaStyle={generationFrameStyle(props.result, aspectRatio)}
    >
      {props.result === null ? null : (
        <GeneratedImageContent
          result={props.result}
          fallbackAlt={props.prompt}
        />
      )}
    </ImageGeneration>
  );
}

function generationStatus(
  error: string | null,
  isStreaming: boolean,
  resultCount: number,
): ImageGenerationStatus {
  if (resultCount > 0) return "complete";
  if (error !== null || !isStreaming) return "error";
  return "generating";
}

function keyedImageResults(
  results: ReadonlyArray<ImageGenerationResult>,
): ReadonlyArray<KeyedImageResult> {
  const occurrencesByHash = new Map<string, number>();
  return results.map((result) => {
    const occurrence = occurrencesByHash.get(result.attachmentHash) ?? 0;
    occurrencesByHash.set(result.attachmentHash, occurrence + 1);
    return {
      key: `${result.attachmentHash}:${occurrence}`,
      result,
    };
  });
}

function GeneratedImageContent(props: {
  readonly result: ImageGenerationResult;
  readonly fallbackAlt: string;
}): ReactNode {
  const image = useAttachmentBlobSrc(
    props.result.attachmentHash,
    props.result.mediaType,
    null,
  );
  const alt =
    props.result.alt ?? props.result.revisedPrompt ?? props.fallbackAlt;

  if (image.status !== "ready") {
    return (
      <div className="flex items-center justify-center text-ui-sm text-muted-foreground">
        Waiting for image sync
      </div>
    );
  }

  return (
    <div className="group relative size-full">
      <AddImageToArtifactButton
        source={{ kind: "client", url: image.src }}
        alt={alt.length > 0 ? alt : "Generated image"}
        className="absolute right-2 top-2 z-10"
      />
      <ImageLightbox
        src={image.src}
        alt={alt.length > 0 ? alt : "Generated image"}
        mediaType={props.result.mediaType}
        suggestedName={generatedImageName(props.result)}
        className="size-full overflow-hidden"
      >
        <img
          src={image.src}
          alt={alt.length > 0 ? alt : "Generated image"}
          className="block h-auto w-auto max-h-full max-w-full object-contain"
          style={{
            maxHeight: CHAT_IMAGE_MAX_EDGE,
            maxWidth: `min(100%, ${CHAT_IMAGE_MAX_EDGE})`,
          }}
          draggable={false}
        />
      </ImageLightbox>
    </div>
  );
}

function generatedImageName(result: ImageGenerationResult): string | null {
  if (result.filePath === null) return null;
  const name = result.filePath.split(/[\\/]/).at(-1);
  return name === undefined || name.length === 0 ? null : name;
}

function generationPresentation(
  inputSummary: string | null,
  inputDetail: ToolInputDetail | null,
): GenerationPresentation {
  if (inputDetail?.kind !== "fields") {
    return { aspectRatio: 1, prompt: inputSummary ?? "" };
  }
  const prompt =
    inputDetail.entries.find((entry) => entry.key === "prompt")?.value ??
    inputSummary ??
    "";
  const ratioHint = inputDetail.entries.find((entry) =>
    ["aspect_ratio", "aspectRatio", "size"].includes(entry.key),
  )?.value;
  return { aspectRatio: parseAspectRatio(ratioHint), prompt };
}

function parseAspectRatio(value: string | undefined): number {
  if (value === undefined) return 1;
  const match = /^(\d+(?:\.\d+)?)\s*(?::|x|×)\s*(\d+(?:\.\d+)?)$/i.exec(
    value.trim(),
  );
  if (match === null) return 1;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return 1;
  return Math.min(4, Math.max(0.25, width / height));
}

function resultAspectRatio(
  result: ImageGenerationResult,
  fallback: number,
): number {
  if (result.width === null || result.height === null || result.height <= 0) {
    return fallback;
  }
  return Math.min(4, Math.max(0.25, result.width / result.height));
}

function generationFrameStyle(
  result: ImageGenerationResult | null,
  aspectRatio: number,
): CSSProperties {
  const intrinsicWidth =
    result !== null && result.width !== null && result.width > 0
      ? `${result.width}px`
      : CHAT_IMAGE_MAX_EDGE;
  return {
    width: `min(${intrinsicWidth}, ${CHAT_IMAGE_MAX_EDGE}, calc(${CHAT_IMAGE_MAX_EDGE} * ${aspectRatio}))`,
    maxHeight: CHAT_IMAGE_MAX_EDGE,
  };
}
