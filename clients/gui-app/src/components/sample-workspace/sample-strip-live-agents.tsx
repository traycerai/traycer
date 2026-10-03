import type { ReactNode } from "react";
import { StripAgentRow } from "@/components/layout/tabs/side-strip/strip-agent-row";
import { SAMPLE_LIVE_AGENTS } from "./sample-workspace-scene";

/**
 * The sample agents' rows, as list items: the Side tab view pictures and the
 * preset miniatures' strip and panel draw them, from the row the live strip
 * draws.
 */
export function SampleLiveAgentItems(): ReactNode {
  return SAMPLE_LIVE_AGENTS.map((agent) => (
    <li key={agent.id}>
      <StripAgentRow
        agent={agent}
        onScreen={false}
        onClick={undefined}
        onHoverChange={undefined}
      />
    </li>
  ));
}
