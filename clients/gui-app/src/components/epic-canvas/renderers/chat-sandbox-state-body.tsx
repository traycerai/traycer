import { use, type ReactNode } from "react";
import { ChatStateLineContext } from "./chat-state-line";

/** The sandbox's state line and its actions as a tile's whole body. */
export function ChatSandboxStateBody(props: {
  readonly testId: string;
}): ReactNode {
  const stateLine = use(ChatStateLineContext);
  if (stateLine === null) return null;
  return (
    <div
      data-testid={props.testId}
      data-arm="sandbox-state"
      role="status"
      className="flex min-h-0 w-full flex-1 flex-col items-center justify-center gap-3 px-6 py-8 text-center"
    >
      <p className="max-w-md text-ui-sm text-muted-foreground">
        {stateLine.line}
      </p>
      {stateLine.actions === null ? null : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {stateLine.actions}
        </div>
      )}
    </div>
  );
}
