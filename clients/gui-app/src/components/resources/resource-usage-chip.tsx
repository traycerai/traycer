import type { ReactNode } from "react";
import { Cpu } from "lucide-react";
import type { ResourceOwnerKindWire } from "@traycer/protocol/host/resources/subscribe";
import {
  useEpicResourceUsage,
  useOwnerResourceUsage,
} from "@/stores/resources/resources-registry";
import {
  formatCpuPercent,
  formatMemoryBytes,
  formatProcessCount,
} from "@/lib/resources/format-resource-usage";
import { cn } from "@/lib/utils";

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
    <span
      data-slot={props.slot}
      title={props.description}
      aria-label={props.description}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-ui-xs tabular-nums text-muted-foreground",
        props.className,
      )}
    >
      <Cpu aria-hidden className="size-3 shrink-0" />
      {props.children}
    </span>
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
  readonly rssBytes: number;
  readonly processCount: number;
  /** Prefix for the accessible label / hover title, e.g. "Resource usage". */
  readonly label: string;
  readonly className: string | undefined;
}

/**
 * Compact, non-interactive CPU / memory / process readout. Restrained by
 * design: an icon plus three tabular values, with the full labelled breakdown
 * carried on the accessible name + hover title so the inline form can stay
 * terse in tight sidebar rows.
 */
export function ResourceUsageChip(props: ResourceUsageChipProps) {
  const cpu = formatCpuPercent(props.cpuPercent);
  const memory = formatMemoryBytes(props.rssBytes);
  const processes = formatProcessCount(props.processCount);
  const processWord = pluralize(props.processCount, "process", "processes");
  const description = `${props.label}: ${cpu} CPU, ${memory} memory, ${processes} ${processWord}`;

  return (
    <ResourceChipFrame
      slot="resource-usage-chip"
      description={description}
      className={props.className}
    >
      <span>{cpu}</span>
      <ResourceChipSeparator />
      <span>{memory}</span>
      <ResourceChipSeparator />
      <span>{processes}</span>
    </ResourceChipFrame>
  );
}

export interface OwnerResourceChipProps {
  readonly epicId: string;
  readonly kind: ResourceOwnerKindWire;
  readonly ownerId: string;
  readonly className: string | undefined;
}

/**
 * Owner-scoped chip. Renders nothing when there is no live snapshot for the
 * owner - absent means "not currently tracked" (unknown), never zero use.
 */
export function OwnerResourceChip(props: OwnerResourceChipProps) {
  const usage = useOwnerResourceUsage(props.epicId, props.kind, props.ownerId);
  if (usage === null) return null;
  return (
    <ResourceUsageChip
      cpuPercent={usage.cpuPercent}
      rssBytes={usage.rssBytes}
      processCount={usage.processCount}
      label="Resource usage"
      className={props.className}
    />
  );
}

export interface EpicResourceChipProps {
  readonly epicId: string;
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
      processCount={usage.processCount}
      label="Epic resource usage"
      className={props.className}
    />
  );
}
