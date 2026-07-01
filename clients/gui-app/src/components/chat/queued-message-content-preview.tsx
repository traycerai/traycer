import { memo, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { ComposerContentRenderer } from "@/components/chat/composer/content-renderer";
import { cn } from "@/lib/utils";

interface QueuedMessageContentPreviewProps {
  readonly content: JsonContent;
}

export const QueuedMessageContentPreview = memo(
  function QueuedMessageContentPreview(
    props: QueuedMessageContentPreviewProps,
  ): ReactNode {
    const nodes = props.content.content ?? [];
    if (nodes.length === 0) {
      return <span className="text-muted-foreground">Queued message</span>;
    }

    return (
      <ComposerContentRenderer
        content={props.content}
        variant="preview"
        testId="queued-message-content-preview"
        className={cn(
          "min-w-0 max-w-full text-foreground",
          "[&_blockquote]:my-0.5 [&_li]:my-0 [&_ol]:my-0 [&_p]:m-0",
          "[&_pre]:hidden [&_ul]:my-0",
        )}
      />
    );
  },
);
