import type { ReactNode } from "react";
import { SandboxFailedChatActions } from "@/components/hosts/sandbox-failed-row-actions";
import { SandboxWakeStopAction } from "@/components/hosts/sandbox-wake-stop-action";
import type { ChatSandboxLine } from "@/lib/sandboxes/chat-sandbox-state";
import type { ChatStateLine } from "./chat-state-line";

/**
 * The resolver's slot line with its actions, for the composer's place and the
 * body before the transcript; `null` for a footer line or none. `endActions`
 * rides with a destroyed sandbox's line; a failed one uses its row's actions.
 * A move that is still awake is a wait for its host, billing, so it offers Stop.
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
        actions: <SandboxFailedChatActions summary={state.sandbox} />,
      };
    case "moving":
      return {
        line: line.text,
        actions:
          state.sandbox.state === "awake" ? (
            <SandboxWakeStopAction sandbox={state.sandbox} />
          ) : null,
      };
    default:
      return { line: line.text, actions: null };
  }
}
