import type { ListedTerminalSidebarSession } from "@/lib/terminals/reconcile-terminal-sidebar-sessions";
import {
  deriveTitleSourceFromSessionTitle,
  terminalSessionLabel,
} from "@/lib/terminals/terminal-title";
import { providerLoginTerminalProviderId } from "@/stores/providers/provider-login-terminals";
import { existingSessionOriginFields } from "@/stores/epics/canvas/types";
import type { EpicTerminalRef } from "@/stores/epics/canvas/types";
import { isSetupTerminal } from "@/stores/worktree/setup-terminals";

/**
 * Builds a canvas presentation from a `terminal.list` row (and the durable
 * fleet projection when the sidebar already classified the row as host
 * authority). Wire `lifecycleOwner` is copied onto the ref so import and
 * bootstrap stay manager-owned without renderer origin caches. Setup and
 * provider-login stores remain optional enrichment only.
 */
export function makeListedEpicTerminalRef(args: {
  readonly session: ListedTerminalSidebarSession;
  readonly hostId: string;
  readonly instanceId: string;
  readonly durable: boolean;
}): EpicTerminalRef {
  const name = terminalSessionLabel(args.session);
  const titleSource = deriveTitleSourceFromSessionTitle(args.session.title);
  if (args.durable) {
    return {
      id: args.session.sessionId,
      instanceId: args.instanceId,
      type: "terminal",
      name,
      hostId: args.hostId,
      authority: "host",
      legacyFallback: {
        name,
        titleSource,
        cwd: args.session.cwd,
      },
      ...(args.session.lifecycleOwner === undefined
        ? {}
        : { lifecycleOwner: args.session.lifecycleOwner }),
    };
  }
  const signInProviderId = providerLoginTerminalProviderId(
    args.hostId,
    args.session.sessionId,
  );
  const setupSession = isSetupTerminal(args.hostId, args.session.sessionId);
  return {
    id: args.session.sessionId,
    instanceId: args.instanceId,
    type: "terminal",
    name,
    titleSource,
    hostId: args.hostId,
    cwd: args.session.cwd,
    ...(args.session.lifecycleOwner === undefined
      ? {}
      : { lifecycleOwner: args.session.lifecycleOwner }),
    ...existingSessionOriginFields(signInProviderId, setupSession),
  };
}
