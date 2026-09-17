import { useCallback, useEffect, useState } from "react";
import { useStore } from "zustand";
import { useNavigate } from "@tanstack/react-router";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import { Button } from "@/components/ui/button";
import { useFocusModel } from "@/hooks/home-focus/use-focus-model";
import { routeNotificationForHost } from "@/lib/notifications";
import {
  getTerminalSessionHandleHostId,
  getTerminalSessionRegistry,
} from "@/lib/registries/terminal-session-registry";
import type { TerminalSessionStoreHandle } from "@/stores/terminals/terminal-session-store";

interface HostRestartSessionsProps {
  readonly hostId: string;
  readonly disabled: boolean;
  readonly onNavigate: () => void;
}

/** Inspection only: the host's cooperative restart remains the busy authority. */
export function HostRestartSessions(props: HostRestartSessionsProps) {
  const { hostId, onNavigate } = props;
  const model = useFocusModel();
  const navigate = useNavigate();
  const registry = getTerminalSessionRegistry();
  const [terminals, setTerminals] = useState(() => registry.listHandles());
  useEffect(() => {
    const update = () => setTerminals(registry.listHandles());
    const unsubscribe = registry.subscribe(update);
    update();
    return unsubscribe;
  }, [registry]);
  const agents = model.tasks.flatMap((task) =>
    task.agents
      .filter((agent) => agent.hostId === props.hostId)
      .map((agent) => ({ ...agent, epicId: task.epicId })),
  );
  const openSession = useCallback(
    (epicId: string, sessionId: string): void => {
      const routed = routeNotificationForHost(
        navigate,
        { kind: "chat", epicId, chatId: sessionId },
        Date.now(),
        { originHostId: hostId, effectiveHostId: hostId },
      );
      if (routed) onNavigate();
    },
    [navigate, hostId, onNavigate],
  );
  const seen = new Set<string>();
  const hostTerminals = terminals.flatMap((handle) => {
    if (
      getTerminalSessionHandleHostId(handle) !== props.hostId ||
      handle.scope.kind !== "epic"
    )
      return [];
    const key = JSON.stringify([handle.scope.epicId, handle.sessionId]);
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ handle, key }];
  });
  return (
    <section
      aria-label="Running sessions"
      className="min-w-0 border-t border-border/60 px-5 py-3"
    >
      <p className="text-ui-sm font-medium">Running sessions</p>
      <ul className="mt-1 max-h-[30vh] list-none space-y-1 overflow-y-auto p-0">
        {agents.map((agent) => (
          <li key={`${agent.epicId}:${agent.agentId}`}>
            <Button
              type="button"
              variant="link"
              size="inline"
              className="max-w-full justify-start whitespace-normal text-left wrap-anywhere"
              disabled={props.disabled}
              onClick={() => openSession(agent.epicId, agent.agentId)}
            >
              {agent.title ?? agent.agentId}
            </Button>
          </li>
        ))}
        {hostTerminals.map(({ handle, key }) => (
          <RunningTerminal
            key={key}
            handle={handle}
            disabled={props.disabled}
            hostId={props.hostId}
            onNavigate={props.onNavigate}
          />
        ))}
      </ul>
      <p className="mt-1 text-ui-xs text-muted-foreground">
        Known running agents and Task terminals open in this window. Other
        sessions may also be interrupted.
      </p>
    </section>
  );
}

function RunningTerminal(props: {
  readonly handle: TerminalSessionStoreHandle;
  readonly disabled: boolean;
  readonly hostId: string;
  readonly onNavigate: () => void;
}) {
  const { openTile } = useEpicTileNavigation();
  const canvases = useEpicCanvasStore((state) => state.canvasByTabId);
  const tabsById = useEpicCanvasStore((state) => state.tabsById);
  const status = useStore(props.handle.store, (state) => state.status);
  const kind = useStore(props.handle.store, (state) => state.kind);
  const title = useStore(props.handle.store, (state) => state.title);
  const scope = props.handle.scope;
  if (kind !== "terminal" || status !== "running" || scope.kind !== "epic") {
    return null;
  }
  const tile = Object.entries(canvases)
    .filter(([tabId]) => tabsById[tabId]?.epicId === scope.epicId)
    .flatMap(([, canvas]) =>
      canvas === undefined ? [] : Object.values(canvas.tilesByInstanceId),
    )
    .find(
      (candidate) =>
        candidate?.type === "terminal" &&
        candidate.id === props.handle.sessionId &&
        candidate.hostId === props.hostId,
    );
  if (tile === undefined) return null;
  return (
    <li>
      <Button
        type="button"
        variant="link"
        size="inline"
        className="max-w-full justify-start whitespace-normal text-left wrap-anywhere"
        disabled={props.disabled}
        onClick={() => {
          const target = openTile(
            tileIntent(tile, { epicId: scope.epicId }, "explicit", "direct_ui"),
          );
          if (target !== null) props.onNavigate();
        }}
      >
        {title ?? `Terminal ${props.handle.sessionId}`}
      </Button>
    </li>
  );
}
