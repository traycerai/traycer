import { ImageIcon } from "lucide-react";
import { memo, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { RenderedComposerNode } from "@/components/chat/composer/content-renderer/render-node";
import { collectImageAttachmentsFromJSONContent } from "@/lib/composer/tiptap-json-content";
import { cn } from "@/lib/utils";

interface QueuedMessageContentPreviewProps {
  readonly content: JsonContent;
}

export const QueuedMessageContentPreview = memo(
  function QueuedMessageContentPreview(
    props: QueuedMessageContentPreviewProps,
  ): ReactNode {
    const nodes = props.content.content ?? [];
    const images = collectImageAttachmentsFromJSONContent(props.content);

    if (nodes.length === 0 && images.length === 0) {
      return <span className="text-muted-foreground">Queued message</span>;
    }

    return (
      <div
        data-testid="queued-message-content-preview"
        className={cn(
          "min-w-0 max-w-full text-foreground",
          "[&_blockquote]:my-0.5 [&_li]:my-0 [&_ol]:my-0 [&_p]:m-0",
          "[&_pre]:hidden [&_ul]:my-0",
        )}
      >
        {nodes.map((node, index) => {
          const nodeKey = `queued-content-${index}`;
          return (
            <RenderedComposerNode key={nodeKey} node={node} nodeKey={nodeKey} />
          );
        })}
        {images.map((image) => (
          <span
            key={`${image.name}-${(image.dataUrl ?? image.hash)?.slice(0, 24)}`}
            className="mx-0.5 inline-flex max-w-[8rem] items-center gap-1 rounded-md border border-border/60 bg-muted/60 px-1 py-0.5 align-middle text-ui-xs font-medium text-foreground/90"
          >
            <ImageIcon className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate">{image.name ?? "Image"}</span>
          </span>
        ))}
      </div>
    );
  },
);
