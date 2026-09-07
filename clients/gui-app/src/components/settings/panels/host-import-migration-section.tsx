import { useState, type ReactNode } from "react";
import { SettingsGroup } from "@/components/settings/settings-group";
import { SettingsRow } from "@/components/settings/settings-row";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import { startMigrationRun } from "@/components/migration/migration-run-handle";
import { SessionImportDialog } from "@/components/session-import/session-import-dialog";
import { useSessionImportAvailableFor } from "@/hooks/session-import/use-session-import-available";
import { useSessionImportStatus } from "@/hooks/session-import/use-session-import-status-query";
import {
  useStreamRuntimeBinding,
  type StreamRuntimeBinding,
} from "@/lib/host/stream-runtime-context";
import {
  epicsSeen,
  taskChainsSeen,
  useMigrationRun,
  useMigrationRunStore,
  type MigrationRunState,
} from "@/stores/migration/migration-run-store";
import {
  sessionImportDoneCount,
  sessionImportIsRunning,
  useSessionImportRun,
} from "@/stores/session-import/session-import-run-store";

const MIGRATION_PROGRESS_LABEL = "Migrating tasks";

/** Both ride the stream transport, so this section is only honest beneath the Overview's re-provided
 * `StreamRuntimeContext`. */
export function HostImportMigrationSection(props: {
  /** The host this page names; the stream must agree before rows appear. */
  readonly hostId: string | null;
}): ReactNode {
  const binding = useStreamRuntimeBinding();
  const streamHostId = binding?.hostId ?? null;
  if (binding === null || streamHostId === null) return null;
  if (streamHostId !== props.hostId) return null;
  return (
    <SettingsGroup
      title="Data & migration"
      tone="default"
      dataTestId="host-import-migration"
      fill={false}
    >
      <SessionImportRow binding={binding} hostId={streamHostId} />
      <DataMigrationRow binding={binding} hostId={streamHostId} />
    </SettingsGroup>
  );
}

/** Live progress comes from the run store, which is only populated for a run this window started or is attached
 * to; `sessionImport.status` covers the colder questions. */
function SessionImportRow(props: {
  readonly binding: StreamRuntimeBinding;
  readonly hostId: string;
}): ReactNode {
  const [importOpen, setImportOpen] = useState(false);
  // Availability is read off the same client the import will run on, not off whatever `StreamRuntimeContext`
  // resolves separately.
  const available = useSessionImportAvailableFor(props.binding.wsStreamClient);
  const statusQuery = useSessionImportStatus(available);
  const run = useSessionImportRun(props.hostId);
  if (!available) return null;

  const status = statusQuery.data ?? null;
  const active = sessionImportIsRunning(run)
    ? { done: sessionImportDoneCount(run), total: run.total }
    : (status?.active ?? null);

  let description =
    "Bring work you already started in Claude Code, Codex, or OpenCode into Traycer as tasks.";
  if (active !== null) {
    // The spinner keeps turning either way: `active` is what drives it, and this only changes what is said.
    description =
      active.total === 0
        ? "Starting import…"
        : `Importing ${active.done} of ${active.total}…`;
  }

  return (
    <>
      <SettingsRow
        label="Import your work"
        description={description}
        control={
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="settings-import-sessions"
            onClick={() => setImportOpen(true)}
          >
            {active !== null ? (
              <AgentSpinningDots
                className="text-muted-foreground"
                testId="settings-import-sessions-spinner"
                variant={undefined}
              />
            ) : null}
            Import
          </Button>
        }
      />
      {/* Opens on the host this row named, so the dialog's own picker agrees
          with the page behind it; the pick can still be changed there. */}
      {importOpen ? (
        <SessionImportDialog
          onClose={() => setImportOpen(false)}
          initialHostId={props.hostId}
        />
      ) : null}
    </>
  );
}

function DataMigrationRow(props: {
  readonly binding: StreamRuntimeBinding;
  readonly hostId: string;
}): ReactNode {
  const migrationState = useMigrationRun(props.hostId);
  // Not per host, and deliberately: it comes from the desktop's cross-window IPC, which carries one running bit
  // and no host.
  const remoteRunning = useMigrationRunStore((s) => s.remoteRunning);
  const progressLabel = formatMigrationProgress(migrationState);
  const running = migrationState.status === "running" || remoteRunning;
  return (
    <SettingsRow
      label="Data migration"
      description={
        progressLabel ??
        "Retry moving this host's local tasks and epics to cloud."
      }
      control={
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={running}
          data-testid="settings-reattempt-migration"
          onClick={() => {
            startMigrationRun(props.binding);
          }}
        >
          {running ? (
            <AgentSpinningDots
              className="text-muted-foreground"
              testId="settings-reattempt-migration-spinner"
              variant={undefined}
            />
          ) : null}
          Re-attempt migration
        </Button>
      }
    />
  );
}

function formatMigrationProgress(state: MigrationRunState): string | null {
  if (state.status !== "running") return null;
  if (state.totals === null) return MIGRATION_PROGRESS_LABEL;
  const { totalTaskChains, totalLocalEpics } = state.totals;
  const tasks = `${taskChainsSeen(state.counts)}/${totalTaskChains}`;
  const epics = `${epicsSeen(state.counts)}/${totalLocalEpics}`;
  return `${MIGRATION_PROGRESS_LABEL} - tasks ${tasks}, epics ${epics}`;
}
