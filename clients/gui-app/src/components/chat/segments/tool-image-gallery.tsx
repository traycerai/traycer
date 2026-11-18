import type { ReactNode } from "react";
import type { ImageGenerationResult } from "@traycer/protocol/persistence/epic/content-blocks";
import { chatFindToolImageGalleryUnitId } from "@/components/chat/chat-find";
import { ResolvedImage } from "./attachment-image";
import {
  genericToolImageCaption,
  imageResultFileName,
} from "./image-result-presentation";

export function ToolImageGallery(props: {
  readonly id: string;
  readonly imageResults: ReadonlyArray<ImageGenerationResult>;
}): ReactNode {
  if (props.imageResults.length === 0) return null;
  const keyCounts = new Map<string, number>();
  return (
    <div
      data-chat-find-unit={chatFindToolImageGalleryUnitId(props.id)}
      className="flex w-full min-w-0 flex-col gap-2"
    >
      {props.imageResults.map((result, index) => {
        const caption = genericToolImageCaption(result, index);
        const occurrence = keyCounts.get(result.attachmentHash) ?? 0;
        keyCounts.set(result.attachmentHash, occurrence + 1);
        return (
          <figure
            key={`${result.attachmentHash}-${occurrence}`}
            className="min-w-0"
          >
            <div data-find-skip>
              <ResolvedImage
                alt={caption}
                hash={result.attachmentHash}
                mediaType={result.mediaType}
                suggestedName={imageResultFileName(result)}
                width={result.width}
                height={result.height}
              />
            </div>
            <figcaption className="text-ui-xs text-muted-foreground">
              {caption}
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
