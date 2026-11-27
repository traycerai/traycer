import type { ArtifactIndexUnavailableReason } from "@/stores/epics/open-epic/types";

/** What a task shows in place of its artifacts, by reason. */
export const ARTIFACT_INDEX_UNAVAILABLE_COPY: Readonly<
  Record<ArtifactIndexUnavailableReason, string>
> = Object.freeze({
  "host-outdated":
    "Update Traycer on the computer running this task to see its artifacts.",
  "unsupported-epoch": "Update Traycer to see this task's artifacts.",
  "invalid-index": "This task's artifact list can't be read.",
});
