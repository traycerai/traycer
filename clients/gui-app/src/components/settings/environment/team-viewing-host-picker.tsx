import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
} from "@/components/ui/select";
import {
  canSwitchViewingHost,
  useTeamViewingHost,
} from "@/hooks/environment/team/use-team-viewing-host";
import { hostNameFromLabel } from "@/hooks/agent/use-host-reachability";

/**
 * Every team live-fact card selects the same viewing host, and names it the
 * same way: `as reported by <host> · Use another host`, the verb only while
 * another selectable host exists to switch to.
 *
 * A host is viewed whenever one can be selected, so no viewed host means
 * there is nothing to pick: the card's own line is the whole remedy then, and
 * no picker is drawn. The host list polls, so a picker appears as soon as a
 * selectable host does.
 */
export function TeamViewingHostPicker(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const viewing = scope.viewingHost;
  if (viewing === null) return null;
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        as reported by {hostNameFromLabel(viewing.hostLabel, viewing.hostId)}
      </span>
      {canSwitchViewingHost(scope) ? (
        <>
          <span aria-hidden>·</span>
          <TeamViewingHostSwitch
            open={props.open}
            onOpenChange={props.onOpenChange}
          />
        </>
      ) : null}
    </div>
  );
}

/**
 * The switch alone, with no claim about where anything on the page came from:
 * for a control that needs a host of its own beside content the room served,
 * such as an upload the viewed host refused. It draws nothing unless there is
 * another host to switch to.
 */
export function TeamViewingHostSwitch(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const hosts = scope.hosts.isError ? [] : (scope.hosts.data?.hosts ?? []);
  const viewing = scope.viewingHost;
  if (viewing === null || !canSwitchViewingHost(scope)) return null;
  return (
    <Select
      open={props.open}
      onOpenChange={props.onOpenChange}
      value={viewing.hostId}
      onValueChange={scope.selectHost}
    >
      <SelectTrigger size="sm" className="max-w-full">
        <SelectValue>Use another host</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {hosts.map((host) => (
            <SelectItem
              key={host.hostId}
              value={host.hostId}
              disabled={!scope.canSelectHost(host.hostId)}
            >
              {hostNameFromLabel(host.hostLabel, host.hostId)}
              {scope.canSelectHost(host.hostId) ? "" : " · offline"}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
