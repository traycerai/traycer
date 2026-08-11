import type { ReactNode } from "react";
import { Server } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  USAGE_ALL_HOSTS_VALUE,
  usageHostFilterHostId,
  usageHostFilterValue,
  type UsageHostFilterOption,
} from "@/lib/usage-analytics/usage-host-split";

const ALL_HOSTS_LABEL = "All hosts";

export interface UsageHostFilterProps {
  readonly options: readonly UsageHostFilterOption[];
  /** `null` = All hosts. */
  readonly hostId: string | null;
  readonly onChange: (hostId: string | null) => void;
  /**
   * The read is being served by the LOCAL plane, which only holds this
   * machine's own executions - so there is no cross-host total to filter
   * and the control states that instead of offering a choice it cannot
   * honor. `null` while no response has arrived yet.
   */
  readonly pinnedToHostName: string | null;
}

/**
 * The dashboard's host scope: "All hosts" by default on the cloud plane, one
 * host when picked.
 *
 * On `servedBy: "local"` this is NOT a disabled dropdown. A greyed-out
 * picker says "you may not choose"; the truth is that there is nothing to
 * choose BETWEEN, because that plane can only ever see the machine it runs
 * on. So the control becomes a plain readout naming that machine, in the
 * same honest-state vocabulary the rest of this surface uses - a statement
 * of scope, not a blocked action.
 */
export function UsageHostFilter(props: UsageHostFilterProps): ReactNode {
  if (props.pinnedToHostName !== null) {
    return (
      <span
        className="flex items-center gap-1.5 text-ui-xs text-muted-foreground"
        data-testid="usage-host-filter-pinned"
      >
        <Server aria-hidden className="size-3.5" />
        {props.pinnedToHostName} only
      </span>
    );
  }
  return (
    <Select
      value={usageHostFilterValue(props.hostId)}
      onValueChange={(value) => {
        props.onChange(usageHostFilterHostId(value));
      }}
    >
      <SelectTrigger
        size="sm"
        aria-label="Host"
        className="max-w-48"
        data-testid="usage-host-filter"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem
          value={USAGE_ALL_HOSTS_VALUE}
          data-testid="usage-host-filter-all"
        >
          {ALL_HOSTS_LABEL}
        </SelectItem>
        {props.options.map((option) => (
          <SelectItem
            key={option.hostId}
            value={option.hostId}
            data-testid={`usage-host-filter-option-${option.hostId}`}
          >
            {option.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
