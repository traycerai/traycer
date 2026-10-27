import type { ReactNode } from "react";
import { AutomationTerminalOpenContext } from "./automation-terminal-open-context";
import { useOpenAutomationTerminal } from "./use-open-automation-terminal";

/** Keeps a first open alive when its unstarted row becomes an enrolled row. */
export function AutomationTerminalOpenScope(props: {
  readonly teamEnvironmentId: string | null;
  readonly children: ReactNode;
}): ReactNode {
  const open = useOpenAutomationTerminal({
    existing: null,
    teamEnvironmentId: props.teamEnvironmentId,
  });
  return (
    <AutomationTerminalOpenContext value={open}>
      {props.children}
    </AutomationTerminalOpenContext>
  );
}
