/**
 * Host+folder selection for terminal creation from the sidebar "+" popover:
 * host section, folder list, and Launch action. CMD-T's in-pane opener uses
 * native fuzzy sub-pages instead, while sharing the same host bindings and
 * terminal tile-ref builder.
 *
 * The caller mounts this only while its popover is open (and unmounts it on
 * close), so its state - the explicit row pick and the launch latch - starts
 * fresh every time without needing an imperative reset.
 *
 * When the epic has no worktree folders bound at all, there is no row to
 * select from, but a terminal can still be launched "folderless" - bound to
 * the active host's default cwd from `worktree.listBindingsForEpic@1.1`.
 * `launchTarget` unifies both paths so callers only ever handle one shape.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { WorktreeFolderListBody } from "@/components/worktree/worktree-folder-list-body";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import {
  useSurfaceHostClient,
  useSurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useWorktreeListBindingsForEpicForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { withoutResolvedMissingRows } from "@/lib/worktree/worktree-row-resolved-missing";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";

export interface NewTerminalPickerBodyProps {
  readonly epicId: string;
  readonly surfaceKey: string;
  readonly onLaunch: (target: TerminalLaunchTarget) => void;
}

export function NewTerminalPickerBody(props: NewTerminalPickerBodyProps) {
  const { epicId, onLaunch, surfaceKey } = props;
  const [explicitRow, setExplicitRow] =
    useState<WorktreeBindingSelectorRowV12 | null>(null);
  const pin = useSurfaceHostPin(surfaceKey);
  const client = useSurfaceHostClient(pin.resolvedHostId);
  const bindingsQuery = useWorktreeListBindingsForEpicForClient({
    client,
    epicId,
    enabled: pin.resolvedHostId !== null,
  });
  // Host-proven-missing rows are hidden here (a deleted worktree can't host a
  // terminal); the explicit pick is exempt so a worktree deleted while this
  // picker is open degrades to its disabled badge instead of vanishing.
  const rows = useMemo(
    () =>
      withoutResolvedMissingRows(
        bindingsQuery.data?.rows ?? [],
        explicitRow === null
          ? null
          : { hostId: explicitRow.hostId, runningDir: explicitRow.runningDir },
      ),
    [bindingsQuery.data?.rows, explicitRow],
  );
  const selectedRow = useMemo(
    () => resolveTerminalSelection(explicitRow, rows),
    [explicitRow, rows],
  );
  const hasLoadedNoRows =
    !bindingsQuery.isPending && !bindingsQuery.isError && rows.length === 0;
  // The fallback cwd rides the bindings response. `null` means the host
  // predates folderless workspaces (bridged v1.0 response), so launch stays
  // disabled.
  const folderlessCwd = bindingsQuery.data?.folderlessCwd ?? null;
  const folderlessCwdFailed = hasLoadedNoRows && folderlessCwd === null;
  const launchTarget = useMemo(
    () =>
      selectedRow === null
        ? resolveFolderlessTerminalTarget(
            hasLoadedNoRows,
            pin.resolvedHostId,
            folderlessCwd,
          )
        : { hostId: selectedRow.hostId, cwd: selectedRow.runningDir },
    [folderlessCwd, hasLoadedNoRows, pin.resolvedHostId, selectedRow],
  );

  // A double-click on Launch fires the handler twice before React can flush
  // the state update that unmounts this body, so each click would mint a
  // fresh terminal. This synchronous latch collapses one open->launch session
  // to a single terminal.
  const hasLaunchedRef = useRef(false);
  const handleLaunch = useCallback(() => {
    if (hasLaunchedRef.current || launchTarget === null) return;
    hasLaunchedRef.current = true;
    onLaunch(launchTarget);
  }, [launchTarget, onLaunch]);
  usePrimaryActionShortcut(true, handleLaunch);

  let folderlessCwdStatus: ReactNode = null;
  if (folderlessCwdFailed) {
    folderlessCwdStatus = (
      <span
        className="flex items-center gap-2 text-destructive"
        data-testid="new-terminal-folderless-cwd-error"
      >
        Couldn't resolve terminal directory.
        <ReportIssueAction
          context={createReportIssueContext({
            title: "Couldn't resolve terminal directory",
            message: "The terminal working directory could not be resolved.",
            code: null,
            source: "New terminal",
          })}
          presentation="text"
          className={undefined}
        />
      </span>
    );
  }

  return (
    <>
      {/*
        The host section renders the RESOLVED host, which is what keeps this
        create surface honest without a banner: a pin whose host died resolves
        to `effective`, and the chip says so before Launch is pressed. The dead
        host's own row is still in the list, worded `offline` by the shared
        health vocabulary, so the pin is reselectable the moment it returns.
      */}
      <WorktreePickerHostSection surfaceKey={surfaceKey} />
      <WorktreeFolderListBody
        isPending={bindingsQuery.isPending}
        isError={bindingsQuery.isError}
        rows={rows}
        selectedRow={selectedRow}
        secondaryLabel={(row) => row.runningDir}
        onSelect={setExplicitRow}
        autoFocusSearch
        emptyMessage="No directories available. Open a workspace in the epic first."
      />
      <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-2.5 py-2.5">
        <div className="min-w-0 text-xs text-muted-foreground">
          {folderlessCwdStatus}
        </div>
        <Button
          type="button"
          size="sm"
          aria-label="Launch"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          disabled={launchTarget === null}
          onClick={handleLaunch}
        >
          Launch
          <PrimaryActionShortcutHint />
        </Button>
      </div>
    </>
  );
}

/**
 * Default row for the terminal picker, mirroring the git diff panel's
 * `pickDefaultRow`: skip rows the host disabled (setup pending/failed, missing
 * worktree, ...), prefer the primary directory the agent runs in, and otherwise
 * take the first selectable row. Returns null when nothing is selectable so
 * Launch stays disabled. Terminals don't require a git repo, so selectability
 * is just `disabledReason === null` (unlike the git surfaces' `isGitSelectable`).
 */
function pickDefaultTerminalRow(
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
): WorktreeBindingSelectorRowV12 | null {
  const selectable = rows.filter((row) => row.disabledReason === null);
  if (selectable.length === 0) return null;
  return selectable.find((row) => row.isPrimary) ?? selectable[0];
}

/**
 * The user's explicit pick wins while it stays selectable; if it vanishes or
 * the host disables it (e.g. its worktree goes missing), fall back to the
 * default. Re-reads the row from the live list so a selected row keeps fresh
 * fields across binding updates.
 */
function resolveTerminalSelection(
  explicit: WorktreeBindingSelectorRowV12 | null,
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
): WorktreeBindingSelectorRowV12 | null {
  if (explicit !== null) {
    const explicitKey = worktreeRowKey(explicit);
    const live = rows.find(
      (row) =>
        worktreeRowKey(row) === explicitKey && row.disabledReason === null,
    );
    if (live !== undefined) return live;
  }
  return pickDefaultTerminalRow(rows);
}

function resolveFolderlessTerminalTarget(
  enabled: boolean,
  hostId: string | null,
  cwd: string | null,
): TerminalLaunchTarget | null {
  if (!enabled || hostId === null || cwd === null || cwd.length === 0) {
    return null;
  }
  return { hostId, cwd };
}
