import { FileWarning } from "lucide-react";
import { SidebarPanelEmptyState } from "@/components/epic-canvas/sidebar/sidebar-panel-empty-state";
import { ARTIFACT_INDEX_UNAVAILABLE_COPY } from "@/lib/artifacts/artifact-index-unavailable-copy";
import type { ArtifactIndexUnavailableReason } from "@/stores/epics/open-epic/types";

/**
 * What a task's artifact list shows while its index cannot be read: the
 * desktop panel and the phone's Artifacts category mount this one state.
 */
export function ArtifactIndexUnavailableState(props: {
  readonly reason: ArtifactIndexUnavailableReason;
}) {
  return (
    <SidebarPanelEmptyState
      icon={FileWarning}
      title={ARTIFACT_INDEX_UNAVAILABLE_COPY[props.reason]}
      description={null}
      action={null}
      testId="epic-artifact-sidebar-unavailable"
    />
  );
}
