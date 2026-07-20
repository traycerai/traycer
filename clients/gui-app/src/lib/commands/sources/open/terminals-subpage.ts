/**
 * Opener "Terminals" sub-page: pinned "Create new terminal" (opens the
 * `NewTerminalDialogHost` dialog for a host+folder pick, same as the sidebar
 * "+" popover - see `new-terminal-dialog.tsx`), then existing terminals from
 * `useTerminalList`.
 */
import { useMemo } from "react";
import { v4 as uuidv4 } from "uuid";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { useHostClient } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import {
  deriveTitleSourceFromSessionTitle,
  terminalSessionTitle,
} from "@/lib/terminals/terminal-title";
import {
  openerActionLeaf,
  openerExistingLeaf,
} from "@/lib/commands/sources/open/open-leaf";
import { useNewTerminalModalOpenStore } from "@/stores/epics/new-terminal-modal-open-store";
import type { CommandContext, CommandItem } from "@/lib/commands/types";

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
    const newTerminal = openerActionLeaf({
      id: "open:terminals:new",
      label: "Create new terminal",
      keywords: ["new", "terminal", "shell"],
      run: () => {
        if (ctx.activeEpicId === null || ctx.activeTabId === null) return;
        if (ctx.targetGroupId === null) return;
        useNewTerminalModalOpenStore.getState().open({
          epicId: ctx.activeEpicId,
          tabId: ctx.activeTabId,
          groupId: ctx.targetGroupId,
        });
      },
    });
    const existing = sessions.map((session) =>
      openerExistingLeaf(
        "terminals",
        ctx,
        {
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
        },
        // `terminal.list` is always issued against the active host's client
        // (`useHostClient()` above) - there is no cross-host terminal listing
        // today, so every session here IS already on `defaultHostId`. A badge
        // can never legitimately apply until that plumbing exists (flagged
        // back per T22's scope - inventing it is a separate, larger change).
        null,
      ),
    );
    return [newTerminal, ...existing];
  }, [ctx, defaultHostId, scope.epicId, sessionsData]);
}
