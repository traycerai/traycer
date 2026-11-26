import type { ReactNode } from "react";
import { SandboxFailedChatActions } from "@/components/hosts/sandbox-failed-row-actions";
import type { ChatSandboxLine } from "@/lib/sandboxes/chat-sandbox-state";
import type { ChatStateLine } from "./chat-state-line";

/**
 * The resolver's slot line with its actions, for the composer's place and the
 * body before the transcript; `null` for a footer line or none. `endActions`
 * rides with a destroyed sandbox's line; a failed one uses its row's actions.
 */
export function chatSandboxStateLine(
  line: ChatSandboxLine | null,
  endActions: ReactNode,
): ChatStateLine | null {
  if (line?.place !== "slot") return null;
  const { state } = line;
  const description = {
    allowsPoolActions: line.allowsPoolActions,
    line: line.text,
  };
  switch (state.kind) {
    case "destroyed":
      return { ...description, actions: endActions };
    case "failed":
      return {
        ...description,
        actions: <SandboxFailedChatActions summary={state.sandbox} />,
      };
    default:
      return { ...description, actions: null };
  }
}
