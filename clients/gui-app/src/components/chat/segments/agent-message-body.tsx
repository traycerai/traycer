import type { ReactNode } from "react";
import { AgentReferenceMarkdown } from "./agent-reference-markdown";
import { AgentMessageCopyButton } from "./agent-message-copy-button";

/**
 * Scrollable message text plus its copy affordance for an A2A send/received
 * segment body. The copy button floats over the box's top-right corner
 * (mirroring the artifact diff viewer's expand control); the box carries
 * `pr-10` so text clears the button and keeps its own border + native
 * scrollbar flush against that border.
 */
export function AgentMessageBody(props: {
  readonly value: string;
  readonly bodyFindUnitId: string;
  readonly isStreaming: boolean;
}): ReactNode {
  const { value, bodyFindUnitId, isStreaming } = props;
  return (
    <div className="relative min-w-0">
      <div
        data-chat-find-unit={bodyFindUnitId}
        className="max-h-[min(40vh,24rem)] overflow-auto rounded-md border border-canvas-border/30 bg-canvas/40 px-3 py-2 pr-10"
      >
        <AgentReferenceMarkdown
          isStreaming={isStreaming}
          markdown={value}
          proseSize="compact"
          quotable={false}
        />
      </div>
      <AgentMessageCopyButton value={value} />
    </div>
  );
}
