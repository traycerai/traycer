import type { ArtifactIndexUnavailableReason } from "@/stores/epics/open-epic/types";

/** A switched task served by a machine running an older Traycer. */
const HOST_OUTDATED_COPY =
  "Update Traycer on the machine running this task to see its artifacts.";
/** A task saved in a form this app does not know. */
const UNSUPPORTED_EPOCH_COPY = "Update Traycer to see this task's artifacts.";
/** A task whose artifact list is damaged. */
const INVALID_INDEX_COPY = "This task's artifact list can't be read.";

/** What a task shows in place of its artifacts, by reason. */
export const ARTIFACT_INDEX_UNAVAILABLE_COPY: Readonly<
  Record<ArtifactIndexUnavailableReason, string>
> = Object.freeze({
  "host-outdated": HOST_OUTDATED_COPY,
  "unsupported-epoch": UNSUPPORTED_EPOCH_COPY,
  "invalid-index": INVALID_INDEX_COPY,
});
