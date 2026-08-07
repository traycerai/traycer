import { useCallback } from "react";
import { Terminal } from "lucide-react";
import { v4 as uuidv4 } from "uuid";
import type { CanonicalTerminalSessionInfo } from "@traycer/protocol/host/terminal/unary-schemas";
import {
  SwitcherListEmpty,
  SwitcherListHeader,
  SwitcherListRow,
} from "@/components/epic-canvas/mobile/switcher-list-row";
import { SwitcherRowActions } from "@/components/epic-canvas/mobile/switcher-row-actions";
import { useSwitcherActivate } from "@/components/epic-canvas/mobile/use-switcher-activate";
import { NewTerminalPicker } from "@/components/epic-canvas/sidebar/new-terminal-picker";
import { useEpicPermissionRole } from "@/lib/epic-selectors";
import { isEditableRole } from "@/lib/epic-permissions";
import { useHostClient } from "@/lib/host";
import { UNKNOWN_HOST_PLACEHOLDER } from "@/lib/host/constants";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
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
  const hostClient = useHostClient();
  const list = useTerminalList({ kind: "epic", epicId }, hostClient);
  const sessions = (list.data?.sessions ?? []).filter((session) =>
    isVisibleEpicTerminalSession(session, epicId),
  );
  const canMutate = isEditableRole(useEpicPermissionRole());

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <SwitcherListHeader
        action={
          canMutate ? (
            // Reused as-is; `onLaunched` closes the sheet so the new terminal
            // lands as the visible tile (its own tile kind isn't embed-scoped).
            <NewTerminalPicker
              epicId={epicId}
              tabId={tabId}
              onBeforeOpen={undefined}
              onLaunched={onClose}
            />
          ) : null
        }
      />
      {sessions.length === 0 ? (
        <SwitcherListEmpty message="No terminals yet." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overscroll-contain p-1 pb-[env(safe-area-inset-bottom)]">
          {sessions.map((session) => (
            <SwitcherTerminalRow
              key={session.sessionId}
              session={session}
              epicId={epicId}
              tabId={tabId}
              onClose={onClose}
            />
          ))}
        </div>
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
  const hostId = useReactiveActiveHostId() ?? UNKNOWN_HOST_PLACEHOLDER;
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
