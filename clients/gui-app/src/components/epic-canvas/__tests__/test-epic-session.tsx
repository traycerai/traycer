import { type ReactNode } from "react";
import { EpicSessionProvider } from "@/providers/epic-session-provider";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { TooltipProvider } from "@/components/ui/tooltip";

export function TestEpicSessionWrapper(props: {
  readonly epicId: string;
  readonly tabId?: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <TooltipProvider>
      <EpicSessionProvider
        epicId={props.epicId}
        tabId={props.tabId ?? props.epicId}
      >
        <EpicSessionGate fallback={null}>{props.children}</EpicSessionGate>
      </EpicSessionProvider>
    </TooltipProvider>
  );
}
