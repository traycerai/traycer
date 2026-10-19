import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { Smartphone } from "lucide-react";
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
  useSimulatorConfigQuery,
  useSimulatorConfigSetMutation,
} from "@/hooks/simulator/use-simulator-mutations";
import { tileIntent } from "@/lib/canvas/tile-open/intent";
import { orderSimulators } from "@/lib/simulator-view/simulator-sessions-coordinator";
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
 * booted ones first, each a row that opens (booting when needed) its tile.
 *
 * It follows the panel's host pin, so what it lists is the same machine the
 * browser rows above it are on. A host that cannot run simulators gets no
 * group at all; one with them turned off gets the one line that can change
 * that. The explanations live in the tile and in Settings - this panel is
 * for what can be opened.
 */
export function SimulatorsSidebarGroup(props: {
  readonly epicId: string;
  readonly tabId: string;
  readonly hostId: string | null;
}) {
  const { epicId, tabId, hostId } = props;
  const sessions = useSimulatorSessionsForHost({ hostId, epicId });
  const hostClient = useHostClientForHostId(hostId);
  const { openTile } = useEpicTileNavigation();
  const opener = useOpenSimulatorTile({ client: hostClient, hostId, epicId });
  const { open, supported, openingSimulatorId } = opener;

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
        <SidebarGroupLabel>Simulators</SidebarGroupLabel>
        <SimulatorsGroupBody
          hostId={hostId}
          tabId={tabId}
          state={state}
          simulators={simulators}
          openingSimulatorId={openingSimulatorId}
          onOpen={supported ? openSimulator : null}
        />
      </SidebarGroup>
    </>
  );
}

function SimulatorsGroupBody(props: {
  readonly hostId: string;
  readonly tabId: string;
  readonly state: SimulatorState;
  readonly simulators: readonly SimulatorSummary[];
  readonly openingSimulatorId: string | null;
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
        Setting up simulators on this host…
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
            ? "Simulators stopped on this host."
            : "No simulators on this host."
        }
      />
    );
  }
  return (
    <ul ref={listRef} aria-label="Simulators" className="space-y-0.5">
      {props.simulators.map((simulator) => (
        <SimulatorRow
          key={simulator.simulatorId}
          hostId={props.hostId}
          viewTabId={props.tabId}
          simulator={simulator}
          busy={
            state.booting.includes(simulator.simulatorId) ||
            props.openingSimulatorId === simulator.simulatorId
          }
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
 * The switch's sidebar form: one button that turns simulators on for this
 * host. Agent access stays as it was (off until Settings says otherwise).
 */
function SimulatorsOffRow(props: { readonly hostId: string }) {
  const hostClient = useHostClientForHostId(props.hostId);
  const config = useSimulatorConfigQuery(hostClient, props.hostId);
  const { mutation, supported } = useSimulatorConfigSetMutation(
    hostClient,
    props.hostId,
  );
  const { mutate, isPending } = mutation;
  const agentAccess = config.data?.agentAccess ?? false;
  return (
    <div
      className="flex items-center gap-2 px-2 pb-1 text-ui-xs text-muted-foreground"
      data-testid="epic-simulators-note"
    >
      <span className="min-w-0 flex-1">Simulators are off on this host.</span>
      {supported ? (
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={isPending}
          data-testid="epic-simulators-turn-on"
          onClick={() => mutate({ enabled: true, agentAccess })}
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
  readonly hostId: string;
  readonly viewTabId: string;
  readonly simulator: SimulatorSummary;
  readonly busy: boolean;
  readonly onOpen: ((simulator: SimulatorSummary) => void) | null;
}) {
  const { simulator } = props;
  const tileId = simulatorTileId({
    hostId: props.hostId,
    simulatorId: simulator.simulatorId,
  });
  const isActive = useIsActiveTile(props.viewTabId, tileId, props.hostId);
  const platformLabel = simulator.platform === "ios" ? "iOS" : "Android";
  return (
    <li>
      <button
        type="button"
        data-active={isActive}
        data-sidebar-node-id={tileId}
        data-testid={`epic-simulator-sidebar-row-${simulator.simulatorId}`}
        aria-label={`${simulator.name}, ${platformLabel} ${simulator.version}${
          simulator.booted ? ", running" : ""
        }`}
        disabled={props.onOpen === null || props.busy}
        className={cn(
          "flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui-sm outline-none transition-colors duration-100 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none disabled:cursor-default",
          isActive
            ? "bg-accent text-accent-foreground"
            : "text-foreground/75 hover:bg-accent/70 hover:text-accent-foreground",
          SIDEBAR_REVEAL_HIGHLIGHT_CLASS,
        )}
        onClick={() => props.onOpen?.(simulator)}
      >
        <Smartphone className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{simulator.name}</span>
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {platformLabel} {simulator.version}
        </span>
        <SimulatorRowTrailing busy={props.busy} booted={simulator.booted} />
      </button>
    </li>
  );
}

function SimulatorRowTrailing(props: {
  readonly busy: boolean;
  readonly booted: boolean;
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
  if (!props.booted) return null;
  return (
    <Badge variant="success" size="xs" className="shrink-0">
      Running
    </Badge>
  );
}
