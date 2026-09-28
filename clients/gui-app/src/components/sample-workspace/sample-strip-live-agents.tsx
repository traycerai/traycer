import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  LIVE_AGENTS_LIST_CLASS,
  LiveAgentRowView,
} from "@/components/epic-canvas/sidebar/live-agent-row";
import { useLiveAgentsSlot } from "@/components/layout/tabs/side-strip/live-agents-slot-store";
import { SAMPLE_LIVE_AGENTS } from "./sample-workspace-scene";

/**
 * The sample agents' rows, as list items: the canvas's strip, the Side tab
 * view pictures and the preset miniatures' strip and panel all draw them.
 */
export function SampleLiveAgentItems(): ReactNode {
  return SAMPLE_LIVE_AGENTS.map((agent) => (
    <li key={agent.nodeId}>
      <LiveAgentRowView {...agent} onClick={undefined} />
    </li>
  ));
}

/**
 * The sample task's live agents under its tab in the strip's Activity view
 * (D9), portalled into the strip's slot exactly as an epic surface portals its
 * session's list, so the canvas shows what Side tab view changes.
 */
export function SampleStripLiveAgents(props: {
  readonly tabId: string;
}): ReactNode {
  const slot = useLiveAgentsSlot(props.tabId);
  if (slot === null) return null;
  return createPortal(
    <ul
      aria-label="Live agents"
      data-testid="sample-strip-live-agents"
      className={LIVE_AGENTS_LIST_CLASS}
    >
      <SampleLiveAgentItems />
    </ul>,
    slot,
  );
}
