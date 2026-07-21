import { useStore } from "zustand";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ChevronDown, GitFork, Users } from "lucide-react";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@traycer/protocol/host/index";
import {
  useActivePaneEffect,
  usePaneVisible,
} from "@/components/epic-tabs/pane-visibility-context";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import { useOpenEpicId } from "@/lib/epic-selectors";
import { useEpicTerminalAgent } from "@/lib/epic-selectors";
import {
  TerminalXtermHost,
  useTerminalTileBootstrap,
  type TerminalCreatePayload,
} from "@/hooks/agent/use-terminal-tile-bootstrap";
import { useHostReachability } from "@/hooks/agent/use-host-reachability";
import {
  useTerminalSessionRecovery,
  type TerminalSessionRecovery,
} from "@/hooks/terminal/use-terminal-session-recovery";
import {
  isTerminalCrashExit,
  useTerminalCrashNotification,
} from "@/hooks/terminal/use-terminal-crash-notification";
import { useTabHostId } from "@/components/epic-canvas/hooks/use-tab-host-id";
import { beginTerminalLoad } from "@/lib/perf/terminal-load-perf";
import { useAgentStartTerminalSession } from "@/hooks/agent/use-prepare-tui-launch-mutation";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryEntry } from "@/hooks/host/use-host-directory-entry";
import { useTerminalKillFor } from "@/hooks/terminal/use-terminal-kill-for-mutation";
import type {
  TerminalDataWriter,
  TerminalSessionStoreHandle,
} from "@/stores/terminals/terminal-session-store";
import {
  clearPreparedTerminalAgentLaunch,
  peekPreparedTerminalAgentLaunch,
} from "@/stores/terminals/prepared-terminal-agent-launch-store";
import { TerminalLoadingSkeleton } from "./terminal-loading-skeleton";
import { TerminalGridMeasureProbe } from "./terminal-grid-measure-probe";
import { TerminalDeadTileBanner } from "./dead-tile-banner";
import { TerminalConnectionOverlay } from "./terminal-connection-overlay";
import { resolveTerminalOverlayState } from "./terminal-connection-overlay-state";
import {
  emitTerminalClosedNotification,
  emitTerminalCrashedNotification,
} from "@/stores/notifications/app-local-notifications-store";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { HostWorkspaceSelector } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { useWorktreeGetBinding } from "@/hooks/worktree/use-worktree-get-binding-query";
import { useTuiSetupTerminalListRefreshDriver } from "@/hooks/agent/use-tui-setup-terminal-list-refresh-driver";
import { useTuiSetupTerminalTabRegisterDriver } from "@/hooks/agent/use-tui-setup-terminal-tab-register-driver";
import { SetupCardSegment } from "@/components/chat/segments/setup-card-segment";
import { buildTuiAgentSetupCardModel } from "@/stores/chats/tui-agent-setup-card-model";
import type { WorktreeBinding } from "@traycer/protocol/host/worktree-schemas";
import { AgentModeReadonlyLabel } from "@/components/home/pickers/agent-mode-toggle";
import type { AgentMode } from "@/components/home/data/landing-options";
import { useAgentStopControls } from "@/hooks/agent/use-agent-stop-controls";
import { AgentStopList } from "@/components/chat/chat-agent-stop-list";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import {
  buildForkWorkspaceSeed,
  buildForkWorkspaceSeedFromWorkspaceFolders,
} from "@/lib/worktree/fork-workspace-seed";
import {
  pendingForkTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { TerminalAgentForkDialog } from "./terminal-agent-fork-dialog";
import { useCloseCanvasTileWithNestedFocus } from "./use-close-canvas-tile-with-nested-focus";
import { ReportIssueAction } from "@/components/report-issue/report-issue-action";
import { createReportIssueContext } from "@/lib/report-issue-context";
import { reportableErrorToast } from "@/lib/reportable-error-toast";

// Poll cadence for the setup card's binding while a worktree setup script is
// still in flight. The script runs in a background PTY server-side and only
// mutates the binding, so without polling a completion/failure would not
// surface until the next window refocus - the card would stay "setting up".
const SETUP_BINDING_POLL_INTERVAL_MS = 2_000;

// A created worktree whose setup script has neither settled nor failed yet.
// `pending`/`running` are the only non-terminal setup states; every other
// state (succeeded / not_required / failed / cancelled) is final, so polling
// stops once no entry is in flight.
function hasInFlightWorktreeSetup(binding: WorktreeBinding | null): boolean {
  if (binding === null) return false;
  return binding.entries.some(
    (entry) =>
      entry.mode === "worktree" &&
      (entry.setupState === "pending" || entry.setupState === "running"),
  );
}

/**
 * A bound worktree/folder is gone from disk. The host's prepare-launch
 * resolver rejects with the typed `WORKTREE_MISSING` envelope instead of
 * silently demoting to Local (the silent demote-to-Local was removed - no
 * hidden fallback), so the tile surfaces an actionable recovery message
 * rather than a generic "Failed to start terminal" banner.
 */
function isWorktreeMissingError(
  error: { readonly code?: string; readonly message?: string } | null,
): boolean {
  return error !== null && error.code === "WORKTREE_MISSING";
}

/**
 * Tile renderer for terminal-agent records. Reads the agent record from the
 * Y.Doc projection and reuses the same xterm + `terminal.create`
 * infrastructure the plain `TerminalTile` uses via
 * `useTerminalTileBootstrap`.
 *
 * The PTY's `desiredSessionId` is the agent record id (i.e. the canvas tab
 * id). That decoupling means the persisted terminal-agent `sessionId` can
 * stay stable across PTY restarts even when a provider needs the host to
 * rebuild dynamic launch state before the next attach.
 */
export interface TuiAgentTileProps {
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
}

export function TuiAgentTile(props: TuiAgentTileProps) {
  const hostId = useTabHostId();
  const epicId = useOpenEpicId();
  const reachability = useHostReachability(hostId);
  const crashReportedRef = useRef(false);
  const reportCrashExit = useCallback(() => {
    if (crashReportedRef.current) return;
    crashReportedRef.current = true;
    emitTerminalCrashedNotification({
      instanceId: props.node.instanceId,
      target: {
        kind: "terminal",
        epicId,
        terminalId: props.node.id,
        tabId: props.viewTabId,
        paneId: props.tileId,
        tileInstanceId: props.node.instanceId,
      },
      cause: "exit",
    });
  }, [
    epicId,
    props.node.id,
    props.node.instanceId,
    props.tileId,
    props.viewTabId,
  ]);
  const reportRecoveryExhausted = useCallback(() => {
    // Whichever path observes this terminal death first owns its notification.
    if (crashReportedRef.current) return;
    crashReportedRef.current = true;
    emitTerminalCrashedNotification({
      instanceId: props.node.instanceId,
      target: {
        kind: "terminal",
        epicId,
        terminalId: props.node.id,
        tabId: props.viewTabId,
        paneId: props.tileId,
        tileInstanceId: props.node.instanceId,
      },
      cause: "recovery-exhausted",
    });
  }, [
    epicId,
    props.node.id,
    props.node.instanceId,
    props.tileId,
    props.viewTabId,
  ]);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    props.node.instanceId,
  );
  // Owns the recovery budget + nonce above the bootstrap subtree so they survive
  // the `recoverNonce`-keyed remount the recovery performs.
  const recovery = useTerminalSessionRecovery({
    hostId,
    instanceId: props.node.instanceId,
    onRecoveryExhausted: reportRecoveryExhausted,
  });
  useEffect(() => {
    crashReportedRef.current = false;
  }, [props.node.instanceId]);
  // Open the load timeline at the outermost mount so the reachability gate
  // (which can show a skeleton first) counts toward first-paint time.
  const sessionId = props.node.id;
  useEffect(() => {
    beginTerminalLoad(sessionId, "terminal-agent");
  }, [sessionId]);
  useEffect(() => {
    if (reachability.status !== "unreachable") return;
    emitTerminalClosedNotification({
      instanceId: props.node.instanceId,
      hostLabel: reachability.hostLabel,
      target: {
        kind: "terminal",
        epicId,
        terminalId: props.node.id,
        tabId: props.viewTabId,
        paneId: props.tileId,
        tileInstanceId: props.node.instanceId,
      },
    });
  }, [
    reachability.status,
    reachability.hostLabel,
    epicId,
    props.node.id,
    props.node.instanceId,
    props.tileId,
    props.viewTabId,
  ]);
  if (reachability.status === "unreachable") {
    return (
      <TerminalDeadTileBanner
        hostLabel={reachability.hostLabel}
        ownerKind="agent"
        onClose={closeCanvasTile}
        testId={`terminal-agent-tile-${props.tileId}`}
      />
    );
  }
  // "host-starting": local host not published yet (boot/ensure/wake) - show
  // the loading shell, never the permanently-closed banner.
  if (
    reachability.status === "checking" ||
    reachability.status === "host-starting"
  ) {
    return (
      <TerminalAgentTileShell tileId={props.tileId}>
        <TerminalAgentWorktreeNotice
          hostId={hostId}
          agentId={sessionId}
          viewTabId={props.viewTabId}
          layout="bar"
        />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <TerminalLoadingSkeleton />
        </div>
      </TerminalAgentTileShell>
    );
  }
  // Keyed on `recoverNonce`: a recovery remounts the bootstrap subtree, which
  // re-issues `prepareLaunch` (resuming the conversation from disk) and recreates
  // the reaped PTY.
  return (
    <TuiAgentTileLive
      key={recovery.recoverNonce}
      recovery={recovery}
      onCrashExit={reportCrashExit}
      {...props}
    />
  );
}

// Safety ceiling for restart-kill exit suppression: the normal path lifts it as
// soon as the recreated PTY is observed; this guarantees it is never held longer
// than a kill exit could plausibly take to arrive, so a later genuine crash is
// never swallowed indefinitely.
const RESTART_SUPPRESS_TIMEOUT_MS = 15_000;

function TuiAgentTileLive(
  props: TuiAgentTileProps & {
    readonly recovery: TerminalSessionRecovery;
    readonly onCrashExit: () => void;
  },
) {
  const hostId = useTabHostId();
  const epicId = useOpenEpicId();
  const sessionId = props.node.id;
  const instanceId = props.node.instanceId;
  const agent = useEpicTerminalAgent(sessionId);
  const hostEntry = useHostDirectoryEntry(hostId);
  const hostClient = useHostClientFor(hostEntry);
  const prepareLaunch = useAgentStartTerminalSession(hostClient);
  const killTerminal = useTerminalKillFor(
    hostClient,
    "Couldn't restart terminal after updating folders.",
    false,
  );

  // Every harness - Claude included - goes through `agent.startTerminalSession`
  // on the launch / reopen path so the host can re-read the local worktree
  // binding, reject a missing worktree (no silent demote-to-Local), and await
  // orchestrator setup before the visible PTY is created. Codex and OpenCode
  // have always required this for app-server URL freshness; routing Claude
  // through the same RPC closes the bug where a Claude reopen / rebind kept
  // using the stored invocation + persisted `workspaceFolders[0]` (Flow 6 / Flow 11).
  const prepareLaunchMutateAsync = prepareLaunch.mutateAsync;
  const preparePayload =
    useCallback(async (): Promise<TerminalCreatePayload | null> => {
      if (agent === null) return null;
      // PEEK, don't consume: a failed `terminal.create` (PTY never started, so
      // the fork command never ran) must be retryable against the SAME fork-
      // prepared args. The stash is cleared once `terminal.create` succeeds (see
      // the create-success effect below); after that, reopens resume normally.
      const preparedLaunch = peekPreparedTerminalAgentLaunch(agent.id);
      if (preparedLaunch !== null) {
        return {
          tuiHarnessId: agent.harnessId,
          cwd: preparedLaunch.cwd,
          shellCommand: preparedLaunch.shellCommand,
          shellArgs: [...preparedLaunch.shellArgs],
          worktreeBusyPaths: [...preparedLaunch.worktreeBusyPaths],
        };
      }
      const session = await prepareLaunchMutateAsync({
        harnessId: agent.harnessId,
        epicId,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort,
        agentMode: agent.agentMode,
        tuiAgentId: agent.id,
        harnessSessionId: agent.harnessSessionId,
        forkSourceHarnessSessionId: null,
        // Raw per-agent override: `null` keeps provider Settings as the
        // fallback, while `""` and non-empty strings are durable overrides.
        terminalAgentArgs: agent.terminalAgentArgs,
        workspaceMode: agent.workspaceMode,
        // `null`: this is a reopen/reattach of an already-persisted agent, so
        // the host resolver falls back to reading the profile off the stored
        // record itself rather than re-threading it from here.
        profileId: null,
      });
      if (
        session.terminalShellCommand === null ||
        session.terminalShellArgs === null
      ) {
        throw new Error(
          `${agent.harnessId} launch preparation did not return a terminal command.`,
        );
      }
      // Worktree-mode terminal-agents must run the visible PTY inside the
      // bound worktree, never in the root workspace. The host resolver
      // derives `workingDirectory` from the binding's primary entry when a
      // binding is present (rejecting with WORKTREE_MISSING if that entry's
      // folder is gone on disk, rather than silently demoting), so we forward
      // that value verbatim instead of re-deriving it from
      // `agent.workspaceFolders[0]` - that would race a stale projection on a
      // freshly-imported binding.
      //
      // `worktreeBusyPaths` is the resolver-authored set of concrete
      // worktree paths the harness will hold open. We forward it verbatim
      // to `terminal.create` so the host-side active-run busy registry
      // can refuse `worktree.delete` for any of those paths until the PTY
      // exits - covering multi-repo bindings where the sibling worktree
      // paths would otherwise be missed by the single-cwd backstop.
      return {
        tuiHarnessId: agent.harnessId,
        cwd: session.workingDirectory,
        shellCommand: session.terminalShellCommand,
        shellArgs: [...session.terminalShellArgs],
        worktreeBusyPaths: [...session.worktreeBusyPaths],
      };
    }, [agent, epicId, prepareLaunchMutateAsync]);

  const prepareLaunchReset = prepareLaunch.reset;
  const resetPrepare = useMemo(
    () => () => prepareLaunchReset(),
    [prepareLaunchReset],
  );

  const bootstrap = useTerminalTileBootstrap({
    hostId,
    scope: { kind: "epic", epicId },
    sessionId,
    instanceId,
    sessionKind: "terminal-agent",
    preparePayload,
    enabled: agent !== null && prepareLaunch.isIdle,
    resetPrepare,
  });
  const hostHasSession = bootstrap.hostHasSession;
  const retryTerminal = bootstrap.retry;
  const createIsSuccess = bootstrap.createIsSuccess;
  const killTerminalMutate = killTerminal.mutate;

  // One-shot fork stash: clear it once the PTY is live (`terminal.create`
  // succeeded). Until then `preparePayload` PEEKs it, so a failed create can be
  // retried against the same fork-prepared args instead of silently falling back
  // to a fresh, non-forked launch. A no-op for non-fork launches (no stash).
  const agentId = agent?.id ?? null;
  useEffect(() => {
    if (agentId === null || !createIsSuccess) return;
    clearPreparedTerminalAgentLaunch(agentId);
  }, [agentId, createIsSuccess]);

  // A binding-change restart KILLS the PTY and recreates it. Killing makes the
  // live stream report a non-zero exit, which the tile would otherwise treat as
  // a crash (error toast + close the tab) - the bug where applying folder edits
  // closed the terminal on every harness. The kill exit is identical across
  // Claude / Codex / OpenCode, so this is not a provider issue.
  //
  // `restartSuppressExitRef` marks "the next exit is our own restart kill, not a
  // crash". It is a ref, not state: the exit-handling effects in
  // `TerminalAgentLive` read it on each `status` change (every exit IS a status
  // change), so the suppression applies without a re-render.
  const restartSuppressExitRef = useRef(false);
  // The recreate can only fire after the bootstrap observes the session gone
  // (`hostHasSession === false` is the create gate), so a false→true cycle is
  // a guaranteed "recreate finished" signal. Gate on having seen the `false` so
  // the still-running old session at restart time can't lift suppression early.
  const restartSawSessionGoneRef = useRef(false);
  // Hard ceiling: even if the false→true frame is ever coalesced away (so the
  // lift effect never runs), suppression is force-cleared after this delay - a
  // LATER genuine crash can then never be swallowed indefinitely. The normal
  // path clears it (and cancels this timer) the moment the recreate is observed.
  const restartSuppressTimerRef = useRef<number | null>(null);
  const clearRestartSuppression = useCallback((): void => {
    restartSuppressExitRef.current = false;
    restartSawSessionGoneRef.current = false;
    if (restartSuppressTimerRef.current !== null) {
      clearTimeout(restartSuppressTimerRef.current);
      restartSuppressTimerRef.current = null;
    }
  }, []);
  // The live host reads this at EXIT time (not during render) to tell a
  // binding-change restart kill apart from a real crash. Exposed as a stable
  // getter so the ref itself never crosses the prop boundary (a ref passed as a
  // prop / read in render trips react-hooks/refs).
  const isRestartKillSuppressed = useCallback(
    (): boolean => restartSuppressExitRef.current,
    [],
  );
  const armRestartSuppression = useCallback((): void => {
    restartSawSessionGoneRef.current = false;
    restartSuppressExitRef.current = true;
    if (restartSuppressTimerRef.current !== null) {
      clearTimeout(restartSuppressTimerRef.current);
    }
    restartSuppressTimerRef.current = window.setTimeout(
      clearRestartSuppression,
      RESTART_SUPPRESS_TIMEOUT_MS,
    );
  }, [clearRestartSuppression]);
  const performRestartKill = useCallback((): void => {
    armRestartSuppression();
    killTerminalMutate(
      { sessionId },
      {
        onSettled: () => {
          retryTerminal();
        },
      },
    );
  }, [armRestartSuppression, killTerminalMutate, retryTerminal, sessionId]);
  // A `reaped` exit is the host's idle-reap of this unwatched agent - pure
  // lifecycle, not a crash - and the PTY is already gone, so there is
  // nothing to kill. Arm the same suppression a binding restart uses (no
  // error toast, no tab close, same safety ceiling) and recreate under the
  // same id; `prepareLaunch` resumes the conversation transparently.
  const reviveAfterReap = useCallback((): void => {
    armRestartSuppression();
    retryTerminal();
  }, [armRestartSuppression, retryTerminal]);
  // The kill must target a LIVE session. If session presence is unknown
  // (`terminal.list` refetching → `hostHasSession === null`) or already gone at
  // commit time, do NOT silently drop the rebind (the bug where Update appeared
  // to succeed but the PTY kept the old folders). Remember the intent and let the
  // effect below act once presence settles.
  const pendingRestartRef = useRef(false);
  const restartAfterWorkspaceBindingChange = useCallback((): void => {
    if (hostHasSession === true) {
      performRestartKill();
      return;
    }
    pendingRestartRef.current = true;
    retryTerminal();
  }, [hostHasSession, performRestartKill, retryTerminal]);
  useEffect(() => {
    if (!pendingRestartRef.current) return;
    if (hostHasSession === true) {
      // Session confirmed live → kill + recreate against the new binding.
      pendingRestartRef.current = false;
      performRestartKill();
    } else if (hostHasSession === false) {
      // Session already gone → the bootstrap recreates the PTY from the updated
      // binding on its own; no kill needed.
      pendingRestartRef.current = false;
    }
    // `null`: list still settling, keep waiting.
  }, [hostHasSession, performRestartKill]);
  // Lift the suppression once the recreated PTY is back (`hostHasSession`
  // cycles false → true), or the relaunch errored (the body then renders the
  // inline error, not the live host). Ref assignments only - no setState - so a
  // later genuine exit is handled normally even if its kill exit was never
  // observed (e.g. the host unmounted first).
  const prepareLaunchIsError = prepareLaunch.isError;
  const bootstrapCreateIsError = bootstrap.createIsError;
  useEffect(() => {
    if (!restartSuppressExitRef.current) return;
    if (bootstrapCreateIsError || prepareLaunchIsError) {
      clearRestartSuppression();
      return;
    }
    if (hostHasSession === false) {
      restartSawSessionGoneRef.current = true;
      return;
    }
    if (hostHasSession === true && restartSawSessionGoneRef.current) {
      clearRestartSuppression();
    }
  }, [
    hostHasSession,
    bootstrapCreateIsError,
    prepareLaunchIsError,
    clearRestartSuppression,
  ]);
  // The terminal-agent's worktree is "in active use" while a PTY/session is
  // running for it. Terminal-agent binding edits are still allowed; a successful
  // binding write kills and recreates the PTY so the launch payload is prepared
  // from the new binding. `hostHasSession === true` covers reattach after the
  // GUI restarts; bootstrap also reports it for the freshly-launched PTY once
  // the list query refreshes.
  const isOwnerActive = hostHasSession === true;

  if (agent === null) {
    // Same stable skeleton the reachability-check, pre-launch, and xterm
    // suspense states use, so the create→ready transition reads as one
    // continuous loading state instead of a sequence of placeholder strings.
    // The worktree-setup notice still rides on top (it keys off the tab/node
    // id, not the pending agent projection), so a just-created worktree agent
    // shows its notice before the record lands.
    return (
      <TerminalAgentTileShell tileId={props.tileId}>
        <TerminalAgentWorktreeNotice
          hostId={hostId}
          agentId={props.node.id}
          viewTabId={props.viewTabId}
          layout="bar"
        />
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <TerminalLoadingSkeleton />
        </div>
      </TerminalAgentTileShell>
    );
  }

  // Pre-launch / live shell: the worktree chip sits at the top of the tile so
  // the user can confirm the binding before the harness starts (Flow 1 step 6).
  // The host is fixed for a terminal agent because a PTY can't migrate, but
  // folder binding changes are supported by committing the new binding and
  // restarting the PTY from the updated prepare-launch payload. The body
  // underneath swaps between pre-launch placeholders and the live xterm host
  // based on session readiness.
  return (
    <TerminalAgentTileShell tileId={props.tileId}>
      <TerminalAgentPreLaunchToolbar
        hostId={hostId}
        hostClient={hostClient}
        epicId={epicId}
        viewTabId={props.viewTabId}
        agent={agent}
        agentMode={agent.agentMode}
        isOwnerActive={isOwnerActive}
        onWorkspaceBindingCommitted={restartAfterWorkspaceBindingChange}
      />
      <div className="relative min-h-0 flex-1">
        <TerminalAgentBody
          isRestartKillSuppressed={isRestartKillSuppressed}
          viewTabId={props.viewTabId}
          tileId={props.tileId}
          instanceId={instanceId}
          prepareLaunchIsError={prepareLaunch.isError}
          prepareLaunchError={prepareLaunch.error}
          createIsError={bootstrap.createIsError}
          createError={bootstrap.createError}
          handle={bootstrap.handle}
          onRetry={bootstrap.retry}
          onReapedExit={reviveAfterReap}
          isActive={props.isActive}
          recovery={props.recovery}
          onCrashExit={props.onCrashExit}
          measureProbe={
            <TerminalGridMeasureProbe
              sessionId={sessionId}
              instanceId={instanceId}
              tileKind="terminal-agent"
              chrome="padded"
              onMeasured={bootstrap.reportMeasuredGrid}
            />
          }
        />
      </div>
    </TerminalAgentTileShell>
  );
}

interface TerminalAgentBodyProps {
  readonly viewTabId: string;
  readonly tileId: string;
  readonly instanceId: string;
  readonly prepareLaunchIsError: boolean;
  readonly prepareLaunchError: {
    readonly code?: string;
    readonly message?: string;
  } | null;
  readonly createIsError: boolean;
  readonly createError: {
    readonly code?: string;
    readonly message?: string;
  } | null;
  readonly handle: TerminalSessionStoreHandle | null;
  readonly onRetry: () => void;
  /** Revive (recreate + resume) after the host's idle-reap of this agent. */
  readonly onReapedExit: () => void;
  readonly isActive: boolean;
  readonly isRestartKillSuppressed: () => boolean;
  readonly recovery: TerminalSessionRecovery;
  readonly onCrashExit: () => void;
  /** Pre-subscribe grid measurement probe, rendered in the loading state. */
  readonly measureProbe: React.ReactNode;
}

function TerminalAgentBody(props: TerminalAgentBodyProps): React.ReactNode {
  if (props.prepareLaunchIsError || props.createIsError) {
    const error = props.prepareLaunchError ?? props.createError;
    if (isWorktreeMissingError(error)) {
      // No silent demote-to-Local: the host refused to launch into a missing
      // cwd. A terminal agent stays bound to its folder for life (a PTY can't
      // migrate), so the recovery is to restore the missing path on disk (a
      // worktree or a Local folder) and retry, or close the agent - not to
      // re-bind elsewhere.
      return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
          <span className="text-ui-sm text-destructive">
            {error?.message ??
              "A bound folder for this terminal agent is missing on disk."}
          </span>
          <span className="max-w-prose text-ui-xs text-muted-foreground">
            Restore the missing folder or worktree at its bound path, then retry
            — or close this terminal agent.
          </span>
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={props.onRetry}
            >
              Retry
            </Button>
            <ReportIssueAction
              context={createReportIssueContext({
                title: "Terminal agent folder is missing",
                message:
                  "A bound folder for a terminal agent was missing on disk.",
                code: null,
                source: "Terminal agent",
              })}
              presentation="text"
              className={undefined}
            />
          </div>
        </div>
      );
    }
    const message = error?.message ?? "Unknown error";
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-6 text-center text-ui-sm text-destructive">
        <span>Failed to start terminal: {message}</span>
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={props.onRetry}
          >
            Retry
          </Button>
          <ReportIssueAction
            context={createReportIssueContext({
              title: "Failed to start terminal agent",
              message: "The terminal agent session could not be started.",
              code: null,
              source: "Terminal agent",
            })}
            presentation="text"
            className={undefined}
          />
        </div>
      </div>
    );
  }

  if (props.handle === null) {
    // One stable skeleton for the whole pre-ready window (preparing → starting
    // → xterm suspense all render `TerminalLoadingSkeleton`), so the transition
    // into the live terminal never flickers between placeholder strings. The
    // measurement probe mounts the persistent xterm engine beneath it (both
    // fill the same relative box) so the container's grid is measured before
    // the subscribe is dispatched - see `TerminalGridMeasureProbe`. Probe
    // first, skeleton in an overlay after: the probe's container is
    // `absolute inset-0`, so in-flow content preceding it would be painted
    // over.
    return (
      <>
        {props.measureProbe}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <TerminalLoadingSkeleton />
        </div>
      </>
    );
  }

  return (
    <TerminalAgentLive
      handle={props.handle}
      instanceId={props.instanceId}
      viewTabId={props.viewTabId}
      tileId={props.tileId}
      isActive={props.isActive}
      isRestartKillSuppressed={props.isRestartKillSuppressed}
      onReapedExit={props.onReapedExit}
      recovery={props.recovery}
      onCrashExit={props.onCrashExit}
    />
  );
}

interface TerminalAgentPreLaunchToolbarProps {
  readonly hostId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly epicId: string;
  readonly viewTabId: string;
  readonly agent: TuiAgentProjection;
  readonly agentMode: AgentMode;
  readonly isOwnerActive: boolean;
  readonly onWorkspaceBindingCommitted: () => void;
}

/**
 * Always-on toolbar above the terminal-agent body. The host + workspace
 * chips sit beside the harness controls so the user can see where the agent
 * runs without leaving the tile. The host select is locked because a PTY
 * can't migrate; the workspace picker remains editable and restarts the PTY
 * after a committed folder-binding change.
 *
 * The binding is read via `worktree.getBinding` (a unary RPC) so the chip can
 * render `repo · branch` accurately even though terminal-agents do not
 * subscribe to `chat.subscribe`. While the query is loading we pass
 * `binding={null}` so the chip degrades to "not selected"; once it resolves
 * the chip reflects Local / worktree branch deterministically.
 */
function TerminalAgentPreLaunchToolbar(
  props: TerminalAgentPreLaunchToolbarProps,
) {
  const paneVisible = usePaneVisible();
  const [forkDialogOpen, setForkDialogOpen] = useState(false);
  const bindingQuery = useWorktreeGetBinding({
    client: props.hostClient,
    epicId: props.epicId,
    ownerId: props.agent.id,
    ownerKind: "terminal-agent",
    enabled: true,
    // Re-check the bound folders on window focus (while this pane is visible) so
    // the per-folder "missing on disk" indicator refreshes when a worktree is
    // deleted - matching the chat tile's on-focus recompute. The query stays
    // enabled regardless of focus so the chip always renders.
    staleTime: 0,
    refetchOnWindowFocus: paneVisible,
    // The nested setup notice owns the in-flight polling; this observer only
    // needs the binding for the chip, so it shares the cache without polling.
    refetchInterval: false,
  });
  const binding = bindingQuery.data?.binding ?? null;
  const sourceStagingKey = useMemo<WorktreeStagingKey>(
    () => ({
      surface: "owner",
      epicId: props.epicId,
      ownerKind: "terminal-agent",
      ownerId: props.agent.id,
    }),
    [props.agent.id, props.epicId],
  );
  const sourceStagedIntent = useWorktreeIntentStagingStore(
    (s) => s.intentByKey[worktreeStagingKeyString(sourceStagingKey)] ?? null,
  );
  const pendingForkStagingKey = useMemo(
    () => pendingForkTerminalAgentStagingKey(props.epicId),
    [props.epicId],
  );
  const clearStagedIntent = useWorktreeIntentStagingStore((s) => s.clear);
  const forkWorkspaceSeed = useMemo(() => {
    const seed = buildForkWorkspaceSeed({
      binding,
      stagedIntent: sourceStagedIntent,
    });
    return seed.intent === null
      ? buildForkWorkspaceSeedFromWorkspaceFolders(props.agent.workspaceFolders)
      : seed;
  }, [binding, props.agent.workspaceFolders, sourceStagedIntent]);
  const forkDisabled =
    props.hostClient === null ||
    props.agent.harnessSessionId === null ||
    !bindingQuery.isSuccess;
  const openForkDialog = useCallback((): void => {
    if (forkDisabled) return;
    clearStagedIntent(pendingForkStagingKey);
    setForkDialogOpen(true);
  }, [clearStagedIntent, forkDisabled, pendingForkStagingKey]);
  const onWorkspaceBindingCommitted = props.onWorkspaceBindingCommitted;
  const handleWorkspaceBindingCommitted = useCallback(
    (_changedWorkspacePaths: ReadonlyArray<string>): void => {
      onWorkspaceBindingCommitted();
    },
    [onWorkspaceBindingCommitted],
  );
  const forkTarget =
    forkDialogOpen && !forkDisabled
      ? { sourceAgent: props.agent, workspaceSeed: forkWorkspaceSeed }
      : null;
  return (
    <div
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-b border-canvas-border/70 px-3 py-1.5"
      data-testid="terminal-agent-pre-launch-toolbar"
    >
      <HostWorkspaceSelector
        surface={{
          kind: "terminal-agent",
          hostId: props.hostId,
          epicId: props.epicId,
          tabId: props.viewTabId,
          ownerId: props.agent.id,
          binding,
          isOwnerActive: props.isOwnerActive,
          // Terminal agents have no background-work-outlives-the-turn concept
          // distinct from PTY output (unlike chat), so there's no narrower
          // signal to distinguish - this field is unread for this surface kind
          // (the notice text is fixed regardless), kept equal for consistency.
          hasActiveTurn: props.isOwnerActive,
          // Surfaced on the chip as a per-folder "missing on disk" indicator.
          // The host-computed signal on `worktree.getBinding` — the actual
          // launch gate is the `prepareLaunch` WORKTREE_MISSING reject, but this
          // gives the user a proactive, owner-scoped visual matching chat.
          missingWorktreePaths: bindingQuery.data?.missingWorktreePaths ?? [],
          bindingResolved: bindingQuery.isSuccess,
          onBindingCommitted: handleWorkspaceBindingCommitted,
        }}
      />
      <AgentModeReadonlyLabel value={props.agentMode} />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 gap-1 px-2 text-ui-xs text-muted-foreground hover:text-foreground"
        disabled={forkDisabled}
        title={
          forkDisabled
            ? "Fork is available after the terminal agent session and workspace binding are ready."
            : "Fork terminal agent"
        }
        onClick={openForkDialog}
      >
        <GitFork aria-hidden className="size-3.5" />
        Fork
      </Button>
      {/* Right-aligned status-bar group: the worktree-creation notice sits
          beside the agent controls. The notice's expanded detail opens as a
          downward Popover overlay, so it never reflows the terminal below. */}
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <TerminalAgentWorktreeNotice
          hostId={props.hostId}
          agentId={props.agent.id}
          viewTabId={props.viewTabId}
          layout="chip"
        />
        <TerminalAgentHeaderControls
          epicId={props.epicId}
          tuiAgentId={props.agent.id}
        />
      </div>
      <TerminalAgentForkDialog
        open={forkDialogOpen}
        target={forkTarget}
        epicId={props.epicId}
        tabId={props.viewTabId}
        hostId={props.hostId}
        hostClient={props.hostClient}
        onOpenChange={setForkDialogOpen}
      />
    </div>
  );
}

/**
 * Worktree-creation notice for a terminal agent - the TUI analog of the chat
 * setup card. Reuses the exact `SetupCardSegment` a chat renders (in its
 * `inline` variant), fed a view-model projected from this agent's
 * `worktree.getBinding` (the same unary read the toolbar chip already uses, so
 * this shares its TanStack cache - no extra request). Renders nothing unless
 * the agent runs in a worktree it CREATED, so Local / imported bindings show no
 * card. Retry / Open-terminal route by `ownerKind: "terminal-agent"` as in chat.
 *
 * Self-resolves the epic + tab-host client from `hostId` (rather than taking
 * them as props) so it can render in EVERY tile state - reachability-checking,
 * agent-projection-pending, and live - not only once the PTY toolbar mounts;
 * `agentId` is the tab/node id, always known before the agent record projects.
 *
 * `layout`:
 *  - `"chip"` - just the compact trigger, placed by the caller inside the live
 *    status-bar toolbar.
 *  - `"bar"` - the trigger wrapped in a standalone status-bar strip, for the
 *    pre-launch (checking / projection-pending) states where no toolbar exists
 *    yet. Returns null (no empty strip) when there is no notice to show.
 */
function TerminalAgentWorktreeNotice(props: {
  readonly hostId: string;
  readonly agentId: string;
  readonly viewTabId: string;
  readonly layout: "chip" | "bar";
}) {
  const epicId = useOpenEpicId();
  const hostEntry = useHostDirectoryEntry(props.hostId);
  const hostClient = useHostClientFor(hostEntry);
  const paneVisible = usePaneVisible();
  const bindingQuery = useWorktreeGetBinding({
    client: hostClient,
    epicId,
    ownerId: props.agentId,
    ownerKind: "terminal-agent",
    enabled: true,
    // Mirror the toolbar chip's query options so the two observers share one
    // request and refresh together (re-check the binding on focus while the
    // pane is visible, so a completed setup flips the card without a reopen).
    staleTime: 0,
    refetchOnWindowFocus: paneVisible,
    // Poll while a setup script is in flight so a background completion/failure
    // surfaces on the card even while the agent PTY runs (no chat subscription
    // to push binding transitions). TanStack re-runs this against the freshest
    // binding after each fetch, so polling stops the moment every entry settles.
    refetchInterval: (query) =>
      hasInFlightWorktreeSetup(query.state.data?.binding ?? null)
        ? SETUP_BINDING_POLL_INTERVAL_MS
        : false,
  });
  const binding = bindingQuery.data?.binding ?? null;
  // Setup PTYs are spawned server-side, so nothing invalidates the renderer's
  // one-shot `terminal.list` query on its own; drive that off the binding so the
  // card's "Open terminal" liveness tracks the setup terminal as it starts/ends.
  useTuiSetupTerminalListRefreshDriver({ binding });
  // Register the running setup PTY as a background canvas tab so it auto-appears
  // in the canvas and survives a host/GUI restart (the host keeps no terminal
  // state across restarts - persistence comes only from a saved canvas tab).
  useTuiSetupTerminalTabRegisterDriver({ binding, viewTabId: props.viewTabId });
  const model = useMemo(
    () =>
      buildTuiAgentSetupCardModel(binding, { epicId, ownerId: props.agentId }),
    [binding, epicId, props.agentId],
  );
  if (model === null) return null;
  const card = (
    <SetupCardSegment
      model={model}
      viewTabId={props.viewTabId}
      variant="inline"
    />
  );
  if (props.layout === "chip") return card;
  return (
    <div
      className="flex min-w-0 shrink-0 items-center justify-end border-b border-canvas-border/70 px-3 py-1.5"
      data-testid="terminal-agent-worktree-setup-notice"
    >
      {card}
    </div>
  );
}

/**
 * The terminal-agent tile's outer chrome: a full-height `bg-canvas` column with
 * the tile test id. State-specific content (status bar + skeleton, or the live
 * shell) is provided as children.
 */
function TerminalAgentTileShell(props: {
  readonly tileId: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className="flex h-full w-full min-h-0 flex-col bg-canvas"
      data-testid={`terminal-agent-tile-${props.tileId}`}
    >
      {props.children}
    </div>
  );
}

/**
 * Right-aligned `[Agents N ▾]` popover for a terminal-agent tile - the TUI
 * analog of the chat composer's Active Agents panel (the tile has no
 * composer dock). Shows the same shared list: this agent on top with "Stop
 * all" (stop it + its subtree), its active sub-agents beneath. Hidden when
 * there are no active descendants.
 *
 * "Stop all" here interrupts this agent's own CLI too (consistent with the
 * chat panel). That's fine alongside Ctrl+C - it's the bulk "stop this whole
 * effort" action, just reached from the dropdown rather than a standalone
 * button.
 */
function TerminalAgentHeaderControls(props: {
  readonly epicId: string;
  readonly tuiAgentId: string;
}) {
  const controls = useAgentStopControls({
    epicId: props.epicId,
    rootAgentId: props.tuiAgentId,
  });

  const self = controls.self;
  if (self === null || controls.descendants.length === 0) return null;

  // Include the root agent in the badge when it is itself active.
  const runningCount = controls.descendants.length + (self.active ? 1 : 0);

  return (
    <div className="flex shrink-0 items-center gap-1">
      <Popover>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-ui-xs text-muted-foreground hover:text-foreground"
            data-testid="tui-agent-subagents-trigger"
          >
            <Users aria-hidden className="size-3.5" />
            Agents
            <span className="rounded bg-muted px-1 text-ui-xs">
              {runningCount}
            </span>
            <ChevronDown aria-hidden className="size-3" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(90vw,22rem)] p-0">
          <AgentStopList
            epicId={props.epicId}
            self={self}
            descendants={controls.descendants}
            surface="tui-popover"
          />
        </PopoverContent>
      </Popover>
    </div>
  );
}

interface TerminalAgentLiveProps {
  readonly handle: TerminalSessionStoreHandle;
  readonly instanceId: string;
  readonly viewTabId: string;
  readonly tileId: string;
  readonly isActive: boolean;
  // Called on each exit (returns `true` ⇒ the tile is deliberately killing +
  // recreating the PTY for a binding change). That kill produces a non-zero exit
  // that must NOT be treated as a crash - no error toast, no tab close - until
  // the new PTY is back. A getter (reads the parent's ref at exit time) rather
  // than a prop boolean so the parent can flip suppression without re-rendering
  // the live host, and rather than the ref itself (which react-hooks/refs flags
  // when passed across the prop boundary).
  readonly isRestartKillSuppressed: () => boolean;
  /** Revive (recreate + resume) after the host's idle-reap of this agent. */
  readonly onReapedExit: () => void;
  readonly recovery: TerminalSessionRecovery;
  readonly onCrashExit: () => void;
}

function TerminalAgentLive(props: TerminalAgentLiveProps) {
  const { handle } = props;
  const effectiveCols = useStore(handle.store, (s) => s.effectiveCols);
  const effectiveRows = useStore(handle.store, (s) => s.effectiveRows);
  const status = useStore(handle.store, (s) => s.status);
  const connectionStatus = useStore(handle.store, (s) => s.connectionStatus);
  const exitCode = useStore(handle.store, (s) => s.exitCode);
  const exitReason = useStore(handle.store, (s) => s.exitReason);
  const lastOutputPreview = useStore(handle.store, (s) => s.lastOutputPreview);
  const closeCanvasTile = useCloseCanvasTileWithNestedFocus(
    props.viewTabId,
    props.tileId,
    props.instanceId,
  );
  const exitToastShownRef = useRef(false);
  // One revive request per exit: the exit effect can re-run while the store
  // still reports the same exited state (dep identity churn), and stacking
  // `terminal.create` retries for one reap would race each other.
  const reapedReviveRequestedRef = useRef(false);
  useTerminalCrashNotification({
    handle,
    isExitSuppressed: props.isRestartKillSuppressed,
    onCrashExit: props.onCrashExit,
  });

  const isRestartKillSuppressed = props.isRestartKillSuppressed;
  const showExitToast = useCallback(() => {
    // A deliberate binding-change restart kills the PTY (non-zero exit); that is
    // not a crash, so skip the error toast for it. Read at call time (not a dep)
    // so the latest suppression state applies to this exact exit.
    if (isRestartKillSuppressed()) return;
    if (status !== "exited") return;
    // A `reaped` exit is the host's idle-reap of an unwatched agent -
    // lifecycle, not a crash. The exit effect below revives it in place.
    if (exitReason === "reaped") return;
    if (!exitToastShownRef.current && exitCode !== null && exitCode !== 0) {
      exitToastShownRef.current = true;
      reportableErrorToast(
        "Terminal agent exited with an error.",
        {
          description:
            lastOutputPreview ??
            "The agent stopped before reporting a readable error. Try restarting it.",
        },
        createReportIssueContext({
          title: "Terminal agent exited with an error",
          message: null,
          code: String(exitCode),
          source: "Terminal agent",
        }),
      );
    }
  }, [
    status,
    exitCode,
    exitReason,
    lastOutputPreview,
    isRestartKillSuppressed,
  ]);
  useActivePaneEffect(showExitToast);

  const onReapedExit = props.onReapedExit;
  useEffect(() => {
    if (status === "running") {
      // A live PTY (fresh spawn or completed revive) re-arms the one-shot so
      // a later reap - after another long unwatched stretch - revives again.
      reapedReviveRequestedRef.current = false;
    }
  }, [status]);
  useEffect(() => {
    if (status !== "exited") return;
    // Don't close the tab on the kill we issued for a restart - the bootstrap is
    // already recreating the PTY under the same id. Closing here is the bug that
    // dropped the terminal the instant folder edits were applied. Read on this
    // exact exit; a genuine later exit sees suppression cleared and closes.
    if (isRestartKillSuppressed()) return;
    if (exitReason === "reaped") {
      // Host idle-reap of an unwatched agent: keep the tab open and revive
      // the session in place (recreate under the same id; `prepareLaunch`
      // resumes the conversation) instead of closing on a lifecycle event.
      if (!reapedReviveRequestedRef.current) {
        reapedReviveRequestedRef.current = true;
        onReapedExit();
      }
      return;
    }
    if (
      isTerminalCrashExit({
        status,
        exitCode,
        exitReason,
        isExitSuppressed: isRestartKillSuppressed,
      })
    ) {
      return;
    }
    // `closeCanvasTab` resolves the tile by its pane tab *instance* id
    // (`pane.tabInstanceIds`), not the content/session id. Passing
    // `handle.sessionId` (the agent record id) silently no-ops, leaving the
    // tab open after the harness TUI exits (e.g. Ctrl+C). Use the instance id.
    closeCanvasTile();
  }, [
    status,
    exitCode,
    exitReason,
    onReapedExit,
    closeCanvasTile,
    isRestartKillSuppressed,
  ]);

  const handleUserInput = useCallback(
    (data: string) => {
      handle.store.getState().writeInput(data);
    },
    [handle],
  );
  const handleContainerResize = useCallback(
    (cols: number, rows: number) => {
      handle.store.getState().requestResize(cols, rows);
    },
    [handle],
  );
  const handleWriterReady = useCallback(
    (writer: TerminalDataWriter | null) => {
      handle.store.getState().setWriter(writer);
    },
    [handle],
  );

  const { onSessionLost, onSessionHealthy } = props.recovery;
  // Automatic recovery off the lifecycle status. A TUI agent reaped while the
  // app was disconnected lands in "lost"; the owner force-releases and remounts
  // the bootstrap, which re-issues `prepareLaunch` to resume the conversation.
  // "running" means a live session, refilling the auto-recovery budget.
  useEffect(() => {
    if (status === "lost") onSessionLost();
  }, [status, onSessionLost]);
  useEffect(() => {
    if (status === "running") onSessionHealthy();
  }, [status, onSessionHealthy]);

  const overlayState = resolveTerminalOverlayState({
    status,
    connectionStatus,
    recoveryExhausted: props.recovery.recoveryExhausted,
  });

  // Fragment, not a wrapping element: both the xterm host and the overlay are
  // `absolute inset-0`, so they share the tile's existing positioned ancestor.
  // Introducing a wrapper here would change that positioning context.
  return (
    <>
      <Suspense fallback={<TerminalLoadingSkeleton />}>
        <TerminalXtermHost
          sessionId={handle.sessionId}
          tileKind="terminal-agent"
          chrome="padded"
          instanceId={props.instanceId}
          effectiveCols={effectiveCols}
          effectiveRows={effectiveRows}
          onUserInput={handleUserInput}
          onContainerResize={handleContainerResize}
          onWriterReady={handleWriterReady}
          shouldFocusOnActivePane={props.isActive}
          findTargetId={
            props.isActive
              ? `terminal-agent:${props.viewTabId}:${props.tileId}:${handle.sessionId}`
              : null
          }
          // A running TUI agent's session handle is kept lease-free across
          // unmount, so the host never re-sends its snapshot. Keep the xterm
          // engine alive too - otherwise a pane split disposes the only copy of
          // the scrollback and the tab renders blank. Once the agent exits the
          // handle is evicted, so stop pinning the engine.
          keepAlive={status !== "exited"}
        />
      </Suspense>
      {overlayState !== null ? (
        <TerminalConnectionOverlay
          state={overlayState}
          onReconnect={props.recovery.onManualReconnect}
          testId={`terminal-connection-overlay-${props.tileId}`}
        />
      ) : null}
    </>
  );
}
