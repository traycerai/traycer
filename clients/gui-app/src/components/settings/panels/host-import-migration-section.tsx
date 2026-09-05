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

/**
 * The two rows that move ONE MACHINE'S local data - an import of the sessions
 * lying on its disk, and the migration of its SQLite tasks and epics to cloud.
 *
 * They used to sit in General, which is app-wide, so both spoke for whichever
 * host the window happened to be pointed at while naming none. Here the page
 * title already names the machine, and the sidebar's host picker is how you
 * choose a different one.
 *
 * Both ride the STREAM transport, so this section is only honest beneath the
 * Overview's re-provided `StreamRuntimeContext` - which is why the binding is
 * checked against the host this page NAMES before anything renders. Under an
 * explicit pick the scoped transport takes a commit or two to resolve, and
 * until it does the ambient stream is still dialing the effective host: running
 * an import or a migration through it would move the wrong machine's data under
 * this machine's name.
 *
 * The whole group is withheld rather than emptied. An empty `SettingsGroup` is a
 * titled, bordered box with nothing in it, which reads as a page that failed to
 * load rather than one with nothing to offer.
 */
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

/**
 * The single "Import your work" entry (spec §5): one row for every provider,
 * not one per provider and not in the Providers panel. Hidden entirely on a host
 * that predates the feature - it is deliberately de-emphasised, so there is
 * nothing worth explaining in its absence.
 *
 * Live progress comes from the run store, which is only populated for a run
 * this window started or is attached to; `sessionImport.status` covers the
 * colder questions - a run left going by a quit, and the last run's summary -
 * and is asked on mount rather than polled (see the host method policy).
 */
function SessionImportRow(props: {
  readonly binding: StreamRuntimeBinding;
  readonly hostId: string;
}): ReactNode {
  const [importOpen, setImportOpen] = useState(false);
  // Availability is read off the SAME client the import will run on, not off
  // whatever `StreamRuntimeContext` resolves separately: a row that offers an
  // import because host A negotiated the method would submit it to host B.
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
    // A run is active from the moment it is submitted, but its size is the
    // host's answer to that submission - so between the two there is a real
    // run with nothing yet to count, and "Importing 0 of 0…" would be the row
    // reporting a number it does not have. The spinner keeps turning either
    // way: `active` is what drives it, and this only changes what is said.
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
      {/* Rendered inline, so the wizard inside it inherits this page's
          re-provided contexts and submits to the host the row named. */}
      {importOpen ? (
        <SessionImportDialog onClose={() => setImportOpen(false)} />
      ) : null}
    </>
  );
}

function DataMigrationRow(props: {
  readonly binding: StreamRuntimeBinding;
  readonly hostId: string;
}): ReactNode {
  const migrationState = useMigrationRun(props.hostId);
  // Not per host, and deliberately: it comes from the desktop's cross-window
  // IPC, which carries one running bit and no host. Another window migrating
  // anything is still a reason not to start a second run from here.
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
