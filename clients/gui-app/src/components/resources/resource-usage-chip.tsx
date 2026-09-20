import { Fragment, type ReactNode } from "react";
import { Cpu } from "lucide-react";
import type { ResourceOwnerKindWireV14 } from "@traycer/protocol/host/resources/subscribe";
import {
  useEpicResourceUsage,
  useOwnerResourceUsage,
} from "@/stores/resources/resources-registry";
import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProcessCount,
} from "@/lib/resources/format-resource-usage";
import { UNAVAILABLE_DASH } from "@/lib/resources/memory-metric";
import { cn } from "@/lib/utils";
import type { NavigatorResourceMetric } from "@/stores/settings/settings-store";
import { useLayoutHotspot } from "@/components/customize/use-layout-hotspot";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function ResourceChipFrame(props: {
  readonly slot: string;
  readonly description: string;
  readonly className: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <TooltipWrapper
      label={props.description}
      side="top"
      sideOffset={undefined}
      align={undefined}
    >
      <span
        data-slot={props.slot}
        aria-label={props.description}
        className={cn(
          "inline-flex shrink-0 items-center gap-1 text-ui-xs tabular-nums text-muted-foreground",
          props.className,
        )}
      >
        <Cpu aria-hidden className="size-3 shrink-0" />
        {props.children}
      </span>
    </TooltipWrapper>
  );
}

function ResourceChipSeparator() {
  return (
    <span aria-hidden className="text-muted-foreground/50">
      ·
    </span>
  );
}

interface ResourceUsageChipProps {
  readonly cpuPercent: number;
  readonly rssBytes: number | null;
  readonly pssBytes: number | null;
  readonly processCount: number;
  /** Which readings print inline, in this order. Empty draws no chip. */
  readonly metrics: ReadonlyArray<NavigatorResourceMetric>;
  /** Prefix for the accessible label / hover title, e.g. "Resource usage". */
  readonly label: string;
  readonly className: string | undefined;
}

/**
 * Compact, non-interactive CPU / memory / process readout. Restrained by
 * design: an icon plus the tabular values the caller asked for, with the full
 * labelled breakdown carried on the accessible name + hover title so the
 * inline form can stay terse in tight sidebar rows.
 */
export function ResourceUsageChip(props: ResourceUsageChipProps) {
  if (props.metrics.length === 0) return null;
  const cpu = formatCpuPercent(props.cpuPercent);
  // One row is its own scope, so the popover's complete-scope rule reduces to
  // "PSS when this row has one". The metric is named in the VISIBLE text, not
  // only in the accessible one: two chips on screen otherwise show numbers
  // that are not comparable with nothing to tell them apart.
  const memoryMetric = props.pssBytes === null ? "RSS" : "PSS";
  const memoryBytes = props.pssBytes ?? props.rssBytes;
  const memory =
    memoryBytes === null
      ? UNAVAILABLE_DASH
      : `${formatMemoryBytes(memoryBytes)} ${memoryMetric}`;
  const processCount = formatProcessCount(props.processCount);
  const processWord = pluralize(props.processCount, "process", "processes");
  // Every reading names itself on screen, for the reason above: a pickable
  // list can put the process count anywhere - or alone, beside the frame's CPU
  // glyph - so a bare integer would read as a percentage missing its sign.
  // `procs` is the same short heading the status bar's identical picker uses
  // (`status-bar-resource-reading.ts`), singularised for the one-shell row the
  // sidebar draws most often.
  const processes = `${processCount} ${pluralize(props.processCount, "proc", "procs")}`;
  const memoryDescription =
    memoryBytes === null ? "memory unavailable" : memory;
  const description = `${props.label}: ${cpu} CPU, ${memoryDescription}, ${processCount} ${processWord}`;
  const readings: Record<NavigatorResourceMetric, string> = {
    cpu,
    memory,
    processes,
  };

  return (
    <ResourceChipFrame
      slot="resource-usage-chip"
      description={description}
      className={props.className}
    >
      {props.metrics.map((metric, index) => (
        <Fragment key={metric}>
          {index > 0 ? <ResourceChipSeparator /> : null}
          <span data-metric={metric}>{readings[metric]}</span>
        </Fragment>
      ))}
    </ResourceChipFrame>
  );
}

export interface OwnerResourceChipProps {
  readonly epicId: string;
  readonly kind: ResourceOwnerKindWireV14;
  readonly ownerId: string;
  /** Immutable owner host. Required for terminal rows; null for chat/agent. */
  readonly hostId: string | null;
  /** The readings to print, in this order - the row's setting, passed down. */
  readonly metrics: ReadonlyArray<NavigatorResourceMetric>;
  readonly className: string | undefined;
}

/**
 * Owner-scoped chip. Renders nothing when there is no live snapshot for the
 * owner - absent means "not currently tracked" (unknown), never zero use.
 */
export function OwnerResourceChip(props: OwnerResourceChipProps) {
  const usage = useOwnerResourceUsage(
    props.epicId,
    props.kind,
    props.ownerId,
    props.hostId,
  );
  if (usage === null) return null;
  return (
    <ResourceUsageChip
      cpuPercent={usage.cpuPercent}
      rssBytes={usage.rssBytes}
      pssBytes={usage.pssBytes}
      processCount={usage.processCount}
      metrics={props.metrics}
      label="Resource usage"
      className={props.className}
    />
  );
}

export interface NavigatorResourceHotspotOwner {
  readonly epicId: string;
  readonly kind: ResourceOwnerKindWireV14;
  readonly ownerId: string;
  readonly hostId: string | null;
}

export interface NavigatorResourceHotspotChipProps {
  /** Null for a row that never owns a tracked process (a spec, a ticket). */
  readonly owner: NavigatorResourceHotspotOwner | null;
  readonly metrics: ReadonlyArray<NavigatorResourceMetric>;
  readonly className: string | undefined;
  /**
   * Whether THIS row is the navigator's designated hotspot carrier. Every
   * navigator (chat tree, terminal sidebar) shows one `sidebar.resourceChips`
   * setting for the whole list, so exactly one row - the first one rendered -
   * registers it; every other row renders its chip passively, exactly as
   * before. Passing this from more than one row would collide on the same
   * instance key.
   */
  readonly registersHotspot: boolean;
}

/** Resolve the snapshot before deciding whether this row has a measurable chip. */
export function NavigatorResourceHotspotChip(
  props: NavigatorResourceHotspotChipProps,
): ReactNode {
  if (props.owner === null) {
    if (!props.registersHotspot) return null;
    return (
      <NavigatorResourceHotspotFrame
        condition={
          props.metrics.length === 0
            ? "No metrics selected"
            : "This row has no resource usage to show"
        }
      >
        {null}
      </NavigatorResourceHotspotFrame>
    );
  }
  if (!props.registersHotspot)
    return (
      <OwnerResourceChip
        {...props.owner}
        metrics={props.metrics}
        className={props.className}
      />
    );
  return (
    <NavigatorOwnerResourceHotspotChip
      owner={props.owner}
      metrics={props.metrics}
      className={props.className}
    />
  );
}

function NavigatorOwnerResourceHotspotChip(props: {
  owner: NavigatorResourceHotspotOwner;
  metrics: ReadonlyArray<NavigatorResourceMetric>;
  className: string | undefined;
}): ReactNode {
  const usage = useOwnerResourceUsage(
    props.owner.epicId,
    props.owner.kind,
    props.owner.ownerId,
    props.owner.hostId,
  );
  let condition: string | null = null;
  if (props.metrics.length === 0) condition = "No metrics selected";
  else if (usage === null) condition = "No reading yet";
  return (
    <NavigatorResourceHotspotFrame condition={condition}>
      {usage === null ? null : (
        <ResourceUsageChip
          {...usage}
          metrics={props.metrics}
          label="Resource usage"
          className={props.className}
        />
      )}
    </NavigatorResourceHotspotFrame>
  );
}

function NavigatorResourceHotspotFrame(props: {
  condition: string | null;
  children: ReactNode;
}): ReactNode {
  const { ref, editing } = useLayoutHotspot({
    settingId: "sidebar.resourceChips",
    tileId: null,
    ghost: props.condition !== null,
    condition: props.condition,
  });
  if (props.condition !== null) {
    if (!editing) return null;
    return (
      <span
        ref={ref}
        data-testid="sidebar-resource-chip-ghost"
        className="inline-flex h-3 w-10 shrink-0 rounded-sm border border-dashed border-border/60 opacity-70"
      />
    );
  }
  return (
    <span
      ref={ref}
      className={cn(editing ? "inline-flex shrink-0 items-center" : "contents")}
    >
      {props.children}
    </span>
  );
}

export interface EpicResourceChipProps {
  readonly epicId: string;
  readonly metrics: ReadonlyArray<NavigatorResourceMetric>;
  readonly className: string | undefined;
}

/**
 * Epic-aggregate chip for the local host. Renders nothing when the epic has no
 * tracked owner roots (a valid quiet state), distinct from a zero-total sample.
 */
export function EpicResourceChip(props: EpicResourceChipProps) {
  const usage = useEpicResourceUsage(props.epicId);
  if (usage === null) return null;
  return (
    <ResourceUsageChip
      cpuPercent={usage.cpuPercent}
      rssBytes={usage.rssBytes}
      pssBytes={usage.pssBytes}
      processCount={usage.processCount}
      metrics={props.metrics}
      label="Epic resource usage"
      className={props.className}
    />
  );
}
