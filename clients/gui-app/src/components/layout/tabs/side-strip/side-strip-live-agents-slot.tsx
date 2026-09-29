import { useCallback, type ReactNode } from "react";
import { useLayoutSettingPart } from "@/components/layout-editor/use-layout-surface";
import type { HeaderTab } from "@/stores/tabs/types";
import {
  publishLiveAgentsSlot,
  useLiveAgentsSlotMode,
} from "./live-agents-slot-store";

/**
 * The empty element under the active task row that its surface portals the
 * live agents list into (D9): an epic surface its session's agents, the
 * layout editor's sample surface its sample agents. Drawn only for the active
 * one of those tabs while the strip lists live agents; other rows have no
 * session, so they never expand.
 *
 * It is Side tab view's part on the editor's canvas, so pointing at the row
 * lights it and selecting it rings it; in Tabs only it shows, ghosted, while
 * the row is pointed at.
 */
export function SideStripLiveAgentsSlot(props: {
  readonly tab: HeaderTab | null;
  readonly active: boolean;
}): ReactNode {
  const mode = useLiveAgentsSlotMode();
  const kind = props.tab?.kind;
  if (
    mode === null ||
    !props.active ||
    props.tab === null ||
    (kind !== "epic" && kind !== "sample-workspace")
  )
    return null;
  return (
    <LiveAgentsSlotElement tabId={props.tab.id} ghost={mode === "preview"} />
  );
}

function LiveAgentsSlotElement(props: {
  readonly tabId: string;
  readonly ghost: boolean;
}): ReactNode {
  const { tabId } = props;
  const part = useLayoutSettingPart("sideStripView");
  const ref = useCallback(
    // React 19 calls the returned cleanup in place of a `null` call.
    (element: HTMLDivElement | null) => {
      part(element);
      if (element === null) return undefined;
      const withdraw = publishLiveAgentsSlot(tabId, element);
      return () => {
        part(null);
        withdraw();
      };
    },
    [tabId, part],
  );
  return (
    <div
      ref={ref}
      data-testid="side-strip-live-agents-slot"
      data-ghost={props.ghost ? "1" : undefined}
    />
  );
}
