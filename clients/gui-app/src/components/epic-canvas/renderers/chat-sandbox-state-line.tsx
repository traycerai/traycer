import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { ChatSandboxLine } from "@/lib/sandboxes/chat-sandbox-state";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import type { ChatStateLine } from "./chat-state-line";

/**
 * The resolver's slot line with its actions, for the composer's place and the
 * body before the transcript; `null` for a footer line or none. `endActions`
 * rides with a destroyed sandbox's line, Details with a failed one's.
 */
export function chatSandboxStateLine(
  line: ChatSandboxLine | null,
  endActions: ReactNode,
): ChatStateLine | null {
  if (line?.place !== "slot") return null;
  const { state } = line;
  switch (state.kind) {
    case "destroyed":
      return { line: line.text, actions: endActions };
    case "failed":
      return {
        line: line.text,
        actions: (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => openSandboxDetails(state.sandbox.id)}
          >
            Details
          </Button>
        ),
      };
    default:
      return { line: line.text, actions: null };
  }
}
