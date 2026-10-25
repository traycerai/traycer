import type { ReactNode } from "react";
import { useChatOpencodeLineHeld } from "@/hooks/harnesses/chat-opencode-line-context";
import { opencodeLineHeldCopy } from "@/lib/chat/opencode-line";

/**
 * Beside the composer while the host keeps this chat on its OpenCode line
 * although Settings names the other one: one sentence saying until when. The
 * chat moves at its first message after that, and the line goes with the
 * snapshot that says so.
 */
export function ChatComposerOpencodeLineHeld(): ReactNode {
  const held = useChatOpencodeLineHeld();
  if (held === null) return null;
  return (
    <div
      role="status"
      data-testid="chat-composer-opencode-line-held"
      className="mb-2 flex items-center gap-2 rounded-md border border-canvas-border/70 bg-canvas px-3 py-2 text-ui-sm text-muted-foreground"
    >
      <span className="min-w-0 flex-1">{opencodeLineHeldCopy(held)}</span>
    </div>
  );
}
