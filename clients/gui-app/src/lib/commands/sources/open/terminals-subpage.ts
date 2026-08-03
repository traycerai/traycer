/**
 * Opener "Terminals" sub-page: pinned "Create new terminal" (which drills into
 * workspace selection without leaving cmdk), then existing terminals from
 * `useTerminalList`.
 *
 * The active host's workspaces are shown directly. Other available hosts are
 * nested sub-pages backed by transient clients, so cross-host creation remains
 * possible without changing the app-wide active host or opening a modal.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { WorktreeBindingSelectorRowV12 } from "@traycer/protocol/host";
import { buildTerminalTileRef } from "@/components/epic-canvas/sidebar/new-terminal-tile-ref";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import {
  useWorktreeListBindingsForEpic,
  useWorktreeListBindingsForEpicForClient,
} from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useHostBinding, useHostClient } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import { withoutResolvedMissingRows } from "@/lib/worktree/worktree-row-resolved-missing";
import { providerLoginTerminalProviderId } from "@/stores/providers/provider-login-terminals";
import {
  deriveTitleSourceFromSessionTitle,
  terminalSessionTitle,
} from "@/lib/terminals/terminal-title";
import {
  openerActionLeaf,
  openerExistingLeaf,
  openerSubpageLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import type {
  CommandContext,
  CommandItem,
  CommandSubpage,
} from "@/lib/commands/types";

function terminalWorkspaceLeaf(
  ctx: CommandContext,
  target: { readonly hostId: string; readonly cwd: string },
  label: string,
): CommandItem {
  return openerActionLeaf({
    id: `open:terminals:new:${target.hostId}:${encodeURIComponent(target.cwd)}`,
    label,
    keywords: [target.cwd, "new", "terminal", "workspace"],
    run: () =>
      openTileIntoTargetGroup({
        tabId: ctx.activeTabId,
        groupId: ctx.targetGroupId,
        ref: buildTerminalTileRef(target),
        navigateNestedFocus: ctx.router.navigateNestedFocus,
      }),
  });
}

function terminalWorkspaceLeaves(
  ctx: CommandContext,
  hostId: string,
  rows: ReadonlyArray<WorktreeBindingSelectorRowV12>,
  folderlessCwd: string | null,
): ReadonlyArray<CommandItem> {
  const visibleRows = withoutResolvedMissingRows(
    rows.filter((row) => row.hostId === hostId),
    null,
  );
  const selectableRows = visibleRows.filter(
    (row) => row.disabledReason === null,
  );
  if (selectableRows.length > 0) {
    return selectableRows.map((row) =>
      terminalWorkspaceLeaf(
        ctx,
        { hostId: row.hostId, cwd: row.runningDir },
        row.runningDir,
      ),
    );
  }
  // Match the sidebar picker: the host-owned fallback cwd is valid only when
  // the Epic truly has no binding rows. Disabled bindings do not silently
  // degrade to an unrelated default directory.
  if (visibleRows.length === 0 && folderlessCwd !== null) {
    return [
      terminalWorkspaceLeaf(ctx, { hostId, cwd: folderlessCwd }, folderlessCwd),
    ];
  }
  return [];
}

function useHostTerminalWorkspaceItems(
  ctx: CommandContext,
  hostId: string,
): ReadonlyArray<CommandItem> {
  const client = useHostClientForHostId(hostId);
  const bindings = useWorktreeListBindingsForEpicForClient({
    client,
    epicId: ctx.activeEpicId ?? "",
    enabled: ctx.activeEpicId !== null,
  });
  return useMemo(
    () =>
      terminalWorkspaceLeaves(
        ctx,
        hostId,
        bindings.data?.rows ?? [],
        bindings.data?.folderlessCwd ?? null,
      ),
    [ctx, hostId, bindings.data],
  );
}

function makeHostWorkspaceSubpage(
  hostId: string,
  hostLabel: string,
): CommandSubpage {
  return {
    id: `open:terminals:new:host:${hostId}`,
    title: `Create terminal on ${hostLabel}`,
    useItems: (ctx) => useHostTerminalWorkspaceItems(ctx, hostId),
  };
}

function useNewTerminalWorkspaceItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const activeHostId = useReactiveActiveHostId();
  const bindings = useWorktreeListBindingsForEpic({
    epicId: ctx.activeEpicId ?? "",
    enabled: ctx.activeEpicId !== null,
  });
  const binding = useHostBinding();
  // Command subpages mount only when selected, so this refresh gives the
  // workspace chooser the same freshly-reachable host list as the old dialog.
  useRefreshHostDirectoryOnOpen(true, binding?.directory ?? null);
  const directory = useHostDirectoryList();
  return useMemo(() => {
    if (activeHostId === null) return [];
    const localLeaves = terminalWorkspaceLeaves(
      ctx,
      activeHostId,
      bindings.data?.rows ?? [],
      bindings.data?.folderlessCwd ?? null,
    );
    const otherHosts = (directory.data ?? [])
      .filter(
        (entry) =>
          entry.hostId !== activeHostId &&
          entry.status === "available" &&
          entry.websocketUrl !== null,
      )
      .map((entry) => {
        const label = entry.label.length > 0 ? entry.label : entry.hostId;
        return openerSubpageLeaf({
          id: `open:terminals:new:host:${entry.hostId}`,
          label,
          keywords: [entry.hostId, label, "host", "computer", "machine"],
          subpage: makeHostWorkspaceSubpage(entry.hostId, label),
        });
      });
    return [...localLeaves, ...otherHosts];
  }, [activeHostId, bindings.data, ctx, directory.data]);
}

const NEW_TERMINAL_WORKSPACE_SUBPAGE: CommandSubpage = {
  id: "open:terminals:new:workspace",
  title: "Create terminal in workspace",
  useItems: useNewTerminalWorkspaceItems,
};

export function useTerminalsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const defaultHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const hostClient = useHostClient();
  const scope = { kind: "epic" as const, epicId: ctx.activeEpicId ?? "" };
  const terminals = useTerminalList(scope, hostClient);
  const sessionsData = terminals.data;

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    // `terminal.list` also returns `terminal-agent` backing PTYs; those belong
    // to the "TUI agents" category, so filter to raw terminals only (shared
    // predicate with the sidebar) - otherwise an agent double-lists here as a
    // plain terminal and, worse, opens as a raw terminal tile on its PTY.
    const sessions = (sessionsData?.sessions ?? []).filter((session) =>
      isVisibleEpicTerminalSession(session, scope.epicId),
    );
    const newTerminal = openerSubpageLeaf({
      id: "open:terminals:new",
      label: "Create new terminal",
      keywords: ["new", "terminal", "shell"],
      subpage: NEW_TERMINAL_WORKSPACE_SUBPAGE,
    });
    const existing = sessions.map((session) => {
      // A host-created sign-in terminal must carry its origin here too, or the
      // eviction-recreate below - correct for an ordinary shell - spawns a bare
      // prompt under the sign-in session's id and label. `terminal.list` cannot
      // tell us; the renderer's record of host-created sign-in terminals can.
      const signInProviderId = providerLoginTerminalProviderId(
        defaultHostId,
        session.sessionId,
      );
      return openerExistingLeaf(
        "terminals",
        ctx,
        {
          id: session.sessionId,
          instanceId: uuidv4(),
          type: "terminal",
          name: terminalSessionTitle({
            title: session.title,
            activeProcessName: session.activeProcessName,
            currentCwd: session.currentCwd,
          }),
          titleSource: deriveTitleSourceFromSessionTitle(session.title),
          hostId: defaultHostId,
          // Recorded so an eviction-recreate lands back in the session's
          // directory - same as the sidebar's open-existing path.
          cwd: session.cwd,
          ...(signInProviderId === null
            ? {}
            : {
                origin: "provider-login" as const,
                originProviderId: signInProviderId,
              }),
        },
        // `terminal.list` is always issued against the active host's client
        // (`useHostClient()` above) - there is no cross-host terminal listing
        // today, so every session here IS already on `defaultHostId`. A badge
        // can never legitimately apply until that plumbing exists (flagged
        // back per T22's scope - inventing it is a separate, larger change).
        null,
      );
    });
    return [newTerminal, ...existing];
  }, [ctx, defaultHostId, scope.epicId, sessionsData]);
}
