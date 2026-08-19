import { useCallback } from "react";
import { Terminal } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  SwitcherListEmpty,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import { SwitcherNewTerminalRow } from "@/components/epic-canvas/mobile/switcher-create-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useEpicSessionHostClient } from "@/hooks/epic/use-epic-session-host-client";
import { useEpicSessionHostId } from "@/hooks/epic/use-epic-session-host-id";
import { useTerminalList } from "@/hooks/terminal/use-terminal-list-query";
import { isVisibleEpicTerminalSession } from "@/lib/terminals/terminal-session-filters";
import {
  deriveTitleSourceFromSessionTitle,
  terminalSessionTitle,
} from "@/lib/terminals/terminal-title";
import { useIsActiveEpicArtifact } from "@/stores/epics/canvas/canvas-selectors";

interface SwitcherListProps {
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Terminals category: raw PTY sessions from the host `terminal.list` query
 * (NOT the Y.Doc projection), filtered by the shared visibility rule. Sessions
 * on an unreachable host are still shown (decision); opening one lands on the
 * existing dead-tile handling.
 */
export function SwitcherTerminalsList(props: SwitcherListProps) {
  const { epicId, tabId, onClose } = props;
  // The Epic SESSION's client, never the ambient one: during a re-point the
  // window can address host B while this canvas still projects host A's Epic,
  // and an ambient read would list (and mutate) B's terminals under A's rows -
  // the same defect the desktop sidebar fixed (see epic-terminal-sidebar).
  const hostClient = useEpicSessionHostClient();
  const list = useTerminalList({ kind: "epic", epicId }, hostClient);
  const sessions = (list.data?.sessions ?? []).filter((session) =>
    isVisibleEpicTerminalSession(session, epicId),
  );

  const canMutate = isEditableRole(useEpicPermissionRole());

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto overscroll-contain p-1 pb-safe-bottom">
      {/* Editor-gated: a viewer's create is server-rejected, so an ungated row
          would only lead to a dead end. Inside the scroll region and above the
          items, so it is the first thing in the list either way. */}
      {canMutate ? (
        <SwitcherNewTerminalRow
          epicId={epicId}
          tabId={tabId}
          onClose={onClose}
        />
      ) : null}
      {sessions.length === 0 ? (
        <SwitcherListEmpty message="No terminals yet." />
      ) : (
        sessions.map((session) => (
          <SwitcherTerminalRow
            key={session.sessionId}
            session={session}
            epicId={epicId}
            tabId={tabId}
            onClose={onClose}
          />
        ))
      )}
    </div>
  );
}

function SwitcherTerminalRow(props: {
  readonly session: CanonicalTerminalSessionInfo;
  readonly epicId: string;
  readonly tabId: string;
  readonly onClose: () => void;
}) {
  const { session, epicId, tabId, onClose } = props;
  const activate = useSwitcherActivate(epicId, tabId, onClose);
  const isActive = useIsActiveEpicArtifact(tabId, session.sessionId);
  const hostId = useEpicSessionHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
  const label = terminalSessionTitle({
    title: session.title,
    activeProcessName: session.activeProcessName,
    currentCwd: session.cwd,
  });

  const onSelect = useCallback(() => {
    activate(session.sessionId, () => ({
      id: session.sessionId,
      instanceId: uuidv4(),
      type: "terminal",
      name: terminalSessionTitle({
        title: session.title,
        activeProcessName: session.activeProcessName,
        currentCwd: session.cwd,
      }),
      titleSource: deriveTitleSourceFromSessionTitle(session.title),
      hostId,
      cwd: session.cwd,
    }));
  }, [activate, hostId, session]);

  return (
    <SwitcherListRow
      icon={<Terminal className="size-4 shrink-0 text-muted-foreground" />}
      label={label}
      active={isActive}
      onSelect={onSelect}
      selectTestId={`switcher-terminal-row-${session.sessionId}`}
      actions={
        <SwitcherRowActions
          epicId={epicId}
          tabId={tabId}
          kind="terminal"
          nodeId={session.sessionId}
          name={label}
          cascadeSummary={null}
        />
      }
    />
  );
}
