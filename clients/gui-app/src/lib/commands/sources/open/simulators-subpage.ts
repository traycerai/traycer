import { useMemo } from "react";
import { useSimulatorPanelAvailability } from "@/components/epic-canvas/sidebar/use-simulator-panel-availability";
import { useHostOptions } from "@/components/settings/host-scope/use-host-options";
import { useServingLocalHostId } from "@/hooks/browser/use-browser-open-host";
import { selectSoleEpicNodeHostId } from "@/hooks/epic/use-epic-node-host-ids";
import { useHostClientForHostId } from "@/hooks/host/use-host-client-for-host-id";
import { useSimulatorCatalogInventory } from "@/hooks/simulator/use-simulator-catalog-inventory";
import {
  useSimulatorInventories,
  type SimulatorInventoryEntry,
} from "@/hooks/simulator/use-simulator-inventories";
import { useSimulatorInstanceOpen } from "@/hooks/simulator/use-simulator-instance-open";
import { openTileIntoTargetGroup } from "@/lib/commands/actions";
import { openerActionLeaf } from "@/lib/commands/sources/open/open-leaf";
import { useActiveEpicProjection } from "@/lib/commands/sources/open/use-active-epic-projection";
import type { CommandContext, CommandItem } from "@/lib/commands/types";
import {
  simulatorPlatformLabel,
  simulatorVersionLabel,
} from "@/lib/simulator-view/simulator-labels";
import { suggestedSimulatorHostId } from "@/lib/simulator-view/suggested-simulator-host";

/**
 * The "Mobile simulators" opener category, beside Browser. It lists the
 * machine the + picker would suggest (this one when it can run simulators,
 * else the task's) and every machine the task's catalog has a session on,
 * each with its instances (Watch) and cold devices (Boot), the machine named
 * on every row.
 *
 * A row sends the open itself on a `@1.1` host, with the instance and a
 * `requestId`, and places the tile into the bound target group once the open
 * answers or the session shows on the stream; a `@1.0` host keeps today's
 * path, where the tile sends its own open.
 */
export function useSimulatorsOpenerItems(
  ctx: CommandContext,
): ReadonlyArray<CommandItem> {
  const hasTarget =
    ctx.activeEpicId !== null &&
    ctx.activeTabId !== null &&
    ctx.targetGroupId !== null;
  const epicId = ctx.activeEpicId ?? "";
  const projection = useActiveEpicProjection(ctx.activeEpicId);
  const taskHostId =
    projection === null ? null : selectSoleEpicNodeHostId(projection);
  const readerClient = useHostClientForHostId(taskHostId);
  const catalog = useSimulatorCatalogInventory({ epicId, readerClient });
  const servingLocalHostId = useServingLocalHostId();
  const { localHostRunsSimulators } = useSimulatorPanelAvailability();
  const suggested = suggestedSimulatorHostId({
    servingLocalHostId,
    localHostRunsSimulators,
    taskHostId: taskHostId ?? readerClient?.getActiveHostId() ?? null,
  });
  const catalogHostKey =
    catalog.scope === "cloud"
      ? [...new Set(catalog.records.map((record) => record.hostId))].join("\n")
      : "";
  const hostIds = useMemo(() => {
    const ids = suggested === null ? [] : [suggested];
    for (const hostId of catalogHostKey.split("\n")) {
      if (hostId.length > 0 && !ids.includes(hostId)) ids.push(hostId);
    }
    return ids;
  }, [catalogHostKey, suggested]);
  const inventories = useSimulatorInventories({
    hostIds,
    epicId,
    enabled: hasTarget,
  });
  const options = useHostOptions();
  const { open } = useSimulatorInstanceOpen(epicId);

  if (!hasTarget) return [];
  const hostName = (hostId: string): string =>
    options.hosts.find((host) => host.hostId === hostId)?.name ?? hostId;
  const openEntry = (entry: SimulatorInventoryEntry): void => {
    open({
      hostId: entry.hostId,
      target: entry.target,
      instance: entry.instanceKey ?? "auto",
      place: (ref) => {
        openTileIntoTargetGroup({
          tabId: ctx.activeTabId,
          groupId: ctx.targetGroupId,
          ref,
          dedupe: true,
          navigateNestedFocus: ctx.router.navigateNestedFocus,
        });
      },
    });
  };
  const rows = inventories.flatMap((inventory) =>
    inventory.entries.map((entry): CommandItem => {
      const machine = hostName(entry.hostId);
      return {
        ...openerActionLeaf({
          id: `open:simulators:${entry.key}`,
          label: entry.target.name,
          keywords: [
            entry.target.name,
            simulatorPlatformLabel(entry.target.platform),
            entry.target.version,
            "simulator",
            "emulator",
            machine,
          ],
          run: () => openEntry(entry),
        }),
        statusBadge: simulatorStatusBadge(entry, machine),
      };
    }),
  );
  if (rows.length > 0) return rows;
  const loading = inventories.some(
    (inventory) => inventory.status === "loading",
  );
  return [
    {
      ...openerActionLeaf({
        id: `open:simulators:${loading ? "loading" : "empty"}`,
        label: loading ? "Loading simulators…" : "No mobile simulators to open",
        keywords: ["simulator"],
        run: () => undefined,
      }),
      disabled: true,
    },
  ];
}

/** "iOS 26.5 · Agent · Pro" for an instance, "iOS 26.5 · Boot · Pro" for a device. */
function simulatorStatusBadge(
  entry: SimulatorInventoryEntry,
  machine: string,
): string {
  const parts = [simulatorVersionLabel(entry.target)];
  if (entry.kind === "device") parts.push("Boot");
  else if (entry.drivenByAgent) parts.push("Agent");
  else parts.push("Running");
  parts.push(machine);
  return parts.join(" · ");
}
