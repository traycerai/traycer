/**
 * Shared host+folder selection for terminal creation: host section, folder
 * list, and Launch action. Used by both the sidebar "+" popover
 * (`new-terminal-picker.tsx`) and the ⌘K palette's "Create new terminal"
 * dialog (`new-terminal-dialog.tsx`) so host+folder selection logic lives in
 * exactly one place (gui-app AGENTS.md's palette/manual-UI parity rule).
 *
 * Callers mount this only while their popover/dialog is open (and unmount it
 * on close), so its state - the explicit row pick and the launch latch -
 * starts fresh every time without needing an imperative reset.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import { WorktreeFolderListBody } from "@/components/worktree/worktree-folder-list-body";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";

export interface NewTerminalPickerBodyProps {
  readonly epicId: string;
  readonly onLaunch: (row: WorktreeBindingSelectorRow) => void;
}

export function NewTerminalPickerBody(props: NewTerminalPickerBodyProps) {
  const { epicId, onLaunch } = props;
  const [explicitRow, setExplicitRow] =
    useState<WorktreeBindingSelectorRow | null>(null);
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId,
    enabled: true,
  });
  const rows = useMemo(
    () => bindingsQuery.data?.rows ?? [],
    [bindingsQuery.data?.rows],
  );
  const selectedRow = useMemo(
    () => resolveTerminalSelection(explicitRow, rows),
    [explicitRow, rows],
  );

  // A double-click on Launch fires the handler twice before React can flush
  // the state update that unmounts this body, so each click would mint a
  // fresh terminal. This synchronous latch collapses one open->launch session
  // to a single terminal.
  const hasLaunchedRef = useRef(false);
  const handleLaunch = useCallback(() => {
    if (hasLaunchedRef.current || selectedRow === null) return;
    hasLaunchedRef.current = true;
    onLaunch(selectedRow);
  }, [onLaunch, selectedRow]);

  return (
    <>
      <WorktreePickerHostSection />
      <WorktreeFolderListBody
        isPending={bindingsQuery.isPending}
        isError={bindingsQuery.isError}
        rows={rows}
        selectedRow={selectedRow}
        secondaryLabel={(row) => row.runningDir}
        onSelect={setExplicitRow}
        autoFocusSearch
      />
      <div className="flex justify-end border-t border-border/60 bg-muted/20 px-2.5 py-2.5">
        <Button
          type="button"
          size="sm"
          disabled={selectedRow === null}
          onClick={handleLaunch}
        >
          Launch
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
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow | null {
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
  explicit: WorktreeBindingSelectorRow | null,
  rows: ReadonlyArray<WorktreeBindingSelectorRow>,
): WorktreeBindingSelectorRow | null {
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
