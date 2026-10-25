import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { DetailsHostRows } from "@/components/settings/details/details-host-rows";
import { detailsTime } from "@/components/settings/details/details-copy";
import {
  configurationChipState,
  type ConfigurationChipHost,
} from "@/components/settings/environment/status-chip-model";
import type { DetailsRecovery } from "@/lib/settings-details-entry";
import { cn } from "@/lib/utils";

const TONES = {
  success: "text-success-foreground",
  warning: "text-warning-foreground",
  info: "text-info-foreground",
} as const;

export function ConfigurationStatusChip(props: {
  readonly hosts: readonly ConfigurationChipHost[];
  readonly emptyText: string;
  readonly savingOffline: boolean;
  readonly local: boolean;
  readonly onDetails: () => void;
  readonly onRecover: (recovery: DetailsRecovery) => void;
  readonly recoveryPending: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  if (props.local) return null;
  const state = configurationChipState(
    props.hosts,
    props.savingOffline,
    props.emptyText,
  );
  const unsupported = props.hosts.find((host) => host.state === "unsupported");
  if (unsupported !== undefined && !props.savingOffline) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          props.onRecover({ kind: "overview", hostId: unsupported.hostId })
        }
      >
        {state.text}
      </Button>
    );
  }
  const latest = props.hosts.reduce<ConfigurationChipHost | null>(
    (current, host) =>
      host.lastReportedAt !== null &&
      (current?.lastReportedAt === null ||
        current === null ||
        host.lastReportedAt > current.lastReportedAt)
        ? host
        : current,
    null,
  );
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <span className={cn("max-w-full truncate", TONES[state.tone])}>
            {state.text}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto max-w-sm">
        <DetailsHostRows
          hosts={props.hosts.flatMap((host) => host.rows)}
          onRecover={props.onRecover}
          pending={props.recoveryPending}
        />
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-2">
          <p className="text-ui-xs text-muted-foreground">
            {latest === null
              ? "Last report unknown"
              : `Last reported by ${latest.name} ${detailsTime(latest.lastReportedAt)}`}
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setOpen(false);
              props.onDetails();
            }}
          >
            Details
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
