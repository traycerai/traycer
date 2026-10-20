import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Smartphone, X } from "lucide-react";
import type {
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarSeparator,
} from "@/components/ui/sidebar";
import {
  revealSidebarNode,
  SIDEBAR_REVEAL_HIGHLIGHT_CLASS,
} from "@/components/epic-canvas/sidebar/epic-sidebar-tree-shared";
import { useOpenSimulatorTile } from "@/components/simulator-tile/use-open-simulator-tile";
import { useEpicTileNavigation } from "@/hooks/epic/use-epic-tile-navigation";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import {
  useSimulatorCloseMutation,
  useSimulatorConfigSetMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import {
  orderSimulators,
  simulatorHasSession,
} from "@/lib/simulator-view/simulator-sessions-coordinator";
import { simulatorVersionLabel } from "@/lib/simulator-view/simulator-labels";
import { useSimulatorInventoryRefreshOnMount } from "@/lib/simulator-view/use-simulator-inventory-refresh";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";
import { useIsActiveTile } from "@/stores/epics/canvas/store";
import { simulatorTileId } from "@/stores/epics/canvas/tile-schema/simulator-tile";
import {
  clearSidebarNodeRevealRequest,
  useSidebarNodeRevealRequest,
} from "@/stores/epics/sidebar-node-reveal-store";
import { cn } from "@/lib/utils";

/**
 * The Simulators group of the Browsers panel: the pinned host's simulators,
 * booted ones first, each a row that places its tile at once (the tile does
 * the connecting, and the booting when needed).
 *
 * It follows the panel's host pin, so what it lists is the same machine the
 * browser rows above it are on. A host that cannot run simulators gets no
 * group at all; one with them turned off gets the one line that can change
 * that. The explanations live in the tile and in Settings - this panel is
 * for what can be opened.
 *
 * A simulator the task holds a session on - opened by an agent's
 * `simulator_open`, by another window, or before a reload - is marked "Open",
 * the way the browser rows mark a tab an agent drives, and its row attaches a
 * tile to that session rather than opening a second one. Like a browser tab,
 * such a session is ended from the row, not by closing a tile that only
 * watched it.
 */
export function SimulatorsSidebarGroup(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
}) {
  const { epicId, tabId, hostId } = props;
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  // A fresh host lists nothing until something runs `simulator.list`.
  useSimulatorInventoryRefreshOnMount({ hostId, sessions });
  const { openTile } = useEpicTileNavigation();
  const { open, supported } = useOpenSimulatorTile({ hostId });

  const openSimulator = useCallback(
    (simulator: SimulatorSummary) => {
      open(simulator, (ref) => {
        openTile(tileIntent(ref, { tabId }, "explicit", "direct_ui"));
      });
    },
    [open, openTile, tabId],
  );

  const state = sessions.state;
  const simulators = useMemo(
    () => (state === null ? [] : orderSimulators(state.simulators)),
    [state],
  );

  // Nothing to say yet, or nothing this host can offer: no group at all,
  // rather than a heading over an explanation.
  if (hostId === null || sessions.lifecycle === "unsupported") return null;
  if (state === null) return null;
  if (state.platforms.every((platform) => !platform.available)) return null;

  return (
    <>
      <SidebarSeparator />
      <SidebarGroup className="shrink-0" data-testid="epic-simulators-group">
        <SidebarGroupLabel>Mobile simulators</SidebarGroupLabel>
        <SimulatorsGroupBody
          epicId={epicId}
          hostId={hostId}
          tabId={tabId}
          state={state}
          simulators={simulators}
          onOpen={supported ? openSimulator : null}
        />
      </SidebarGroup>
    </>
  );
}

function SimulatorsGroupBody(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly tabId: string;
  readonly state: SimulatorState;
  readonly simulators: readonly SimulatorSummary[];
  readonly onOpen: ((simulator: SimulatorSummary) => void) | null;
}) {
  const { state, simulators, tabId } = props;
  const listRef = useRef<HTMLUListElement>(null);
  const revealRequest = useSidebarNodeRevealRequest(tabId);
  useLayoutEffect(() => {
    if (revealRequest === null || listRef.current === null) return;
    if (
      !revealSidebarNode(
        listRef.current,
        revealRequest.nodeId,
        revealRequest.nonce,
      )
    ) {
      return;
    }
    clearSidebarNodeRevealRequest(tabId, revealRequest.nonce);
  }, [simulators, revealRequest, tabId]);
  if (state.packState.kind === "off") {
    return <SimulatorsOffRow hostId={props.hostId} />;
  }
  if (state.packState.kind === "installing") {
    return (
      <p
        className="flex items-center gap-2 px-2 pb-1 text-ui-xs text-muted-foreground"
        data-testid="epic-simulators-note"
      >
        <AgentSpinningDots
          className="shrink-0"
          testId={undefined}
          variant={undefined}
          tone="muted"
        />
        Setting up mobile simulators on this host…
      </p>
    );
  }
  if (state.packState.kind === "failed") {
    return (
      <SimulatorsNote text="Simulators couldn't be set up on this host." />
    );
  }
  if (props.simulators.length === 0) {
    return (
      <SimulatorsNote
        text={
          state.hubState.kind === "failed"
            ? "Mobile simulators stopped on this host."
            : "No mobile simulators on this host."
        }
      />
    );
  }
  return (
    <ul ref={listRef} aria-label="Mobile simulators" className="space-y-0.5">
      {props.simulators.map((simulator) => (
        <SimulatorRow
          key={simulator.simulatorId}
          epicId={props.epicId}
          hostId={props.hostId}
          viewTabId={props.tabId}
          simulator={simulator}
          busy={state.booting.includes(simulator.simulatorId)}
          open={simulatorHasSession(state, simulator.simulatorId)}
          onOpen={props.onOpen}
        />
      ))}
    </ul>
  );
}

function SimulatorsNote(props: { readonly text: string }) {
  return (
    <p
      className="px-2 pb-1 text-ui-xs text-muted-foreground"
      data-testid="epic-simulators-note"
    >
      {props.text}
    </p>
  );
}

/**
 * The switch's sidebar form: one button that turns mobile simulators on for
 * this host.
 */
function SimulatorsOffRow(props: { readonly hostId: string }) {
  const hostClient = useHostClientForHostId(props.hostId);
  const { mutation, supported } = useSimulatorConfigSetMutation(
    hostClient,
    props.hostId,
  );
  const { mutate, isPending } = mutation;
  return (
    <div
      className="flex items-center gap-2 px-2 pb-1 text-ui-xs text-muted-foreground"
      data-testid="epic-simulators-note"
    >
      <span className="min-w-0 flex-1">
        Mobile simulators are off on this host.
      </span>
      {supported ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={isPending}
          data-testid="epic-simulators-turn-on"
          onClick={() => mutate({ enabled: true })}
        >
          {isPending ? (
            <AgentSpinningDots
              className={undefined}
              testId={undefined}
              variant={undefined}
              tone="muted"
            />
          ) : null}
          Turn on
        </Button>
      ) : null}
    </div>
  );
}

function SimulatorRow(props: {
  readonly epicId: string;
  readonly hostId: string;
  readonly viewTabId: string;
  readonly simulator: SimulatorSummary;
  readonly busy: boolean;
  /** The task holds a session on this simulator. */
  readonly open: boolean;
  readonly onOpen: ((simulator: SimulatorSummary) => void) | null;
}) {
  const { epicId, hostId, simulator, open } = props;
  const tileId = simulatorTileId({
    hostId,
    simulatorId: simulator.simulatorId,
  });
  const isActive = useIsActiveTile(props.viewTabId, tileId, hostId);
  const hostClient = useHostClientForHostId(hostId);
  const close = useSimulatorCloseMutation(
    hostClient,
    hostId,
    simulator.simulatorId,
  );
  const { mutate: closeMutate, isPending: closing } = close.mutation;
  const closeSession = useCallback(() => {
    closeMutate({
      epicId,
      simulatorId: simulator.simulatorId,
      shutdown: false,
    });
  }, [closeMutate, epicId, simulator.simulatorId]);
  const versionLabel = simulatorVersionLabel(simulator);
  const stateLabel = simulatorRowStateLabel(open, simulator.booted);
  return (
    <li>
      <div
        data-active={isActive}
        data-sidebar-node-id={tileId}
        className={cn(
          "group/simulator-row relative grid h-8 min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center rounded-md transition-colors duration-100 motion-reduce:transition-none",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
          SIDEBAR_REVEAL_HIGHLIGHT_CLASS,
        )}
      >
        <button
          type="button"
          data-testid={`epic-simulator-sidebar-row-${simulator.simulatorId}`}
          aria-label={`${simulator.name}, ${versionLabel}${stateLabel}`}
          disabled={props.onOpen === null || props.busy}
          className="flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          onClick={() => props.onOpen?.(simulator)}
        >
          <Smartphone className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{simulator.name}</span>
          <span className="shrink-0 text-ui-xs text-muted-foreground">
            {versionLabel}
          </span>
          <SimulatorRowTrailing
            busy={props.busy}
            booted={simulator.booted}
            open={open}
          />
        </button>
        {open && close.supported ? (
          <Button
            type="button"
            variant="muted-destructive"
            size="icon-xs"
            disabled={closing}
            aria-label={`Close ${simulator.name} in this task`}
            data-testid={`epic-simulator-sidebar-close-${simulator.simulatorId}`}
            className={cn(
              "size-6 cursor-pointer justify-self-center opacity-0 transition-opacity duration-100 pointer-events-none motion-reduce:transition-none",
              "group-focus-within/simulator-row:pointer-events-auto group-focus-within/simulator-row:opacity-100",
              "group-hover/simulator-row:pointer-events-auto group-hover/simulator-row:opacity-100",
              "group-data-[active=true]/simulator-row:pointer-events-auto group-data-[active=true]/simulator-row:opacity-100",
              "[@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
              closing && "pointer-events-auto opacity-100",
            )}
            onClick={closeSession}
          >
            {closing ? (
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
            ) : (
              <X className="size-3.5" aria-hidden />
            )}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function simulatorRowStateLabel(open: boolean, booted: boolean): string {
  if (open) return ", open in this task";
  if (booted) return ", running";
  return "";
}

function SimulatorRowTrailing(props: {
  readonly busy: boolean;
  readonly booted: boolean;
  readonly open: boolean;
}) {
  if (props.busy) {
    return (
      <AgentSpinningDots
        className="shrink-0"
        testId={undefined}
        variant={undefined}
        tone="muted"
      />
    );
  }
  if (props.open) {
    return (
      <Badge variant="info" size="xs" className="shrink-0">
        Open
      </Badge>
    );
  }
  if (!props.booted) return null;
  return (
    <Badge variant="success" size="xs" className="shrink-0">
      Running
    </Badge>
  );
}
