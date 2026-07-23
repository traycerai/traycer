import type { ReactNode } from "react";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { AgentMessageCopyButton } from "./agent-message-copy-button";

/**
 * Scrollable message text plus its copy affordance for an A2A send/received
 * segment body. The copy button is a static sibling in its own gutter column
 * (not overlaid on the scroll container) so it never intercepts the box's
 * native scrollbar.
 */
export function AgentMessageBody(props: {
  readonly value: string;
  readonly bodyFindUnitId: string;
}): ReactNode {
  const { value, bodyFindUnitId } = props;
  return (
    <div className="flex min-w-0 items-start gap-1.5">
      <div
        data-chat-find-unit={bodyFindUnitId}
        className="max-h-[min(40vh,24rem)] min-w-0 flex-1 overflow-auto rounded-md border border-canvas-border/30 bg-canvas/40 px-3 py-2"
      >
        <AgentReferenceMarkdown
          isStreaming={false}
          markdown={value}
          proseSize="compact"
          quotable={false}
        />
      </div>
      <AgentMessageCopyButton value={value} />
    </div>
  );
}
