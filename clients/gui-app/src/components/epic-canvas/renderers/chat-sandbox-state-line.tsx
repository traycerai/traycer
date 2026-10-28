import type { ReactNode } from "react";
import {
  movingSandboxLine,
  type ChatSandboxState,
} from "@/lib/sandboxes/chat-sandbox-state";
import { taskSandboxEndLine } from "@/lib/sandboxes/task-sandbox-end";
import { ChatStateLineContext } from "./chat-state-line";

/**
 * A destroyed or moving sandbox's line, in the composer's place below: the
 * one line that chat shows. `endActions` rides with a destroyed sandbox's
 * line; any other state leaves the composer as it is.
 */
export function ChatSandboxStateLine(props: {
  readonly state: ChatSandboxState;
  readonly endActions: ReactNode;
  readonly children: ReactNode;
}): ReactNode {
  const { state } = props;
  if (state.kind !== "moving" && state.kind !== "destroyed")
    return props.children;
  const line =
    state.kind === "moving"
      ? { line: movingSandboxLine(state), actions: null }
      : {
          line: taskSandboxEndLine(state.ended.name, state.ended.end),
          actions: props.endActions,
        };
  return (
    <ChatStateLineContext value={line}>{props.children}</ChatStateLineContext>
  );
}
