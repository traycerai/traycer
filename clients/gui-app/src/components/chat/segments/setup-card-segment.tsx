import {
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import type { WorktreeBindingOwnerKind } from "@traycer/protocol/host/worktree-schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { FilePathTooltip } from "@/components/file-path-tooltip";
import { StartTruncatedText } from "@/components/ui/start-truncated-text";
import { useFocusEpicTerminalSession } from "@/components/epic-canvas/renderers/chat-tile-focus-terminal";
import { useTabHostClient } from "@/hooks/host/use-tab-host-client";
import { useTerminalListFor } from "@/hooks/terminal/use-terminal-list-for-query";
import { useWorktreeRetrySetupFor } from "@/hooks/worktree/use-worktree-retry-setup-mutation";
import { isVisibleTerminalSidebarSession } from "@/lib/terminals/terminal-session-filters";
import { cn } from "@/lib/utils";
import { LiveElapsed } from "./segment-elapsed";

/**
 * Lifecycle state of a single workspace's worktree setup, projected from the
 * persisted `setup.*` chat events (T2 owns the derivation; this component only
 * renders).
 *
 * Two in-flight states: `creating` (the host's `git worktree add` is running
 * - the "Creating worktree" step spins, "Setting up" is pending) then
 * `setting-up` (the setup script runs - "Creating worktree" done, "Setting up"
 * spins).
 */
export type SetupWorkspaceState =
  "creating" | "setting-up" | "ready" | "failed" | "cancelled";

/** Per-workspace entry within one setup lifecycle. */
export interface SetupCardWorkspace {
  /** Absolute workspace path; the retry mutation's per-entry target. */
  readonly workspacePath: string;
  /** Human-facing label (folder / branch name) precomputed by the deriver. */
  readonly label: string;
  readonly state: SetupWorkspaceState;
  /** Exit code for a `failed` workspace; `null` otherwise / when unknown. */
  readonly setupExitCode: number | null;
  /**
   * Deterministic setup-terminal session id. `null` when no terminal was ever
   * linked (no "Open terminal" affordance); a non-null id whose session is no
   * longer live renders the action disabled as "session ended".
   */
  readonly terminalSessionId: string | null;
  /**
   * Absolute path of the created worktree and its branch, surfaced in the
   * expanded view so the user knows WHERE and WHAT was created. Carried in the
   * `setup.*` event metadata; `null` for events emitted before this was added
   * or when the entry has no branch (detached).
   */
  readonly worktreePath: string | null;
  readonly branch: string | null;
}

/**
 * Per-lifecycle rollup. `epicId` scopes the terminal-liveness query;
 * `ownerId` / `ownerKind` route the retry mutation; `state` is the
 * consolidated state across every workspace (resolves to `ready` only when
 * all workspaces are ready, and reflects the most severe in-flight/terminal
 * state otherwise).
 */
export interface SetupCardAggregate {
  readonly epicId: string;
  readonly ownerId: string;
  readonly ownerKind: WorktreeBindingOwnerKind;
  readonly state: SetupWorkspaceState;
}

/**
 * The full view-model the setup card consumes - the contract T2 produces by
 * grouping `setup.*` events per `workspacePath` and taking the latest state.
 * `createdAt` is the earliest setup event's wall-clock ms; it seeds the live
 * elapsed counter (placement is pinned by the renderer, not sorted on it).
 *
 * `isActive` mirrors `SetupCardRow.isActive`: it is true only for the live
 * (still-open) lifecycle window. A historical window can be stranded at
 * `setting-up` (the worktree vanished mid-setup; the host emits no terminal
 * setup event), so the live affordances - the ticking elapsed counter and the
 * animated "setting up" icon - must key off `isActive && setting-up`, NOT the
 * state alone, or a dead card would spin forever.
 */
export interface SetupCardViewModel {
  readonly aggregate: SetupCardAggregate;
  readonly workspaces: ReadonlyArray<SetupCardWorkspace>;
  readonly createdAt: number;
  readonly isActive: boolean;
}

// "live" -> action enabled; "ended" -> disabled "session ended"; "none" ->
// no action at all (no terminal was ever linked).
type TerminalLiveness = "live" | "ended" | "none";

/**
 * Compact, compaction-style setup line. Collapsed it is a single hairline-ruled
 * row (icon + phase + branch + elapsed); it always expands to a dropdown - the
 * two setup steps (Creating worktree / Setting up worktree, the latter with the
 * Open-terminal action) for a single repo, or a per-workspace row for multi.
 * Auto-expands on failure so Retry is one glance away. Pinned above the first
 * user message by the renderer; see `rendered-messages.ts`.
 */
export function SetupCardSegment(props: {
  readonly model: SetupCardViewModel;
  readonly viewTabId: string;
}) {
  const { model, viewTabId } = props;
  const { aggregate, workspaces, createdAt, isActive } = model;

  // Open terminal, liveness, and Retry must all address the SAME host the tab
  // is bound to (it can differ from the app-wide active host). Resolve one
  // tab-scoped client and feed it to the liveness query and the retry mutation;
  // `useFocusEpicTerminalSession` already scopes to the tab host.
  const focusTerminal = useFocusEpicTerminalSession(viewTabId);
  const tabClient = useTabHostClient();
  const retrySetup = useWorktreeRetrySetupFor(tabClient);
  const terminalList = useTerminalListFor(tabClient, aggregate.epicId);

  const liveSessionIds = useMemo(() => {
    const ids = new Set<string>();
    for (const session of terminalList.data?.sessions ?? []) {
      // `isVisibleTerminalSidebarSession` is the shared "session is openable"
      // rule; reuse it so the card's liveness can't drift from the
      // sidebar/bootstrap definition (it includes a completed setup terminal
      // the host retains so its output stays reachable).
      if (isVisibleTerminalSidebarSession(session)) ids.add(session.sessionId);
    }
    return ids;
  }, [terminalList.data]);
  // Until the first `terminal.list` settles we stay optimistic (treat sessions
  // as live) so the common just-set-up case doesn't flash "session ended".
  const livenessKnown = terminalList.data !== undefined;

  const livenessFor = (sessionId: string | null): TerminalLiveness => {
    if (sessionId === null || sessionId.length === 0) return "none";
    if (liveSessionIds.has(sessionId)) return "live";
    return livenessKnown ? "ended" : "live";
  };

  const handleRetry = (workspacePath: string): void => {
    retrySetup.mutate({
      epicId: aggregate.epicId,
      ownerId: aggregate.ownerId,
      ownerKind: aggregate.ownerKind,
      workspacePath,
    });
  };

  // Auto-expand on failure (Retry must be one glance away); otherwise the
  // compact line is the resting state. A manual toggle overrides the default.
  const defaultExpanded = aggregate.state === "failed";
  const [manualExpanded, setManualExpanded] = useState<boolean | null>(null);
  const expanded = manualExpanded ?? defaultExpanded;

  if (workspaces.length === 0) return null;

  const multi = workspaces.length > 1;
  // Retry routes through `tabClient`; while it's null (tab directory entry not
  // yet resolved) it would no-op + toast, so it doesn't render. Open terminal
  // goes through the focus path, not `tabClient`, so it stays ungated.
  const tabReady = tabClient !== null;
  // Live == this is the open lifecycle window AND a workspace is still in
  // flight (`creating` git-add OR `setting-up` script) - NOT the rolled-up
  // `aggregate.state` (which ranks `failed` above the in-flight states, hiding
  // the timer while a sibling repo is still running). A stranded historical
  // window (active=false) shows no live affordances.
  const isLive =
    isActive &&
    workspaces.some(
      (workspace) =>
        workspace.state === "creating" || workspace.state === "setting-up",
    );

  const total = workspaces.length;
  const readyCount = workspaces.filter((w) => w.state === "ready").length;

  const shared: SharedHandlers = {
    focusTerminal,
    livenessFor,
    onRetry: handleRetry,
    retryPending: retrySetup.isPending,
    tabReady,
    active: isActive,
  };

  const title = headerTitle(aggregate.state, multi, total, isActive);
  const secondary = multi
    ? `${readyCount} of ${total} done`
    : workspaceSecondary(workspaces[0]);
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  const labelInner = (
    <div className="flex items-center gap-2 text-ui-xs text-muted-foreground">
      <StatusIcon state={aggregate.state} active={isActive} />
      <span className="text-foreground/85">{title}</span>
      {secondary.length > 0 ? (
        <>
          {/* Separate centered flex item so the dot aligns with the row's
              baseline (a "· " text prefix sits off-center). */}
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <span className="text-muted-foreground/80">{secondary}</span>
        </>
      ) : null}
      {isLive ? <LiveElapsed startedAt={createdAt} /> : null}
      <ChevronIcon aria-hidden className="size-3 shrink-0" />
    </div>
  );

  return (
    <div data-testid="setup-card" className="flex w-full flex-col gap-1">
      <div className="flex items-center gap-3">
        <span aria-hidden className="h-px flex-1 bg-border/60" />
        <button
          type="button"
          data-find-include="true"
          onClick={() => setManualExpanded(!expanded)}
          aria-expanded={expanded}
          data-testid="setup-card-toggle"
          className={cn(
            "rounded-sm outline-none transition-colors",
            "hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring",
          )}
        >
          {labelInner}
        </button>
        <span aria-hidden className="h-px flex-1 bg-border/60" />
      </div>
      {expanded ? (
        <div className="mx-auto w-full max-w-[min(90vw,42rem)] rounded-md border border-border/60 bg-muted/30 p-3">
          {multi ? (
            // One block per worktree (branch · path header + create/setup
            // steps). Capped to ~2 blocks tall and scrolls beyond, so many
            // linked repos don't grow the card unbounded.
            <div
              data-testid="setup-card-workspaces"
              className="flex max-h-[min(45vh,13rem)] flex-col divide-y divide-border/50 overflow-y-auto pr-1"
            >
              {workspaces.map((entry) => (
                <WorkspaceSetupDetail
                  key={entry.workspacePath}
                  entry={entry}
                  {...shared}
                />
              ))}
            </div>
          ) : (
            <WorkspaceSetupDetail entry={workspaces[0]} {...shared} />
          )}
        </div>
      ) : null}
    </div>
  );
}

interface SharedHandlers {
  readonly focusTerminal: (
    terminalSessionId: string | null,
    cwd: string,
  ) => void;
  readonly livenessFor: (sessionId: string | null) => TerminalLiveness;
  readonly onRetry: (workspacePath: string) => void;
  readonly retryPending: boolean;
  /** Tab host client resolved - gates the `tabClient`-routed Retry. */
  readonly tabReady: boolean;
  /** True only for the live lifecycle window (drives the active-only affordances). */
  readonly active: boolean;
}

// One worktree's setup block: a "branch - path" header (where + what was
// created) above the two-step "create + setup" view - "Creating worktree"
// (spins while `git worktree add` runs, then a done check) and "Setting up
// worktree" (the script phase, carrying the Open-terminal / Retry actions;
// Cancel is intentionally omitted). Rendered once for a single repo and once
// per workspace (in the scroll list) for multi-repo, so the view is identical.
function WorkspaceSetupDetail(
  props: SharedHandlers & { readonly entry: SetupCardWorkspace },
) {
  const {
    entry,
    focusTerminal,
    livenessFor,
    onRetry,
    retryPending,
    tabReady,
    active,
  } = props;
  const liveness = livenessFor(entry.terminalSessionId);
  const retry =
    (entry.state === "failed" || entry.state === "cancelled") && tabReady ? (
      <RetryButton
        pending={retryPending}
        onRetry={() => onRetry(entry.workspacePath)}
      />
    ) : null;
  return (
    <div
      data-testid={`setup-card-workspace-${entry.workspacePath}`}
      className="flex flex-col gap-2 py-2.5 first:pt-0 last:pb-0"
    >
      <WorktreeLocation
        branch={entry.branch}
        worktreePath={entry.worktreePath}
        fallbackLabel={entry.label}
      />
      <ol
        data-testid="setup-card-steps"
        className="m-0 flex list-none flex-col gap-2.5 pl-0 text-ui-sm"
      >
        <li className="flex items-center gap-2">
          {/* Spins while `git worktree add` runs (state "creating"); flips to a
              done check once the add finishes and the rest proceeds. */}
          <StatusIcon
            state={entry.state === "creating" ? "creating" : "ready"}
            active={active}
          />
          <span className="text-foreground/85">Creating worktree</span>
        </li>
        <li className="flex items-center gap-2">
          {/* Pending (static dot) until the worktree exists and the setup
              script starts; then reflects the live setup state. */}
          <StatusIcon
            state={entry.state === "creating" ? "setting-up" : entry.state}
            active={entry.state === "creating" ? false : active}
          />
          <span className="text-foreground/85">Setting up worktree</span>
          {entry.state === "failed" && entry.setupExitCode !== null ? (
            <span className="text-muted-foreground">
              (exit {entry.setupExitCode})
            </span>
          ) : null}
          <span aria-hidden className="flex-1" />
          <OpenTerminalButton
            liveness={liveness}
            onOpen={() =>
              focusTerminal(
                entry.terminalSessionId,
                entry.worktreePath ?? entry.workspacePath,
              )
            }
          />
          {retry}
        </li>
      </ol>
    </div>
  );
}

function headerTitle(
  state: SetupWorkspaceState,
  multi: boolean,
  total: number,
  active: boolean,
): string {
  if (multi) {
    if (state === "ready") return `${total} worktrees ready`;
    if (state === "failed") return "Worktree setup failed";
    if (state === "cancelled") return "Worktree setup cancelled";
    if (state === "creating") return `Creating ${total} worktrees`;
    return `Setting up ${total} worktrees`;
  }
  if (state === "ready") return "Worktree ready";
  if (state === "failed") return "Setup failed";
  if (state === "cancelled") return "Setup cancelled";
  if (state === "creating") return "Creating worktree";
  // `setting-up`: a stranded historical window is no longer in flight.
  return active ? "Setting up worktree" : "Worktree setup incomplete";
}

function workspaceSecondary(entry: SetupCardWorkspace): string {
  const parts: string[] = [];
  if (entry.label.length > 0) parts.push(entry.label);
  if (entry.state === "failed" && entry.setupExitCode !== null) {
    parts.push(`(exit ${entry.setupExitCode})`);
  }
  return parts.join(" ");
}

function OpenTerminalButton(props: {
  readonly liveness: TerminalLiveness;
  readonly onOpen: () => void;
}) {
  if (props.liveness === "none") return null;
  if (props.liveness === "ended") {
    // "session ended" reads as a tooltip on the disabled button rather than
    // an appended label. A disabled button emits no pointer events, so the
    // tooltip trigger sits on an enabled wrapper span around it.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled
              data-testid="setup-card-open-terminal-ended"
              className="text-muted-foreground"
            >
              Open terminal
              <ArrowRight aria-hidden />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          Setup terminal session ended
        </TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      onClick={props.onOpen}
      data-testid="setup-card-open-terminal"
    >
      Open terminal
      <ArrowRight aria-hidden />
    </Button>
  );
}

function RetryButton(props: {
  readonly pending: boolean;
  readonly onRetry: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      disabled={props.pending}
      onClick={props.onRetry}
      data-testid="setup-card-retry"
      className="text-destructive hover:text-destructive"
    >
      Retry setup
      {props.pending ? (
        <AgentSpinningDots
          className="text-current"
          testId={undefined}
          variant={undefined}
        />
      ) : null}
    </Button>
  );
}

/**
 * The block header: "branch - worktree path" (what + where was created), muted.
 * The path truncates from the START (leaf stays visible) like every other path
 * in the app, with the full path on hover via `FilePathTooltip`. Falls back to
 * the precomputed label when neither branch nor path is known (setup events
 * emitted before this metadata was added).
 */
function WorktreeLocation(props: {
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly fallbackLabel: string;
}) {
  const branch =
    props.branch !== null && props.branch.length > 0 ? props.branch : null;
  const worktreePath =
    props.worktreePath !== null && props.worktreePath.length > 0
      ? props.worktreePath
      : null;
  if (branch === null && worktreePath === null) {
    if (props.fallbackLabel.length === 0) return null;
    return (
      <div className="min-w-0 truncate text-ui-xs text-muted-foreground/80">
        {props.fallbackLabel}
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 text-ui-xs text-muted-foreground">
      {branch !== null ? (
        <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-foreground/80">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate" data-testid="setup-card-branch">
            {branch}
          </span>
        </span>
      ) : null}
      {branch !== null && worktreePath !== null ? (
        <span aria-hidden className="shrink-0 text-muted-foreground/40">
          —
        </span>
      ) : null}
      {worktreePath !== null ? (
        <FilePathTooltip content={worktreePath} side="bottom">
          <StartTruncatedText
            className="min-w-0 flex-1 font-mono text-muted-foreground/80"
            data-testid="setup-card-worktree-path"
          >
            {worktreePath}
          </StartTruncatedText>
        </FilePathTooltip>
      ) : null}
    </div>
  );
}

/**
 * Lightweight inline status glyph for the compact line + step / per-workspace
 * rows (no filled circle - the compaction aesthetic is quiet). A live
 * `setting-up` window spins; a stranded historical one (active=false) shows a
 * static muted dot so a dead card never animates.
 */
function StatusIcon(props: {
  readonly state: SetupWorkspaceState;
  readonly active: boolean;
}) {
  const { state, active } = props;
  if (state === "ready") {
    return (
      <Check
        aria-hidden
        className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400"
      />
    );
  }
  if (state === "failed") {
    return <X aria-hidden className="size-3.5 shrink-0 text-destructive" />;
  }
  if (state === "cancelled") {
    return (
      <X aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    );
  }
  if (!active) {
    return (
      <span
        aria-hidden
        className="flex size-3.5 shrink-0 items-center justify-center"
      >
        <span className="size-1.5 rounded-full bg-muted-foreground/60" />
      </span>
    );
  }
  return (
    <AgentSpinningDots
      className="shrink-0 text-primary"
      testId={undefined}
      variant={undefined}
    />
  );
}
