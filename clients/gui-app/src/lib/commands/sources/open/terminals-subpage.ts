/**
 * Opener "Terminals" sub-page: pinned "New terminal" drills into a folder
 * picker, then existing terminals from `useTerminalList`.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import type { WorktreeBindingSelectorRow } from "@traycer/protocol/host";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { useWorktreeListBindingsForEpic } from "@/hooks/worktree/use-worktree-list-bindings-for-epic-query";
import { useHostClient } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { formatGitWorktreeLabel } from "@/lib/git/worktree-label";
import { isVisibleRawTerminalSession } from "@/lib/terminals/terminal-session-filters";
import {
  DEFAULT_TERMINAL_TITLE,
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

function noTerminalDirectoriesItem(): CommandItem {
  return {
    id: "open:terminals:new:no-directories",
    label: "No directories available",
    description: "Open a workspace in the epic first.",
    keywords: [],
    group: "open",
    scope: "actions",
    shortcut: null,
    actionId: null,
    subpage: null,
    run: () => undefined,
  };
}

function terminalFolderItem(
  ctx: CommandContext,
  row: WorktreeBindingSelectorRow,
  secondaryLabel: string,
): CommandItem {
  const label = formatGitWorktreeLabel(row);
  return openerActionLeaf({
    id: `open:terminals:new:${row.hostId}:${encodeURIComponent(
      row.runningDir,
    )}`,
    label,
    keywords: [label, secondaryLabel, row.runningDir],
    run: () => {
      if (ctx.activeTabId === null || ctx.targetGroupId === null) return;
      openTileIntoTargetGroup({
        tabId: ctx.activeTabId,
        groupId: ctx.targetGroupId,
        ref: {
          id: `term-${uuidv4()}`,
          instanceId: uuidv4(),
          type: "terminal",
          name: DEFAULT_TERMINAL_TITLE,
          titleSource: "default",
          hostId: row.hostId,
          cwd: row.runningDir,
        },
      });
    },
  });
}

function useNewTerminalFolderItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const bindingsQuery = useWorktreeListBindingsForEpic({
    epicId: ctx.activeEpicId ?? "",
    enabled: ctx.activeEpicId !== null,
  });
  const rows = useMemo(
    () =>
      bindingsQuery.data?.rows.filter((row) => row.disabledReason === null) ??
      [],
    [bindingsQuery.data?.rows],
  );
  return useMemo<ReadonlyArray<CommandItem>>(() => {
    if (bindingsQuery.isPending) return [];
    if (rows.length === 0) return [noTerminalDirectoriesItem()];
    return rows.map((row) => terminalFolderItem(ctx, row, row.runningDir));
  }, [bindingsQuery.isPending, ctx, rows]);
}

const NEW_TERMINAL_SUBPAGE: CommandSubpage = {
  id: "open:terminals:new",
  title: "Select directory to launch terminal in",
  useItems: useNewTerminalFolderItems,
};

export function useTerminalsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const defaultHostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const hostClient = useHostClient();
  const terminals = useTerminalList(ctx.activeEpicId ?? "", hostClient);
  const sessionsData = terminals.data;

  return useMemo<ReadonlyArray<CommandItem>>(() => {
    // `terminal.list` also returns `terminal-agent` backing PTYs; those belong
    // to the "TUI agents" category, so filter to raw terminals only (shared
    // predicate with the sidebar) - otherwise an agent double-lists here as a
    // plain terminal and, worse, opens as a raw terminal tile on its PTY.
    const sessions = (sessionsData?.sessions ?? []).filter(
      isVisibleRawTerminalSession,
    );
    const newTerminal = openerSubpageLeaf({
      id: "open:terminals:new",
      label: "Create new terminal",
      keywords: ["new", "terminal", "shell"],
      subpage: NEW_TERMINAL_SUBPAGE,
    });
    const existing = sessions.map((session) =>
      openerExistingLeaf("terminals", ctx, {
        id: session.sessionId,
        instanceId: uuidv4(),
        type: "terminal",
        name: terminalSessionTitle({
          title: session.title,
          activeProcessName: session.activeProcessName,
        }),
        titleSource: deriveTitleSourceFromSessionTitle(session.title),
        hostId: defaultHostId,
        // Recorded so an eviction-recreate lands back in the session's
        // directory - same as the sidebar's open-existing path.
        cwd: session.cwd,
      }),
    );
    return [newTerminal, ...existing];
  }, [ctx, sessionsData, defaultHostId]);
}
