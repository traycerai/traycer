import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicExportArtifacts } from "@/hooks/epic/use-epic-export-artifacts-mutation";
import {
  useEpicArtifactRecords,
  useEpicDurabilityPauseReason,
  useEpicDurabilityView,
  useEpicSnapshotMeta,
} from "@/lib/epic-selectors";
import { isEpicArtifactKind } from "@/lib/artifacts/node-display";
import type { EpicDurabilityPauseReasonV15 } from "@traycer/protocol/host/epic/subscribe";
import { viewStatus } from "./epic-durability-plane";

/**
 * The paused-only remedies, the one part of the old durability badge that
 * stays in the status row: an action a person has to take is not a detail,
 * and a tooltip is not a place to click. Everything the badge used to SAY is
 * now a plane of the connection pill (`epic-durability-plane.ts`); this file
 * is only what a person can DO.
 *
 * Renders nothing for every status but `paused`, and nothing for the paused
 * reasons that have no remedy.
 */
export function EpicDurabilityRemedies() {
  const view = useEpicDurabilityView();
  const pauseReason = useEpicDurabilityPauseReason();
  // The status is decided BEFORE any provider-bound hook runs: the child
  // below reads the export mutation, which exists only under the app shell,
  // and every status row renders this component. The old badge reached that
  // hook only on its paused arm, and so does this.
  if (viewStatus(view) !== "paused") return null;
  if (!exportIsTheRemedy(pauseReason)) {
    return null;
  }
  return <PausedRemedies />;
}

function PausedRemedies() {
  const exportArtifacts = useEpicExportArtifacts();
  const records = useEpicArtifactRecords();
  const meta = useEpicSnapshotMeta();
  const artifacts = records.flatMap((record) =>
    isEpicArtifactKind(record.type)
      ? [{ id: record.id, title: record.name }]
      : [],
  );
  const exportLocalArtifacts = (): void => {
    exportArtifacts.mutate({
      artifacts,
      format: "markdown",
      archive: true,
      archiveTitle: meta?.epicLight?.title ?? "Traycer",
    });
  };
  return (
    <ExportArtifactsAction
      disabled={artifacts.length === 0 || exportArtifacts.isPending}
      pending={exportArtifacts.isPending}
      onExport={exportLocalArtifacts}
    />
  );
}

/** Inline pending indicator, at the size the row's own type scale wants. */
function RemedyActionSpinner() {
  return (
    <AgentSpinningDots
      className="size-3"
      testId={undefined}
      variant={undefined}
    />
  );
}

function ExportArtifactsAction(props: {
  readonly disabled: boolean;
  readonly pending: boolean;
  readonly onExport: () => void;
}) {
  return (
    <Button
      type="button"
      size="xs"
      variant="ghost"
      className="h-auto px-0 text-current underline underline-offset-2"
      data-testid="epic-durability-export"
      disabled={props.disabled}
      onClick={props.onExport}
    >
      Export artifacts
      {props.pending ? <RemedyActionSpinner /> : null}
    </Button>
  );
}

/**
 * The pause reasons whose remedy is getting the bytes out.
 *
 * `access-revoked` is the original: the cloud will not take another byte, so
 * the local copy is all there is. `orphaned-local-edits-after-cloud-delete` is
 * the same shape from the other direction and is the ACTIONABLE half of
 * `s5-orphaned-epic-recovery` - the cloud object is gone, this host refused to
 * destroy the never-uploaded edits, and the epic is reachable again precisely
 * so the person can take them somewhere. Reaching a preserved epic and finding
 * nothing to do with it would be the dark archive with a nicer label.
 *
 * The other two paused reasons are deliberately absent: the two
 * delete-bookkeeping reasons are transient states of an epic that is not going
 * anywhere.
 */
function exportIsTheRemedy(
  pauseReason: EpicDurabilityPauseReasonV15 | null,
): boolean {
  return (
    pauseReason === "access-revoked" ||
    pauseReason === "orphaned-local-edits-after-cloud-delete"
  );
}
