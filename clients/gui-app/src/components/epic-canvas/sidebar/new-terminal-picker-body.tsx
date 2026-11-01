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
 *
 * A picked New sandbox row stages a create (the sandboxes redesign): the
 * folder list gives way to the consequences block, and `Open terminal`
 * creates the sandbox and settles with the setup line here. The launch on
 * the new host is the tab's (`NewTerminalStagedHandoff`), so it happens
 * whether or not this popover is still open.
 */
import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { Button } from "@/components/ui/button";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { WorktreeFolderListBody } from "@/components/worktree/worktree-folder-list-body";
import { WorktreePickerHostSection } from "@/components/worktree/worktree-picker-host-section";
import {
  useSurfaceHostClient,
  useSurfaceHostPin,
} from "@/hooks/host/use-surface-host-pin";
import { useTerminalWorkspaceBindingsForClient } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { worktreeRowKey } from "@/lib/worktree/worktree-row-key";
import { isBrowsable } from "@/lib/worktree/worktree-row-browsable";
import { withoutResolvedMissingRows } from "@/lib/worktree/worktree-row-resolved-missing";
import type { TerminalLaunchTarget } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { usePrimaryActionShortcut } from "@/hooks/use-primary-action-shortcut";
import { ConsequencesBlock } from "@/components/composer/consequences-block";
import {
  useSandboxStaging,
  useSandboxStagingTask,
  type SandboxStaging,
} from "@/components/composer/use-sandbox-staging";
import {
  useStagedSandboxSend,
  type StagedSandboxSend,
} from "@/components/composer/use-staged-sandbox-send";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { OPEN_TERMINAL } from "@/lib/sandboxes/sandbox-strings";
import type { ConsequencesInput } from "@/lib/sandboxes/sandbox-stage-model";
import {
  useStagedSandboxStore,
  type StagedSandbox,
} from "@/stores/composer/staged-sandbox-store";
import { PrimaryActionShortcutHint } from "@/components/ui/primary-action-shortcut-hint";

export interface NewTerminalPickerBodyProps {
  readonly epicId: string;
  readonly surfaceKey: string;
  /**
   * Focus the workspace search input once the list mounts. The caller owns
   * this because focusing a text field is a request for a keyboard, and
   * whether that keyboard costs anything depends on the shell the surface is
   * rendered in, which this body cannot see.
   */
  readonly autoFocusSearch: boolean;
  readonly onLaunch: (target: TerminalLaunchTarget) => void;
}

export function NewTerminalPickerBody(props: NewTerminalPickerBodyProps) {
  const { autoFocusSearch, epicId, onLaunch, surfaceKey } = props;
  const [explicitRow, setExplicitRow] =
    useState<WorktreeBindingSelectorRowV12 | null>(null);
  const pin = useSurfaceHostPin(surfaceKey);
  const client = useSurfaceHostClient(pin.resolvedHostId);
  const bindingsQuery = useTerminalWorkspaceBindingsForClient({
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
  const hasUnverifiedRows = rows.some(
    (row) => !isBrowsable(row) && row.isGitResolvePending,
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
  const launchTarget = useMemo(() => {
    if (bindingsQuery.isError || bindingsQuery.isFetching) return null;
    if (selectedRow !== null) {
      return { hostId: selectedRow.hostId, cwd: selectedRow.runningDir };
    }
    return resolveFolderlessTerminalTarget(
      hasLoadedNoRows,
      pin.resolvedHostId,
      folderlessCwd,
    );
  }, [
    bindingsQuery.isError,
    bindingsQuery.isFetching,
    folderlessCwd,
    hasLoadedNoRows,
    pin.resolvedHostId,
    selectedRow,
  ]);

  // A double-click on Launch fires the handler twice before React can flush
  // the state update that unmounts this body, so each click would mint a
  // fresh terminal. This synchronous latch collapses one open->launch session
  // to a single terminal, whichever path launches it: Launch, the shortcut,
  // or the setup line's Open terminal.
  const hasLaunchedRef = useRef(false);
  const launchOnce = useCallback(
    (target: TerminalLaunchTarget) => {
      if (hasLaunchedRef.current) return;
      hasLaunchedRef.current = true;
      onLaunch(target);
    },
    [onLaunch],
  );
  const { staging, stage, consequences, stagedSend } = useTerminalStagedLaunch({
    epicId,
    surfaceKey,
    resolvedHostId: pin.resolvedHostId,
    onLaunch: launchOnce,
  });
  const handleLaunch = useCallback(() => {
    if (stagedSend.intercept("terminal", null)) return;
    if (launchTarget !== null) launchOnce(launchTarget);
  }, [launchOnce, launchTarget, stagedSend]);
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
        Everything above the Launch bar is one scrollable region, so a host
        given a bounded height (a capped dialog) keeps Launch pinned and
        reachable instead of pushing it past its own edge. Unbounded hosts -
        the sidebar popover - never reach the scroll, since the region is only
        as tall as its content.
      */}
      <div
        className="flex min-h-0 flex-col overflow-y-auto"
        data-testid="new-terminal-picker-scroller"
      >
        {/*
          The host section renders the RESOLVED host, which is what keeps this
          create surface honest without a banner: a pin whose host died resolves
          to `effective`, and the chip says so before Launch is pressed. The dead
          host's own row is still in the list, worded `offline` by the shared
          health vocabulary, so the pin is reselectable the moment it returns.
        */}
        <WorktreePickerHostSection
          surfaceKey={surfaceKey}
          composer={staging === null ? null : staging.composer}
        />
        {consequences === null ? (
          <WorktreeFolderListBody
            isPending={bindingsQuery.isPending}
            isError={bindingsQuery.isError}
            rows={rows}
            selectedRow={selectedRow}
            secondaryLabel={(row) => row.runningDir}
            onSelect={setExplicitRow}
            autoFocusSearch={autoFocusSearch}
            emptyMessage="No directories available. Open a workspace in the epic first."
          />
        ) : (
          <div className="flex flex-col gap-2 p-2.5">
            {stagedSend.line}
            <ConsequencesBlock
              input={consequences}
              onMoveFirst={null}
              onOpenTerminalInstead={null}
              onChooseAnotherHost={staging?.chooseAnotherHost}
            />
          </div>
        )}
        {staging?.sheet}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-border/60 bg-muted/20 px-2.5 py-2.5">
        <div className="min-w-0 text-xs text-muted-foreground">
          {bindingsQuery.isError || hasUnverifiedRows ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={bindingsQuery.isFetching}
              onClick={() => {
                void bindingsQuery.refetch({ cancelRefetch: false });
              }}
            >
              {bindingsQuery.isFetching ? (
                <AgentSpinningDots
                  className={undefined}
                  testId="terminal-workspace-retry-spinner"
                  variant={undefined}
                />
              ) : null}
              Retry
            </Button>
          ) : (
            folderlessCwdStatus
          )}
        </div>
        <TerminalLaunchButton
          staged={stage !== null}
          disabled={
            stage === null ? launchTarget === null : stage.phase !== "staged"
          }
          onClick={handleLaunch}
        />
      </div>
    </>
  );
}

/**
 * Default row for the terminal picker, mirroring the git diff panel's
 * `pickDefaultRow`: skip only genuinely unavailable rows. A verified worktree
 * stays browsable while setup is pending, running, failed, or cancelled.
 * Prefer the primary directory the agent runs in, then the first browsable
 * row. Terminals don't require a git repo.
 */
function pickDefaultTerminalRow(
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
): WorktreeBindingSelectorRowV12 | null {
  const selectable = rows.filter(isBrowsable);
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
      (row) => worktreeRowKey(row) === explicitKey && isBrowsable(row),
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

/**
 * The staging of the terminal picker's New sandbox rows: the picker's
 * composer mode, and the send that creates the sandbox on `Open terminal`.
 */
function useTerminalStagedLaunch(input: {
  readonly epicId: string;
  readonly surfaceKey: string;
  readonly resolvedHostId: string | null;
  readonly onLaunch: (target: TerminalLaunchTarget) => void;
}): {
  readonly staging: SandboxStaging | null;
  readonly stage: StagedSandbox | null;
  readonly consequences: ConsequencesInput | null;
  readonly stagedSend: StagedSandboxSend;
} {
  const { onLaunch, surfaceKey } = input;
  const hostOptions = useHostOptions();
  const task = useSandboxStagingTask(input.epicId);
  // The picker's own action is the terminal: no `Open terminal instead`.
  const surface = useMemo(
    () => ({ surfaceKey, task, openTerminalInstead: null }),
    [surfaceKey, task],
  );
  const staging = useSandboxStaging({
    surface,
    memoryHostId: input.resolvedHostId,
    hosts: hostOptions.hosts,
    forkOnNew: null,
  });
  // Opened from the line before the handoff, the terminal is the one this
  // stage was for: the stage ends so the handoff opens no second one.
  const stagedTerminal = useMemo(
    () => ({
      epicId: input.epicId,
      open: (target: TerminalLaunchTarget) => {
        onLaunch(target);
        useStagedSandboxStore.getState().clear(surfaceKey);
      },
    }),
    [input.epicId, onLaunch, surfaceKey],
  );
  const stagedSend = useStagedSandboxSend({
    surfaceKey,
    terminal: stagedTerminal,
    taskId: input.epicId,
    ownerId: null,
    claimsSend: false,
  });
  return {
    staging,
    stage: staging === null ? null : staging.stage,
    consequences: staging === null ? null : staging.consequences,
    stagedSend,
  };
}

/** `Launch`, or `Open terminal` while a sandbox is staged. */
function TerminalLaunchButton(props: {
  readonly staged: boolean;
  readonly disabled: boolean;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <Button
      type="button"
      size="sm"
      aria-label={props.staged ? undefined : "Launch"}
      aria-keyshortcuts="Meta+Enter Control+Enter"
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.staged ? OPEN_TERMINAL : "Launch"}
      <PrimaryActionShortcutHint />
    </Button>
  );
}
