import type {
  SimulatorState,
  SimulatorSummary,
} from "@traycer/protocol/host/simulator/schemas";
import { useOpenSimulatorTile } from "@/components/simulator-tile/use-open-simulator-tile";
import { useHostDirectoryEntryForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useTabSurfaceKey } from "@/hooks/host/use-surface-host-pin";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { openerActionLeaf } from "@/lib/commands/sources/open/open-leaf";
import { useActiveEpicSurfaceHostPin } from "@/lib/commands/sources/open/use-active-epic-surface-host-pin";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import {
  simulatorPlatformLabel,
  simulatorVersionLabel,
} from "@/lib/simulator-view/simulator-labels";
import {
  orderSimulators,
  simulatorHasSession,
  type SimulatorSessionsState,
} from "@/lib/simulator-view/simulator-sessions-coordinator";
import { useSimulatorSessionsForHost } from "@/lib/simulator-view/use-simulator-sessions";

/**
 * The "Simulators" opener category, beside Browser. It reads the same host
 * the Browser category does - the browsers surface pin - so the two agree
 * about which machine they list, and each row places that simulator's tile
 * into the bound target group; the tile connects, and boots when needed.
 */
export function useSimulatorsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const surfaceKey = useTabSurfaceKey("browsers", ctx.activeTabId ?? "");
  const hostPin = useActiveEpicSurfaceHostPin(surfaceKey, ctx.activeEpicId);
  const hasTarget =
    ctx.activeEpicId !== null &&
    ctx.activeTabId !== null &&
    ctx.targetGroupId !== null;
  const targetHostId = hasTarget ? hostPin.resolvedHostId : null;
  const epicId = ctx.activeEpicId ?? "";
  const sessions = useSimulatorSessionsForHost({
    hostId: targetHostId,
    epicId,
  });
  const hostEntry = useHostDirectoryEntryForHostId(targetHostId);
  const opener = useOpenSimulatorTile({ hostId: targetHostId });
  const directoryLabel = hostEntry?.label.trim() ?? "";
  const hostLabel =
    directoryLabel.length > 0
      ? directoryLabel
      : (targetHostId ?? "Current host");

  const openSimulator = (simulator: SimulatorSummary): void => {
    opener.open(simulator, (ref) => {
      openTileIntoTargetGroup({
        tabId: ctx.activeTabId,
        groupId: ctx.targetGroupId,
        ref,
        dedupe: true,
        navigateNestedFocus: ctx.router.navigateNestedFocus,
      });
    });
  };

  const state = sessions.state;
  const placeholder = placeholderItems(sessions, hostLabel);
  if (placeholder !== null || state === null) return placeholder ?? [];
  const rows = orderSimulators(state.simulators).map((simulator) => {
    const busy = state.booting.includes(simulator.simulatorId);
    return {
      ...openerActionLeaf({
        id: `open:simulators:${simulator.simulatorId}`,
        label: simulator.name,
        keywords: [
          simulator.name,
          simulatorPlatformLabel(simulator.platform),
          simulator.version,
          "simulator",
          "emulator",
          hostLabel,
        ],
        run: () => openSimulator(simulator),
      }),
      statusBadge: simulatorStatusBadge(
        simulator,
        busy,
        simulatorHasSession(state, simulator.simulatorId),
      ),
      disabled: !opener.supported || busy,
    };
  });
  if (rows.length > 0) return rows;
  return [
    {
      ...openerActionLeaf({
        id: `open:simulators:${state.packState.kind}`,
        label: emptyInventoryLabel(state.packState.kind),
        keywords: ["simulator", hostLabel],
        run: () => undefined,
      }),
      disabled: true,
    },
  ];
}

function simulatorStatusBadge(
  simulator: SimulatorSummary,
  busy: boolean,
  open: boolean,
): string {
  if (busy) return "Starting…";
  const base = simulatorVersionLabel(simulator);
  if (open) return `${base} · Open`;
  return simulator.booted ? `${base} · Running` : base;
}

function emptyInventoryLabel(
  packKind: SimulatorState["packState"]["kind"],
): string {
  switch (packKind) {
    case "off":
      return "Simulators are off on this host";
    case "installing":
      return "Setting up simulators…";
    default:
      return "No simulators on this host";
  }
}

/**
 * The one row shown instead of an inventory: the host is too old, the stream
 * has not answered or failed, or the machine can run neither platform. `null`
 * when the inventory itself should be listed.
 */
function placeholderItems(
  sessions: SimulatorSessionsState,
  hostLabel: string,
): ReadonlyArray<CommandItem> | null {
  if (sessions.lifecycle === "unsupported") {
    return [
      {
        ...openerActionLeaf({
          id: "open:simulators:unsupported",
          label:
            sessions.errorMessage ??
            "This host needs an update before it can show simulators.",
          keywords: ["simulator", "unsupported", "update", hostLabel],
          run: () => undefined,
        }),
        disabled: true,
      },
    ];
  }
  const state = sessions.state;
  if (state === null) {
    const failed =
      sessions.lifecycle === "failed" || sessions.lifecycle === "closed";
    return [
      {
        ...openerActionLeaf({
          id: `open:simulators:${failed ? "retry" : "loading"}`,
          label: failed ? "Retry loading simulators" : "Loading simulators…",
          keywords: ["simulator", "retry", "loading", hostLabel],
          run: failed ? sessions.retry : () => undefined,
        }),
        ...(failed ? { statusBadge: "Unavailable" } : { disabled: true }),
      },
    ];
  }
  if (state.platforms.every((platform) => !platform.available)) {
    return [
      {
        ...openerActionLeaf({
          id: "open:simulators:no-platform",
          label: `${hostLabel} can't run simulators`,
          keywords: ["simulator", "unavailable", hostLabel],
          run: () => undefined,
        }),
        disabled: true,
      },
    ];
  }
  return null;
}
