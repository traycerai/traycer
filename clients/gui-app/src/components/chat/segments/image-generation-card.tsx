import { useEffect, useRef, useState, type ReactNode } from "react";
import { ImageIcon, ImageOff } from "lucide-react";
import type {
  ImageGenerationResult,
  ToolInputDetail,
} from "@traycer/protocol/persistence/epic/content-blocks";
import { useAttachmentBlobSrc } from "@/lib/attachments/use-attachment-blob-src";
import { cn } from "@/lib/utils";
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
  const failureMessage = generationFailureMessage(
    props.error,
    props.isStreaming,
    props.imageResults.length,
  );
  const hasError = failureMessage !== null;
  const caption =
    props.imageResults.find((result) => result.revisedPrompt !== null)
      ?.revisedPrompt ?? presentation.prompt;
  let body: ReactNode;
  if (failureMessage !== null) {
    body = (
      <GenerationError
        message={failureMessage}
        aspectRatio={presentation.aspectRatio}
      />
    );
  } else if (props.imageResults.length > 0) {
    body = keyedImageResults(props.imageResults).map(({ key, result }) => (
      <GeneratedImage
        key={key}
        result={result}
        fallbackAlt={caption}
        fallbackAspectRatio={presentation.aspectRatio}
      />
    ));
  } else {
    body = <GenerationPending aspectRatio={presentation.aspectRatio} active />;
  }

  return (
    <section
      tabIndex={-1}
      data-image-generation-card={props.id}
      className={cn(
        "w-full max-w-3xl overflow-hidden rounded-xl border border-border/70 bg-card shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
        hasError && "border-destructive/35 saturate-50",
      )}
      aria-label="Image generation"
    >
      <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2 text-ui-sm">
        <ImageIcon className="size-3.5 text-muted-foreground" aria-hidden />
        <span className="font-medium">
          {generationTitle(hasError, props.imageResults.length)}
        </span>
        {props.imageResults.length > 1 ? (
          <span className="text-muted-foreground">
            {props.imageResults.length} results
          </span>
        ) : null}
        {props.isStreaming && !hasError ? (
          <span className="ml-auto text-ui-xs text-muted-foreground">
            In progress
          </span>
        ) : null}
      </header>

      <div
        className={cn(
          "grid w-full gap-px bg-border/50",
          props.imageResults.length > 1 && "sm:grid-cols-2",
        )}
      >
        {body}
      </div>

      {caption.length > 0 ? (
        <p className="border-t border-border/60 px-3 py-2 text-ui-sm leading-relaxed text-muted-foreground">
          {caption}
        </p>
      ) : null}
    </section>
  );
}

function generationFailureMessage(
  error: string | null,
  isStreaming: boolean,
  resultCount: number,
): string | null {
  if (error !== null && error.length > 0) return error;
  if (!isStreaming && resultCount === 0) {
    return "The provider returned no images.";
  }
  return null;
}

function generationTitle(hasError: boolean, resultCount: number): string {
  if (hasError) return "Image generation failed";
  return resultCount > 0 ? "Generated image" : "Generating image";
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

function GenerationPending(props: {
  readonly aspectRatio: number;
  readonly active: boolean;
}): ReactNode {
  return (
    <div
      className="relative w-full overflow-hidden bg-muted/50"
      style={{ aspectRatio: props.aspectRatio }}
      role={props.active ? "status" : undefined}
      aria-label={props.active ? "Generating image" : undefined}
      aria-hidden={props.active ? undefined : true}
    >
      <div className="absolute inset-0 scale-110 bg-[radial-gradient(circle_at_25%_25%,color-mix(in_oklab,var(--primary)_22%,transparent),transparent_42%),radial-gradient(circle_at_75%_70%,color-mix(in_oklab,var(--muted-foreground)_18%,transparent),transparent_45%)] blur-2xl motion-reduce:blur-xl" />
      <div className="absolute inset-[12%] rounded-[30%] bg-primary/10 blur-xl" />
      <DitherCanvas />
    </div>
  );
}

function DitherCanvas(): ReactNode {
  const ref = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const draw = (): void => drawDither(canvas);
    draw();
    const observer = new MutationObserver(draw);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <canvas
      ref={ref}
      width={96}
      height={96}
      className="absolute inset-0 size-full animate-pulse opacity-55 mix-blend-soft-light [image-rendering:pixelated] motion-reduce:animate-none"
      aria-hidden
    />
  );
}

function drawDither(canvas: HTMLCanvasElement): void {
  const context = canvas.getContext("2d");
  if (context === null) return;
  const styles = getComputedStyle(canvas);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = styles.color;
  for (let y = 0; y < canvas.height; y += 4) {
    for (let x = 0; x < canvas.width; x += 4) {
      const wave = Math.sin(x * 0.13) + Math.cos(y * 0.17);
      if (wave + ((x * 17 + y * 29) % 7) / 4 > 0.8) {
        context.fillRect(x, y, 2, 2);
      }
    }
  }
}

function GeneratedImage(props: {
  readonly result: ImageGenerationResult;
  readonly fallbackAlt: string;
  readonly fallbackAspectRatio: number;
}): ReactNode {
  const image = useAttachmentBlobSrc(
    props.result.attachmentHash,
    props.result.mediaType,
    null,
  );
  const [loaded, setLoaded] = useState(false);
  const aspectRatio = resultAspectRatio(
    props.result,
    props.fallbackAspectRatio,
  );
  const alt =
    props.result.alt ?? props.result.revisedPrompt ?? props.fallbackAlt;

  if (image.status !== "ready") {
    return (
      <div
        className="flex w-full items-center justify-center bg-muted/50 text-ui-sm text-muted-foreground"
        style={{ aspectRatio }}
        role="status"
      >
        Waiting for image sync
      </div>
    );
  }

  return (
    <figure className="relative w-full bg-muted/30" style={{ aspectRatio }}>
      <ImageLightbox
        src={image.src}
        alt={alt.length > 0 ? alt : "Generated image"}
        mediaType={props.result.mediaType}
        suggestedName={generatedImageName(props.result)}
        className="size-full overflow-hidden"
      >
        {loaded ? null : (
          <GenerationPending aspectRatio={aspectRatio} active={false} />
        )}
        <img
          src={image.src}
          alt={alt.length > 0 ? alt : "Generated image"}
          className={cn(
            "absolute inset-0 size-full object-contain transition-opacity duration-500 motion-reduce:transition-none",
            loaded ? "opacity-100" : "opacity-0",
          )}
          draggable={false}
          onLoad={() => setLoaded(true)}
        />
      </ImageLightbox>
      {props.result.width !== null && props.result.height !== null ? (
        <span className="absolute bottom-2 right-2 rounded-md border border-white/20 bg-black/65 px-1.5 py-0.5 text-[0.6875rem] font-medium tabular-nums text-white shadow-sm backdrop-blur-sm">
          {props.result.width} × {props.result.height}
        </span>
      ) : null}
    </figure>
  );
}

function generatedImageName(result: ImageGenerationResult): string | null {
  if (result.filePath === null) return null;
  const name = result.filePath.split(/[\\/]/).at(-1);
  return name === undefined || name.length === 0 ? null : name;
}

function GenerationError(props: {
  readonly message: string;
  readonly aspectRatio: number;
}): ReactNode {
  return (
    <div
      className="flex w-full flex-col items-center justify-center gap-2 bg-muted/50 px-6 py-10 text-center text-muted-foreground"
      style={{ aspectRatio: props.aspectRatio }}
      role="status"
    >
      <ImageOff className="size-7 text-destructive/70" aria-hidden />
      <p className="max-w-prose text-ui-sm">{props.message}</p>
      <p className="text-ui-xs">Ask the agent to try again.</p>
    </div>
  );
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
