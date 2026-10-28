import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  movingSandboxLine,
  type ChatSandboxState,
} from "@/lib/sandboxes/chat-sandbox-state";
import {
  sandboxFailedChatLine,
  sandboxReleasedChatLine,
} from "@/lib/sandboxes/sandbox-row-lines";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";
import { openSandboxDetails } from "@/stores/sandboxes/sandbox-details-store";
import type { ChatStateLine } from "./chat-state-line";

/**
 * A destroyed, moving, failed or released sandbox's line, in the composer's
 * place: the one line that chat shows, and its body before the transcript.
 * `endActions` rides with a destroyed sandbox's line; `null` keeps the
 * composer.
 */
export function chatSandboxStateLine(
  state: ChatSandboxState,
  endActions: ReactNode,
): ChatStateLine | null {
  switch (state.kind) {
    case "moving":
      return { line: movingSandboxLine(state), actions: null };
    case "destroyed":
      return {
        line: taskSandboxEndLine(state.ended.name, state.ended.end),
        actions: endActions,
      };
    case "failed":
      return {
        line: sandboxFailedChatLine(state.sandbox),
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
    case "released":
      return {
        line: sandboxReleasedChatLine(state.sandbox.displayName),
        actions: null,
      };
    default:
      return null;
  }
}
