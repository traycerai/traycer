import { useCallback } from "react";
import { v4 as uuidv4 } from "uuid";
import type {
  RequestOfMethod,
  ResponseOfMethod,
} from "@traycer-clients/shared/host-transport/host-messenger";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type {
  AgentMode,
  TuiHarnessId,
} from "@traycer/protocol/persistence/epic/schemas";
import type {
  WorktreeBindingWorkspaceMode,
  WorktreeIntent,
} from "@traycer/protocol/host/worktree-schemas";
import { useEpicCreateTuiAgentForClient } from "@/hooks/epic/use-epic-tui-agent-mutations";
import { useAgentStartTerminalSession } from "@/hooks/agent/use-prepare-tui-launch-mutation";
import { useWorktreeCreateForClient } from "@/hooks/worktree/use-worktree-create-mutation";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { type HostRpcRegistry, useHostClient } from "@/lib/host";
import { tuiAgentDisplayTitle } from "@/lib/display-title";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  clearPreparedTerminalAgentLaunch,
  stashPreparedTerminalAgentLaunch,
} from "@/stores/terminals/prepared-terminal-agent-launch-store";

const TUI_AGENT_PROJECTION_WAIT_MS = 30_000;

/**
 * Resolves once the tui-agent record has projected into the epic store (or after
 * a bounded wait). Creation holds the canvas pending-create mark until this
 * resolves so the close-tile reconcile in `use-epic-route-synchronization` never
 * sees the just-opened tab as neither-pending-nor-live - the race where
 * `epic.createTuiAgent` resolves on the RPC channel BEFORE its Y.Doc update
 * streams back and projects, and the reconcile closes the tab in that window.
 * Mirrors the chat path's `openCreatedChatWhenProjected`.
 */
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

/**
 * Composite mutation that:
 *   1. mints a client-side `tuiAgentId` so the same id can be used
 *      everywhere (binding row, agent.tui.prepareLaunch, persisted
 *      record),
 *   2. opens a canvas tab placeholder for the client-minted id BEFORE
 *      worktree creation and `agent.tui.prepareLaunch` for normal launches so
 *      the user has a visible tui-agent surface inside the Epic while the
 *      resolver awaits orchestrator setup. Fork launches intentionally wait
 *      until `agent.tui.prepareLaunch` returns the new forked session so the
 *      tab opens on the forked session rather than a pre-fork placeholder.
 *      The tile renders "Loading terminal agent…" until the persisted record
 *      lands (or the user closes the tab), so a long-running / failed /
 *      cancelled setup cannot strand the user without a placeholder/recovery
 *      surface in the Epic context.
 *   3. for Worktree-mode launches, dispatches the matching `worktree.*`
 *      RPC so the host SQLite binding row exists before the harness
 *      preparation reads it,
 *   4. prepares a tui-agent session via `agent.tui.prepareLaunch`
 *      which seeds a default owner-scoped binding from the epic's folders
 *      when none was dispatched in step 3 (the always-non-empty seam),
 *      rejects with `WORKTREE_MISSING` if a bound folder is gone on disk
 *      (no silent demote), and awaits orchestrator setup,
 *   5. inserts a tui-agent record via `epic.createTuiAgent`
 *      with the client-minted id (the Y.Doc projection swaps the
 *      placeholder out for the real record).
 *
 * Errors from any step propagate; the underlying TanStack Query mutations'
 * default toasts surface user-facing messaging. Setup failure / cancellation
 * (`WORKTREE_SETUP_FAILED` / `WORKTREE_SETUP_CANCELLED`) and a missing bound
 * folder (`WORKTREE_MISSING`) surface as typed errors from
 * `agent.tui.prepareLaunch`; when any fires the harness never starts and the
 * persisted record is never written. Normal launches keep the placeholder
 * canvas tab visible as the durable recovery surface alongside the setup
 * terminal tab plus the typed error (and, for `WORKTREE_MISSING`, the
 * tui-agent tile's own restore/retry body). Fork launches do not open the
 * placeholder until the forked session is ready.
 *
 * Orphan-binding boundary (be precise — these two paths differ):
 *   - DEFAULT (null intent): no binding is written until prepareLaunch's seam
 *     runs, and the resolver preflights the missing-check BEFORE that seam write,
 *     so a rejected default-seed launch persists NO binding row. Orphan-safe.
 *   - EXPLICIT intent: step 3's `worktree.create` persists the binding BEFORE
 *     prepareLaunch, so a setup failure / cancel after that write leaves a
 *     binding row for an owner id that never gets a record. This orphan window is
 *     inherent to this deliberately non-atomic 3-step flow (kept for the
 *     placeholder-during-setup UX; a single atomic create RPC would close it) and
 *     is PRE-EXISTING, not introduced by the missing-worktree work. The retained
 *     background audit (`workspaceBinding.removeEntry`) does not reap it; closing
 *     it is a separate atomic-create / orphan-reaper follow-up.
 */
/**
 * Where the create flow opens the agent's placeholder tile.
 *
 * - `active-tile`: today's behavior - opens into the active group via
 *   `openTileInTab` (dedup-aware).
 * - `target-group`: opener path - drops a fresh instance into the explicit
 *   `groupId` via `openTileInPane` (no dedup / no active-group resolution).
 */
export type TuiAgentPlacement =
  | { readonly kind: "active-tile" }
  | { readonly kind: "target-group"; readonly groupId: string };

export type CreateTuiAgentStatus =
  "preparing-workspace" | "forking-session" | "starting-terminal";

export interface CreateTuiAgentInput {
  readonly epicId: string;
  readonly tabId: string;
  readonly parentId: string | null;
  readonly title: string;
  /** Explicit placement for the placeholder tile (no implicit default). */
  readonly placement: TuiAgentPlacement;
  readonly harnessId: TuiHarnessId;
  readonly model: string | null;
  readonly reasoningEffort: string | null;
  readonly agentMode: AgentMode;
  readonly forkSourceHarnessSessionId: string | null;
  readonly onStatusChange: ((status: CreateTuiAgentStatus) => void) | null;
  /**
   * Optional worktree binding intent. `null` means no explicit worktree
   * decision was captured (the default-Local flow): the create path skips the
   * binding RPC, and `agent.tui.prepareLaunch`'s host seam seeds a default
   * owner-scoped Local binding from the epic's folders (the always-non-empty
   * invariant) - so the agent still runs in a real, owner-scoped folder set,
   * never a sibling-leaking fallback. When non-null the create path dispatches
   * the matching `worktree.*` RPC against the new agent's id BEFORE preparing
   * the harness so the explicit binding exists before the resolver reads it.
   */
  readonly worktreeIntent: WorktreeIntent | null;
  readonly workspaceMode: WorktreeBindingWorkspaceMode;
  /**
   * Launch-time CLI args for this terminal agent. A string (pre-filled from the
   * provider's Settings default in the picker, editable per launch) is the
   * explicit override forwarded to `agent.tui.prepareLaunch`; `null` means "no
   * override - use the provider's saved Settings default" (surfaces without an
   * args field, e.g. the in-epic launcher, pass `null`). Not persisted on the
   * record, so a later reopen falls back to the current Settings default.
   */
  readonly terminalAgentArgs: string | null;
}

export function useCreateTuiAgent(): {
  readonly create: (input: CreateTuiAgentInput) => Promise<string | null>;
  readonly isPending: boolean;
} {
  const hostClient = useHostClient();
  // Placeholder tile is opened before `agent.tui.prepareLaunch` resolves,
  // so the bound host id is not yet known. Stamp the renderer's current
  // default; once the projection lands, the per-tile binding rides on the
  // `TuiAgentProjection.hostId` rather than this placeholder value.
  const placeholderHostId =
    useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
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
  const worktreeCreate = useWorktreeCreateForClient(hostClient);
  const openTileInTab = useEpicCanvasStore((s) => s.openTileInTab);
  const openTileInPane = useEpicCanvasStore((s) => s.openTileInPane);
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

      // Object holder, not a bare `let`: `opened` is flipped inside the
      // `openPlaceholder` closure, and a closure-mutated `let` narrows to its
      // `false` initializer at the `finally` check (no-unnecessary-condition
      // would flag it always-false). An object property reflects the mutation.
      const placeholder = { opened: false };
      const openPlaceholder = (): void => {
        // Open the canvas tab placeholder BEFORE normal
        // `agent.tui.prepareLaunch` waits so the user has a visible
        // tui-agent surface inside the Epic for the entire setup wait -
        // including a setup that fails or cancels. Fork creates are the
        // exception: the source session must be forked first, then the new
        // terminal session is opened against the forked session id.
        //
        // Mark the id as pending-create around the open so the
        // record→canvas sync effect in `use-epic-route-synchronization`
        // doesn't immediately close the placeholder for lacking a
        // projected record (mirrors `use-initial-chat-handoff`'s
        // mark/unmark pattern).
        markArtifactPendingCreate(tuiAgentId);
        placeholder.opened = true;
        const placeholderRef = {
          id: tuiAgentId,
          instanceId: uuidv4(),
          type: "terminal-agent" as const,
          name: tuiAgentDisplayTitle({
            title: input.title,
            harnessId: input.harnessId,
          }),
          hostId: placeholderHostId,
          pendingTuiHarnessId: input.harnessId,
        };
        if (input.placement.kind === "target-group") {
          openTileInPane(input.tabId, input.placement.groupId, placeholderRef);
        } else {
          openTileInTab(input.tabId, placeholderRef);
        }
      };

      let clearStashedPreparedLaunch = false;
      try {
        if (!opensAfterSessionPrepared) {
          openPlaceholder();
        }
        // For an explicit intent (a worktree, or a specific Local folder set),
        // the worktree binding RPC is dispatched BEFORE harness preparation so
        // `agent.tui.prepareLaunch` reads the user's *intended* binding row -
        // and, for Worktree mode, so the worktree directory is created and its
        // setup awaited. Skipping it would leave no binding at prepareLaunch, so
        // the seam there would seed a *default* Local binding from the epic's
        // folders, silently discarding the explicit choice. (A null intent has
        // nothing to dispatch; the seam's default seeding is the intended path.)
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
        // Resolver reads the binding for `tuiAgentId` and awaits the
        // per-owner setup awaiter. Setup failure / cancellation rejects
        // here with a typed error before any harness work happens - the
        // catch chain below ensures `epic.createTuiAgent` is never
        // invoked on that path. For normal launches, the placeholder canvas
        // tab opened above remains visible alongside the host-opened setup
        // terminal tab and the mutation hook's error toast. Fork launches
        // intentionally have no placeholder yet while the source session is
        // being forked.
        const session = await startSession.mutateAsync({
          harnessId: input.harnessId,
          epicId: input.epicId,
          model: input.model,
          reasoningEffort: input.reasoningEffort,
          agentMode: input.agentMode,
          tuiAgentId,
          harnessSessionId: null,
          forkSourceHarnessSessionId: input.forkSourceHarnessSessionId,
          terminalAgentArgs: input.terminalAgentArgs,
          workspaceMode: input.workspaceMode,
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
          agentMode: input.agentMode,
          tuiAgentId,
        });
        // Hold the pending-create mark until the record actually projects, so
        // the close-tile reconcile can't close the optimistic tab in the window
        // between this RPC resolving and its Y.Doc update streaming back. On the
        // error paths above the record is never created, so `finally` unmarks
        // immediately and the reconcile closes the orphan placeholder tab.
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
      openTileInTab,
      openTileInPane,
      markArtifactPendingCreate,
      unmarkArtifactPendingCreate,
      placeholderHostId,
      worktreeCreate,
    ],
  );

  return {
    create,
    isPending:
      startSession.isPending ||
      createTuiAgent.isPending ||
      worktreeCreate.isPending,
  };
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
  // A mode-only intent with no entries needs no binding write: prepare-launch's
  // host seam seeds the default owner-scoped Local binding from the epic's
  // folders when it finds no row (the always-non-empty invariant), so there is
  // nothing to dispatch here.
  if (intent.entries.length === 0) return;
  // Send the full union in ONE `worktree.create` call and let the host's
  // `resolveIntent` route each entry by `kind` (local / import / worktree)
  // into a single sibling-preserving binding write. One call keeps entry
  // routing and binding composition owned by `resolveIntent` instead of
  // re-deriving them client-side across separate create / import / setEntryMode
  // RPCs.
  await args.worktreeCreate({
    epicId,
    ownerId: tuiAgentId,
    ownerKind: "terminal-agent",
    entries: [...intent.entries],
  });
}
