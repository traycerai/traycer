import { useCallback, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { HostStatusSessions } from "@traycer/protocol/host/status/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { routeNotificationForHost } from "@/lib/notifications";
import {
  sandboxAgentSessionName,
  type SandboxSessionPill,
} from "@/lib/sandboxes/sandbox-row-lines";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicCanvasTileRef } from "@/stores/epics/canvas/types";

/** One session beside the sessions line, with the live dot while it works. */
export function SandboxSessionPillBadge(props: {
  readonly pill: SandboxSessionPill;
  readonly testId: string;
}): ReactNode {
  return (
    <Badge size="xs" variant="muted" data-testid={props.testId}>
      {props.pill.working ? (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full bg-success"
        />
      ) : null}
      {props.pill.label}
    </Badge>
  );
}

interface ReportedSession {
  readonly key: string;
  readonly name: string;
  readonly taskId: string | null;
  readonly sessionId: string;
  readonly kind: "chat" | "terminal-agent" | "terminal";
}

/**
 * The named sessions in the host's own list, each a link to it: a chat opens
 * its task, a terminal or terminal agent the tile open on it in this window.
 * A chat in another member's task has no name and is not listed; the count
 * and the pills hold it. A terminal agent not renamed is `Terminal agent`.
 */
export function HostReportedSessionsList(props: {
  readonly hostId: string;
  readonly sessions: HostStatusSessions;
  readonly onNavigate: () => void;
}): ReactNode {
  const named: ReportedSession[] = [
    ...props.sessions.agents.flatMap((agent): ReportedSession[] => {
      const name = sandboxAgentSessionName(agent);
      return name === null
        ? []
        : [
            {
              key: `agent:${agent.sessionId}`,
              name,
              taskId: agent.taskId,
              sessionId: agent.sessionId,
              kind: agent.kind,
            },
          ];
    }),
    ...props.sessions.terminals.flatMap((terminal): ReportedSession[] =>
      terminal.name === null
        ? []
        : [
            {
              key: `terminal:${terminal.sessionId}`,
              name: terminal.name,
              taskId: terminal.taskId,
              sessionId: terminal.sessionId,
              kind: "terminal",
            },
          ],
    ),
  ];
  return (
    <ul
      className="mt-1 max-h-[30vh] list-none space-y-1 overflow-y-auto p-0"
      data-testid="known-host-sessions"
    >
      {named.map((session) => (
        <ReportedSessionItem
          key={session.key}
          session={session}
          hostId={props.hostId}
          onNavigate={props.onNavigate}
        />
      ))}
    </ul>
  );
}

function ReportedSessionItem(props: {
  readonly session: ReportedSession;
  readonly hostId: string;
  readonly onNavigate: () => void;
}): ReactNode {
  const { session, hostId, onNavigate } = props;
  const navigate = useNavigate();
  const { openTile } = useEpicTileNavigation();
  const tile = useOpenSessionTile(session, hostId);
  const open = useCallback((): void => {
    if (session.taskId === null) return;
    if (session.kind === "chat") {
      const routed = routeNotificationForHost(
        navigate,
        { kind: "chat", epicId: session.taskId, chatId: session.sessionId },
        Date.now(),
        { originHostId: hostId, effectiveHostId: hostId },
      );
      if (routed) onNavigate();
      return;
    }
    if (tile === null) return;
    const target = openTile(
      tileIntent(tile, { epicId: session.taskId }, "explicit", "direct_ui"),
    );
    if (target !== null) onNavigate();
  }, [session, hostId, navigate, onNavigate, openTile, tile]);
  const linkable =
    session.taskId !== null && (session.kind === "chat" || tile !== null);
  return (
    <li className="text-ui-sm wrap-anywhere">
      {linkable ? (
        <Button
          type="button"
          variant="link"
          size="inline"
          className="max-w-full justify-start whitespace-normal text-left wrap-anywhere"
          onClick={open}
        >
          {session.name}
        </Button>
      ) : (
        session.name
      )}
    </li>
  );
}

/** The tile open in this window on a terminal or terminal-agent session. */
function useOpenSessionTile(
  session: ReportedSession,
  hostId: string,
): EpicCanvasTileRef | null {
  const canvases = useEpicCanvasStore((state) => state.canvasByTabId);
  const tabsById = useEpicCanvasStore((state) => state.tabsById);
  if (session.kind === "chat" || session.taskId === null) return null;
  const type = session.kind === "terminal" ? "terminal" : "terminal-agent";
  const tile = Object.entries(canvases)
    .filter(([tabId]) => tabsById[tabId]?.epicId === session.taskId)
    .flatMap(([, canvas]) =>
      canvas === undefined ? [] : Object.values(canvas.tilesByInstanceId),
    )
    .find(
      (candidate) =>
        candidate?.type === type &&
        candidate.id === session.sessionId &&
        candidate.hostId === hostId,
    );
  return tile ?? null;
}
