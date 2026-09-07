import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { TuiHarnessId } from "@traycer/protocol/persistence/epic/schemas";
import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { useEpicCreateTuiAgentForClient } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useAgentStartTerminalSession } from "@/hooks/agent/use-prepare-tui-launch-mutation";
import { useValidateTuiForkProfile } from "@/hooks/agent/use-validate-tui-fork-profile-mutation";
import { useTuiForkProfileSupported } from "@/hooks/agent/use-tui-fork-profile-support";
import { useWorktreeCreateForClient } from "@/hooks/worktree/use-worktree-create-mutation";
import { useAddressableHostId } from "@/hooks/host/use-addressable-host-id";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import type { ExplicitTilePlacement } from "@/lib/canvas/tile-open/intent";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { type HostRpcRegistry, useHostClient } from "@/lib/host";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import { TuiForkProfileRejectedError } from "@/lib/tui-fork-profile-rejection";
import { workspaceFolderName } from "@/lib/worktree/workspace-folder-name";
import { displayTitle } from "@/lib/display-title";
import { worktreeCreateEntries } from "@/lib/worktree/worktree-create-request";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  clearPreparedTerminalAgentLaunch,
  stashPreparedTerminalAgentLaunch,
} from "@/stores/terminals/prepared-terminal-agent-launch-store";

const TUI_AGENT_PROJECTION_WAIT_MS = 30_000;

/** Creation holds the canvas pending-create mark until this resolves so the close-tile reconcile in `use-epic-route-synchronization` never sees the just-opened tab as neither-pending-nor-live - the race where `epic.createTuiAgent` resolves on the RPC channel BEFORE its Y.Doc update streams back and projects, and the reconcile closes the tab in that window. */
function waitForTuiAgentProjected(
  epicId: string,
  tuiAgentId: string,
): Promise<void> {
  const handle = getOpenEpicRegistry().get(epicId);
  if (handle === null) return Promise.resolve();
  const isProjected = (): boolean =>
    Object.hasOwn(handle.store.getState().tuiAgents.byId, tuiAgentId);
  if (isProjected()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      window.clearTimeout(timer);
      resolve();
    };
    const unsubscribe = handle.store.subscribe(() => {
      if (isProjected()) finish();
    });
    const timer = window.setTimeout(finish, TUI_AGENT_PROJECTION_WAIT_MS);
  });
}

type WorktreeCreateRequest = RequestOfMethod<
  HostRpcRegistry,
  "worktree.create"
>;
type WorktreeCreateResponse = ResponseOfMethod<
  HostRpcRegistry,
  "worktree.create"
>;
type WorktreeCreateMutateAsync = (
  variables: WorktreeCreateRequest,
) => Promise<WorktreeCreateResponse>;

type ValidateForkProfileRequest = RequestOfMethod<
  HostRpcRegistry,
  "agent.tui.validateForkProfile"
>;
type ValidateForkProfileResponse = ResponseOfMethod<
  HostRpcRegistry,
  "agent.tui.validateForkProfile"
>;
type ValidateForkProfileMutateAsync = (
  variables: ValidateForkProfileRequest,
) => Promise<ValidateForkProfileResponse>;

/** WORKTREE_MISSING is typed; setup-script failure does not fail the launch. Explicit intent persists worktree.create first and can leave an orphan binding. */
export type CreateTuiAgentStatus =
  | "preparing-workspace"
  | "forking-session"
  | "starting-terminal";

export interface CreateTuiAgentInput {
  readonly epicId: string;
  readonly tabId: string;
  readonly parentId: string | null;
  readonly title: string;
  /** Explicit placement for the placeholder tile, or `null` to let the conversation tile-placement setting decide (C3, C8). */
  readonly placement: ExplicitTilePlacement | null;
  readonly harnessId: TuiHarnessId;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly forkSourceHarnessSessionId: string | null;
  /** Threaded onto `agent.tui.prepareLaunch` as `forkSourceTuiAgentId` so the resolver validates the exact `{id, epic, harness, session, user, host}` tuple instead of scanning for a `(harnessId, harnessSessionId, hostId, userId)` match, and used here to preflight cross-profile admission before any worktree/binding work. */
  readonly sourceTuiAgentId: string | null;
  /** The fork source's own `profileId`, so this hook can tell a cross-profile fork (preflight required) apart from a same-profile one (the guard trivially admits; skip the extra round trip). */
  readonly sourceProfileId: string | null;
  readonly onStatusChange: ((status: CreateTuiAgentStatus) => void) | null;
  /**
   * `null` skips the binding RPC; `prepareLaunch` seeds a default owner-scoped Local binding. Non-null dispatches `worktree.*` before prepare so the resolver sees it.
   */
  readonly worktreeIntent: WorktreeIntent | null;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
  /** A string (pre-filled from the provider's Settings default in the picker, editable per launch) is the explicit override forwarded to `agent.tui.prepareLaunch`; `null` means "no override - use the provider's saved Settings default" (surfaces without an args field, e.g. */
  readonly terminalAgentArgs: string | null;
  /** Which of the harness's logged-in profiles (subscriptions) to launch this agent on. */
  readonly profileId: string | null;
}

export function useCreateTuiAgent(): {
  readonly create: (input: CreateTuiAgentInput) => Promise<string | null>;
  readonly isPending: boolean;
} {
  const hostClient = useHostClient();
  // Stamp the renderer's current default; once the projection lands, the per-tile binding rides on the `TuiAgentProjection.hostId` rather than this placeholder value.
  const placeholderHostId = useAddressableHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  return useCreateTuiAgentForClient(hostClient, placeholderHostId);
}

export function useCreateTuiAgentForClient(
  hostClient: HostClient<HostRpcRegistry> | null,
  placeholderHostId: string,
): {
  readonly create: (input: CreateTuiAgentInput) => Promise<string | null>;
  readonly isPending: boolean;
} {
  const startSession = useAgentStartTerminalSession(hostClient);
  const createTuiAgent = useEpicCreateTuiAgentForClient(hostClient);
  const worktreeCreate = useWorktreeCreateForClient(hostClient, undefined);
  const validateForkProfile = useValidateTuiForkProfile(hostClient);
  const forkProfilePreflightSupported =
    useTuiForkProfileSupported(placeholderHostId);
  const { openTile } = useEpicTileNavigation();
  const markArtifactPendingCreate = useEpicCanvasStore(
    (s) => s.markArtifactPendingCreate,
  );
  const unmarkArtifactPendingCreate = useEpicCanvasStore(
    (s) => s.unmarkArtifactPendingCreate,
  );

  const create = useCallback(
    async (input: CreateTuiAgentInput): Promise<string | null> => {
      const tuiAgentId = uuidv4();

      const opensAfterSessionPrepared =
        input.forkSourceHarnessSessionId !== null;

      // Object holder, not a bare `let`: `opened` is flipped inside the `openPlaceholder` closure, and a closure-mutated `let` narrows to its `false` initializer at the `finally` check (no-unnecessary-condition would flag it always-false).
      const placeholder = { opened: false };
      const openPlaceholder = (): void => {
        // Open the canvas placeholder before `prepareLaunch` waits (forks excepted). Mark pending-create so route sync does not close it for lacking a projected record.
        markArtifactPendingCreate(tuiAgentId);
        placeholder.opened = true;
        const placeholderRef = {
          id: tuiAgentId,
          instanceId: uuidv4(),
          type: "terminal-agent" as const,
          name: displayTitle(input.title, "agent"),
          hostId: placeholderHostId,
          pendingTuiHarnessId: input.harnessId,
        };
        openTile({
          node: placeholderRef,
          target: { tabId: input.tabId },
          gesture: "explicit",
          modifiers: null,
          placement: input.placement,
          dedupe: true,
          source: "direct_ui",
        });
      };

      let clearStashedPreparedLaunch = false;
      try {
        // Preflight cross-profile fork admission BEFORE anything else - including the placeholder tile and worktree/binding work below - so a rejection leaves NOTHING created (tech plan governing client-side ordering).
        const preflightTarget = resolveForkProfilePreflightTarget(
          input,
          forkProfilePreflightSupported,
        );
        if (preflightTarget !== null) {
          await preflightForkProfileAdmission({
            epicId: input.epicId,
            sourceTuiAgentId: preflightTarget.sourceTuiAgentId,
            targetProfileId: preflightTarget.targetProfileId,
            validateForkProfile: validateForkProfile.mutateAsync,
          });
        }
        if (!opensAfterSessionPrepared) {
          openPlaceholder();
        }
        // Skipping it would leave no binding at prepareLaunch, so the seam there would seed a *default* Local binding from the epic's folders, silently discarding the explicit choice.
        if (input.worktreeIntent !== null) {
          if (input.worktreeIntent.entries.length > 0) {
            input.onStatusChange?.("preparing-workspace");
          }
          await dispatchWorktreeIntent({
            intent: input.worktreeIntent,
            epicId: input.epicId,
            tuiAgentId,
            worktreeCreate: worktreeCreate.mutateAsync,
          });
        }
        if (input.forkSourceHarnessSessionId !== null) {
          input.onStatusChange?.("forking-session");
        }
        // Setup failure / cancellation rejects here with a typed error before any harness work happens - the catch chain below ensures `epic.createTuiAgent` is never invoked on that path.
        const session = await startSession.mutateAsync({
          harnessId: input.harnessId,
          epicId: input.epicId,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          // Epic Mode was removed from the product; the protocol still carries
          // the field, so state the one remaining mode.
          agentMode: "regular",
          tuiAgentId,
          harnessSessionId: null,
          forkSourceHarnessSessionId: input.forkSourceHarnessSessionId,
          forkSourceTuiAgentId: input.sourceTuiAgentId,
          terminalAgentArgs: input.terminalAgentArgs,
          workspaceMode: input.workspaceMode,
          profileId: input.profileId,
        });
        if (
          opensAfterSessionPrepared &&
          session.terminalShellCommand !== null &&
          session.terminalShellArgs !== null
        ) {
          stashPreparedTerminalAgentLaunch(tuiAgentId, {
            cwd: session.workingDirectory,
            shellCommand: session.terminalShellCommand,
            shellArgs: session.terminalShellArgs,
            worktreeBusyPaths: session.worktreeBusyPaths,
          });
          clearStashedPreparedLaunch = true;
        }
        input.onStatusChange?.("starting-terminal");
        if (opensAfterSessionPrepared) {
          openPlaceholder();
        }
        const created = await createTuiAgent.mutateAsync({
          epicId: input.epicId,
          parentId: input.parentId,
          title: input.title,
          harnessId: input.harnessId,
          harnessSessionId: session.harnessSessionId,
          terminalAgentArgs: input.terminalAgentArgs,
          terminalShellCommand: session.terminalShellCommand,
          terminalShellArgs:
            session.terminalShellArgs === null
              ? null
              : [...session.terminalShellArgs],
          hostId: session.hostId,
          workspaceFolders: [...session.workspaceFolders],
          workspaceMode: input.workspaceMode,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          agentMode: "regular",
          tuiAgentId,
          profileId: input.profileId,
          forkSourceHarnessSessionId: input.forkSourceHarnessSessionId,
        });
        // Hold the pending-create mark until the record actually projects, so the close-tile reconcile can't close the optimistic tab in the window between this RPC resolving and its Y.Doc update streaming back.
        await waitForTuiAgentProjected(input.epicId, tuiAgentId);
        clearStashedPreparedLaunch = false;
        return created.tuiAgentId;
      } finally {
        if (clearStashedPreparedLaunch) {
          clearPreparedTerminalAgentLaunch(tuiAgentId);
        }
        if (placeholder.opened) {
          unmarkArtifactPendingCreate(tuiAgentId);
        }
      }
    },
    [
      startSession,
      createTuiAgent,
      openTile,
      markArtifactPendingCreate,
      unmarkArtifactPendingCreate,
      placeholderHostId,
      worktreeCreate,
      validateForkProfile,
      forkProfilePreflightSupported,
    ],
  );

  return {
    create,
    isPending:
      validateForkProfile.isPending ||
      startSession.isPending ||
      createTuiAgent.isPending ||
      worktreeCreate.isPending,
  };
}

// `null` also when the connected host predates the capability - never call an unsupported method; `agent.tui.prepareLaunch`'s own authoritative guard still backstops that case with the strict-scan fallback.
function resolveForkProfilePreflightTarget(
  input: CreateTuiAgentInput,
  preflightSupported: boolean,
): { sourceTuiAgentId: string; targetProfileId: string | null } | null {
  if (
    input.sourceTuiAgentId === null ||
    input.profileId === input.sourceProfileId ||
    !preflightSupported
  ) {
    return null;
  }
  return {
    sourceTuiAgentId: input.sourceTuiAgentId,
    targetProfileId: input.profileId,
  };
}

interface PreflightForkProfileAdmissionArgs {
  readonly epicId: string;
  readonly sourceTuiAgentId: string;
  readonly targetProfileId: string | null;
  readonly validateForkProfile: ValidateForkProfileMutateAsync;
}

// Rejects with `TuiForkProfileRejectedError` never a silent no-op - so the caller's `try` aborts before any
async function preflightForkProfileAdmission(
  args: PreflightForkProfileAdmissionArgs,
): Promise<void> {
  const result = await args.validateForkProfile({
    epicId: args.epicId,
    sourceTuiAgentId: args.sourceTuiAgentId,
    targetProfileIds: [args.targetProfileId],
  });
  const verdict = result.verdicts.find(
    (candidate) => candidate.targetProfileId === args.targetProfileId,
  );
  if (verdict?.admitted === true) return;
  const subcode = verdict?.subcode ?? "SCOPE_MISMATCH";
  const message =
    verdict?.message ??
    "This profile doesn't share conversation history with the source terminal agent.";
  throw new TuiForkProfileRejectedError(subcode, message);
}

interface DispatchWorktreeIntentArgs {
  readonly intent: WorktreeIntent;
  readonly epicId: string;
  readonly tuiAgentId: string;
  readonly worktreeCreate: WorktreeCreateMutateAsync;
}

async function dispatchWorktreeIntent(
  args: DispatchWorktreeIntentArgs,
): Promise<void> {
  const { intent, epicId, tuiAgentId } = args;
  // A mode-only intent with no entries needs no binding write: prepare-launch's host seam seeds the default owner-scoped Local binding from the epic's folders when it finds no row (the always-non-empty invariant), so there is nothing to dispatch here.
  if (intent.entries.length === 0) return;
  const entries = worktreeCreateEntries(intent.entries);
  // One call keeps entry routing and binding composition owned by `resolveIntent` instead of re-deriving them client-side across separate create / import / setEntryMode RPCs.
  const result = await args.worktreeCreate({
    epicId,
    ownerId: tuiAgentId,
    ownerKind: "terminal-agent",
    entries,
  });
  // The RPC resolves per-entry: an entry the host failed - or reported nothing about - has no `ok` row.
  const okPaths = new Set(
    result.perEntry
      .filter((entryResult) => entryResult.ok)
      .map((entryResult) => entryResult.workspacePath),
  );
  const failedPaths = intent.entries
    .map((entry) => entry.workspacePath)
    .filter((workspacePath) => !okPaths.has(workspacePath));
  if (failedPaths.length > 0) {
    const folder = workspaceFolderName(failedPaths[0]);
    const scope =
      failedPaths.length === 1
        ? `"${folder}"`
        : `${failedPaths.length} folders, starting with "${folder}"`;
    // The reason must describe the SAME entry `scope` names, so read it off `failedPaths[0]` rather than the first entry that happens to carry one - a later entry's message would misattribute the failure.
    const reason =
      result.perEntry.find(
        (entryResult) =>
          entryResult.workspacePath === failedPaths[0] && !entryResult.ok,
      )?.errorMessage ?? null;
    const message = `Couldn't prepare the workspace for ${scope}. The terminal agent was not launched.`;
    reportableErrorToast(
      message,
      reason === null ? undefined : { description: reason },
      {
        title: "Terminal agent launch aborted",
        message: reason,
        code: null,
        source: "Worktree create",
      },
    );
    throw new Error(reason === null ? message : `${message} ${reason}`);
  }
}
