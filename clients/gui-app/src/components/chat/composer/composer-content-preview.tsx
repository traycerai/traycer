import { memo, type ReactNode } from "react";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { ComposerContentRenderer } from "@/components/chat/composer/content-renderer";
import { cn } from "@/lib/utils";

interface ComposerContentPreviewProps {
  readonly content: JsonContent;
  readonly emptyLabel: string;
  readonly testId: string;
  readonly className: string | undefined;
}

export const ComposerContentPreview = memo(function ComposerContentPreview(
  props: ComposerContentPreviewProps,
): ReactNode {
  const nodes = props.content.content ?? [];
  if (nodes.length === 0) {
    return (
      <span
        className={cn("text-muted-foreground", props.className)}
        data-testid={props.testId}
      >
        {props.emptyLabel}
      </span>
    );
  }

  return (
    <ComposerContentRenderer
      content={props.content}
      variant="preview"
      testId={props.testId}
      className={cn(
        "min-w-0 max-w-full text-foreground",
        "[&_blockquote]:my-0.5 [&_li]:my-0 [&_ol]:my-0 [&_p]:m-0",
        "[&_pre]:hidden [&_ul]:my-0",
        props.className,
      )}
    />
  );
});
