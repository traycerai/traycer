import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { useStore } from "zustand";
import type { ChatRunSettings } from "@traycer/protocol/host/agent/gui/subscribe";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import type { TuiAgentProjection } from "@/stores/epics/open-epic/types";
import type { ForkWorkspaceSeed } from "@/lib/worktree/fork-workspace-seed";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { HarnessModelPicker } from "@/components/home/pickers/harness-model-picker";
import { AgentModeToggle } from "@/components/home/pickers/agent-mode-toggle";
import { ActiveHostWorkspaceControls } from "@/components/home/host-workspace-selector/host-workspace-selector";
import { SurfaceActivityProvider } from "@/components/home/composer/surface-activity-context";
import { useComposerToolbarStore } from "@/components/home/hooks/use-composer-toolbar-store";
import { fallbackSeedSource } from "@/lib/composer/composer-seed-source";
import {
  type CreateTuiAgentStatus,
  useCreateTuiAgentForClient,
} from "@/hooks/agent/use-create-tui-agent";
import { displayTitle } from "@/lib/display-title";
import { readSeededLaunchWorkspace } from "@/lib/worktree/seeded-launch-worktree-intent";
import { useSeededWorkspaceSnapshotStore } from "@/stores/worktree/seeded-workspace-snapshot-store";
import { deriveWorkspaceMode } from "@/lib/worktree/workspace-mode";
import {
  pendingForkTerminalAgentStagingKey,
  useWorktreeIntentStagingStore,
  worktreeStagingKeyString,
  type WorktreeStagingKey,
} from "@/stores/worktree/worktree-intent-staging-store";
import { useWorktreeIntentMemoryStore } from "@/stores/worktree/worktree-intent-memory-store";
import { Analytics, AnalyticsEvent } from "@/lib/analytics";

// `pendingForkTerminalAgentStagingKey` is per-EPIC, so every terminal-agent
// tile in an epic shares one staging slot. Two dialog bodies can therefore be
// mounted over the same key (one unmounting as another opens), and the loser's
// teardown must not wipe the winner's freshly-seeded workspace. Whoever
// registered last owns the slot; a stale cleanup sees a different symbol and
// bails. Mirrors `chat-fork-dialog.tsx`.
const activeTerminalForkWorkspaceOwnerByKey = new Map<string, symbol>();

export interface TerminalAgentForkDialogTarget {
  readonly sourceAgent: TuiAgentProjection;
  readonly workspaceSeed: ForkWorkspaceSeed;
}

type TerminalAgentForkStatus = "idle" | CreateTuiAgentStatus;

interface TerminalAgentForkDialogProps {
  readonly open: boolean;
  readonly target: TerminalAgentForkDialogTarget | null;
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string;
  readonly hostClient: HostClient<HostRpcRegistry> | null;
  readonly onOpenChange: (open: boolean) => void;
}

export function TerminalAgentForkDialog(props: TerminalAgentForkDialogProps) {
  return (
    <SurfaceActivityProvider active={props.open}>
      <TerminalAgentForkDialogBody {...props} />
    </SurfaceActivityProvider>
  );
}

// Coordinates dialog lifecycle, toolbar state, staged worktree state, and the
// fork mutation in one fixed hook order. Splitting this body risks hiding the
// cross-field submit invariants without reducing user-facing behavior.
// eslint-disable-next-line complexity
function TerminalAgentForkDialogBody(props: TerminalAgentForkDialogProps) {
  const { hostClient, hostId, epicId, onOpenChange, open, tabId, target } =
    props;
  const titleInputId = useId();
  const argsInputId = useId();
  const [titleState, setTitleState] = useState(() => ({
    open,
    title:
      open && target !== null
        ? terminalForkDefaultTitle(target.sourceAgent)
        : "",
  }));
  const stagingKey = useMemo(
    () => pendingForkTerminalAgentStagingKey(epicId),
    [epicId],
  );
  const settingsSeed = useMemo(() => {
    if (target === null) return null;
    return terminalForkSettingsSeed(target.sourceAgent);
  }, [target]);
  // A fork dialog has no send-time reauth gate of its own (unlike the main
  // composer), so a source agent's profileId that was tombstoned since it
  // last ran must be caught before it reaches `createAgent.create`.
  // `useComposerToolbarStore` now validates every seed it receives against
  // the SAME host's live `providers.list` (passing `hostClient` here - this
  // dialog's explicit prop, not necessarily the app-wide active host -
  // mirroring how the workspace controls below already query this fixed
  // host), so no separate resolution is needed at this call site. Never
  // authoritative: this dialog has no reauth gate of its own, so a
  // genuinely-tombstoned source profile must be corrected to ambient here
  // rather than silently submitted to `createAgent.create`.
  const toolbarStore = useComposerToolbarStore(
    null,
    fallbackSeedSource(settingsSeed, hostClient),
    null,
    true,
  );
  const createAgent = useCreateTuiAgentForClient(hostClient, hostId);
  const [status, setStatus] = useState<TerminalAgentForkStatus>("idle");
  const modelResolved = useStore(
    toolbarStore,
    (s) => s.selection.modelSlug.length > 0,
  );
  const agentMode = useStore(toolbarStore, (s) => s.agentMode);
  const setAgentMode = useStore(toolbarStore, (s) => s.setAgentMode);
  const defaultTitle =
    target === null ? "" : terminalForkDefaultTitle(target.sourceAgent);
  if (open !== titleState.open) {
    setTitleState({
      open,
      title: open && target !== null ? defaultTitle : titleState.title,
    });
    // Clear the transient submit status when the dialog closes (incl. an
    // external close mid-submit). Adjusted during render on the `open` prop
    // transition rather than in an effect.
    if (!open && status !== "idle") setStatus("idle");
  }
  const title = titleState.title;
  const setTitle = useCallback((nextTitle: string): void => {
    setTitleState((current) => ({ ...current, title: nextTitle }));
  }, []);
  const trimmedTitle = title.trim();
  const sourceSessionId = target?.sourceAgent.harnessSessionId ?? null;
  const [argsState, setArgsState] = useState(() => ({
    sourceAgentId: "",
    draft: "",
    touched: false,
  }));
  const sourceAgentId = target?.sourceAgent.id ?? "";
  const sourceArgs = target?.sourceAgent.terminalAgentArgs ?? "";
  // `argsDraft` / `argsTouched` are DERIVED from `argsState` vs the current
  // source: a different source (or a never-touched field) falls back to the
  // source's own args, so there is no effect syncing state to the props - the
  // input's onChange stamps `sourceAgentId` when the user edits.
  const argsDraft =
    argsState.sourceAgentId === sourceAgentId ? argsState.draft : sourceArgs;
  const argsTouched =
    argsState.sourceAgentId === sourceAgentId ? argsState.touched : false;
  const busy = createAgent.isPending || status !== "idle";
  const canSubmit =
    target !== null &&
    sourceSessionId !== null &&
    trimmedTitle.length > 0 &&
    modelResolved &&
    !busy;

  // The seeded workspace (staged intent + live snapshot) is scratch state for
  // THIS fork attempt. Abandoning the dialog must drop it, or the next fork in
  // the epic reads the cancelled fork's folders/primary back out of the shared
  // per-epic slot - `readSeededLaunchWorkspace` prefers the snapshot over the
  // new target's `workspaceSeed`.
  const activeWorkspaceTarget = open ? target : null;
  useEffect(() => {
    if (activeWorkspaceTarget === null) return;
    const stagingKeyId = worktreeStagingKeyString(stagingKey);
    const owner = Symbol(activeWorkspaceTarget.sourceAgent.id);
    activeTerminalForkWorkspaceOwnerByKey.set(stagingKeyId, owner);
    return () => {
      if (activeTerminalForkWorkspaceOwnerByKey.get(stagingKeyId) !== owner) {
        return;
      }
      activeTerminalForkWorkspaceOwnerByKey.delete(stagingKeyId);
      clearTerminalForkWorkspace(stagingKey);
    };
  }, [activeWorkspaceTarget, stagingKey]);

  const close = useCallback(() => {
    if (busy) return;
    clearTerminalForkWorkspace(stagingKey);
    onOpenChange(false);
  }, [busy, onOpenChange, stagingKey]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!nextOpen && busy) return;
      if (!nextOpen) {
        clearTerminalForkWorkspace(stagingKey);
      }
      onOpenChange(nextOpen);
    },
    [busy, onOpenChange, stagingKey],
  );

  const submit = useCallback(() => {
    // `canSubmit` already implies `target !== null && sourceSessionId !== null`,
    // and TS narrows both from it for the rest of this callback.
    if (!canSubmit) return;
    const launchWorkspace = readSeededLaunchWorkspace({
      stagingKey,
      seedIntent: target.workspaceSeed.intent,
      fallbackWorkspace: target.workspaceSeed.workspace,
    });
    const worktreeIntent = launchWorkspace.worktreeIntent;
    if (worktreeIntent !== null) {
      useWorktreeIntentMemoryStore
        .getState()
        .setEpicIntent(epicId, worktreeIntent, Date.now());
    }
    setStatus(
      worktreeIntent !== null && worktreeIntent.entries.length > 0
        ? "preparing-workspace"
        : "forking-session",
    );
    const toolbar = toolbarStore.getState();
    void createAgent
      .create({
        epicId,
        tabId,
        parentId: target.sourceAgent.parentId,
        title: trimmedTitle,
        placement: { kind: "active-tile" },
        harnessId: target.sourceAgent.harnessId,
        model:
          toolbar.selection.modelSlug.length > 0
            ? toolbar.selection.modelSlug
            : null,
        reasoningEffort:
          toolbar.reasoning.length > 0 ? toolbar.reasoning : null,
        agentMode: toolbar.agentMode,
        profileId: toolbar.selection.profileId,
        forkSourceHarnessSessionId: sourceSessionId,
        onStatusChange: setStatus,
        worktreeIntent,
        workspaceMode: deriveWorkspaceMode(
          launchWorkspace.folderCount,
          worktreeIntent,
        ),
        terminalAgentArgs: argsTouched
          ? argsDraft
          : target.sourceAgent.terminalAgentArgs,
      })
      .then((createdAgentId) => {
        if (createdAgentId !== null) {
          Analytics.getInstance().track(AnalyticsEvent.TerminalAgentForked, {
            source: "direct_ui",
            harness: target.sourceAgent.harnessId,
          });
          clearTerminalForkWorkspace(stagingKey);
          onOpenChange(false);
        }
      })
      .catch(() => undefined)
      .finally(() => setStatus("idle"));
  }, [
    argsDraft,
    argsTouched,
    canSubmit,
    createAgent,
    epicId,
    onOpenChange,
    sourceSessionId,
    stagingKey,
    tabId,
    target,
    toolbarStore,
    trimmedTitle,
  ]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="w-[min(94vw,32rem)] gap-2 sm:max-w-[min(94vw,34rem)]">
        <DialogHeader>
          <DialogTitle>Fork terminal agent</DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-2">
          <label htmlFor={titleInputId} className="flex min-w-0 flex-col gap-2">
            <span className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70">
              Title
            </span>
            <Input
              id={titleInputId}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              disabled={busy}
              aria-label="Fork terminal agent title"
            />
          </label>
          <section className="flex min-w-0 flex-col gap-2">
            <div className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70">
              Harness
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <HarnessModelPicker
                key={terminalForkModelPickerKey(target)}
                store={toolbarStore}
                withServiceTier={false}
                tuiOnly
                lockedHarnessId={target?.sourceAgent.harnessId ?? null}
                disabled={busy}
                registerActivation={false}
                createProfileHostId={hostId}
                runTargetHostId={hostId}
              />
              <div className="shrink-0">
                <AgentModeToggle
                  value={agentMode}
                  disabled={busy}
                  showTooltip={false}
                  onChange={setAgentMode}
                />
              </div>
            </div>
          </section>
          <label htmlFor={argsInputId} className="flex min-w-0 flex-col gap-2">
            <span className="px-0 py-0 font-sans text-overline font-medium uppercase text-muted-foreground/70">
              Additional args
            </span>
            <Input
              id={argsInputId}
              value={argsDraft}
              onChange={(event) =>
                setArgsState({
                  sourceAgentId,
                  draft: event.target.value,
                  touched: true,
                })
              }
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              disabled={busy}
              aria-label="Terminal interface CLI arguments"
              className="font-mono text-ui-xs"
            />
          </label>
          <ActiveHostWorkspaceControls
            stagingKey={stagingKey}
            layout="stacked"
            workspaceSeed={target?.workspaceSeed.workspace ?? null}
            seedIntent={target?.workspaceSeed.intent ?? null}
            seedIntentOverride={null}
            hostScope={{ kind: "fixed", hostId, hostClient }}
          />
          {status !== "idle" ? (
            <div
              role="status"
              aria-live="polite"
              className="min-h-5 text-ui-xs text-muted-foreground"
            >
              {terminalForkStatusLabel(status)}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={submit}>
            {busy ? (
              <AgentSpinningDots
                className="text-current"
                testId={undefined}
                variant={undefined}
              />
            ) : null}
            {terminalForkButtonLabel(status)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Drops both halves of this fork's scratch workspace: the staged per-folder
// intent (branch/scripts selections) and the live snapshot the picker mirrors
// out for `readSeededLaunchWorkspace`. Idempotent - a successful submit clears
// here and the close that follows clears again.
function clearTerminalForkWorkspace(stagingKey: WorktreeStagingKey): void {
  useWorktreeIntentStagingStore.getState().clear(stagingKey);
  useSeededWorkspaceSnapshotStore.getState().clear(stagingKey);
}

function terminalForkStatusLabel(status: CreateTuiAgentStatus): string {
  switch (status) {
    case "preparing-workspace":
      return "Preparing linked folders";
    case "forking-session":
      return "Forking terminal agent";
    case "starting-terminal":
      return "Starting terminal";
  }
}

function terminalForkButtonLabel(status: TerminalAgentForkStatus): string {
  switch (status) {
    case "idle":
      return "Fork";
    case "preparing-workspace":
      return "Preparing";
    case "forking-session":
      return "Forking";
    case "starting-terminal":
      return "Starting terminal";
  }
}

function terminalForkSettingsSeed(agent: TuiAgentProjection): ChatRunSettings {
  return {
    harnessId: agent.harnessId,
    model: agent.model ?? "",
    permissionMode: "supervised",
    reasoningEffort: agent.reasoningEffort,
    serviceTier: null,
    agentMode: agent.agentMode,
    // Seed from the source agent's profile - `useComposerToolbarStore`
    // validates it against the target host's live provider profiles; the
    // harness stays locked (see `lockedHarnessId` below) but the user can
    // still switch between that harness's OTHER profiles via the rail
    // before forking.
    profileId: agent.profileId,
  };
}

function terminalForkDefaultTitle(agent: TuiAgentProjection): string {
  return `Fork - ${displayTitle(agent.title, "agent")}`;
}

function terminalForkModelPickerKey(
  target: TerminalAgentForkDialogTarget | null,
): string {
  if (target === null) return "terminal-fork-dialog-closed";
  const agent = target.sourceAgent;
  return [
    agent.id,
    agent.harnessId,
    agent.model ?? "",
    agent.reasoningEffort ?? "",
    agent.agentMode,
    agent.profileId ?? "",
  ].join("\u0000");
}
