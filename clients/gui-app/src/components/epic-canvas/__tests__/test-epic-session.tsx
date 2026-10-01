import { useState, type ReactNode } from "react";
import { TestEpicSessionTab } from "@/lib/registries/test-support/test-epic-session-tab";
import { EpicSessionGate } from "@/providers/epic-session-gate";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";

/**
 * The tab this wrapper's session belongs to when the suite names none.
 *
 * A session is owned by an OPEN TAB, so the wrapper needs one. A suite that
 * already seeded a real tab for the epic gets THAT tab - inventing a second
 * would put a record in the canvas store that the suite's own strip and
 * coordinator never heard of. Only a suite with no tab for the epic gets the
 * historical stand-in, a tab whose id is the epic id.
 */
function defaultTabIdFor(epicId: string): string {
  const state = useEpicCanvasStore.getState();
  const open = state.openTabOrder.find(
    (tabId) => state.tabsById[tabId]?.epicId === epicId,
  );
  return open ?? epicId;
}

export function TestEpicSessionWrapper(props: {
  readonly epicId: string;
  readonly tabId?: string;
  readonly children: ReactNode;
}): ReactNode {
  const [defaultTabId] = useState(() => defaultTabIdFor(props.epicId));
  return (
    <TooltipProvider>
      <TestEpicSessionTab
        epicId={props.epicId}
        tabId={props.tabId ?? defaultTabId}
      >
        <EpicSessionGate fallback={null}>{props.children}</EpicSessionGate>
      </TestEpicSessionTab>
    </TooltipProvider>
  );
}
