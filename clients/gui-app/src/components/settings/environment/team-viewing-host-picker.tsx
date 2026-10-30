import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectLabel,
  SelectGroup,
} from "@/components/ui/select";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
import { hostNameFromLabel } from "@/hooks/agent/use-host-reachability";

/**
 * Every team live-fact card selects the same viewing host, and names it the
 * same way: `as reported by <host> · Use another host`, the verb only while
 * another selectable host exists to switch to.
 */
export function TeamViewingHostPicker(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const hosts = scope.hosts.isError ? [] : (scope.hosts.data?.hosts ?? []);
  let emptyLabel = "No hosts yet";
  if (scope.hosts.isError) emptyLabel = "Couldn't read hosts.";
  else if (scope.hosts.isPending) emptyLabel = "Loading hosts";
  const viewing = scope.viewingHost;
  const picker = (
    <Select
      open={props.open}
      onOpenChange={(open) => {
        if (open && scope.hosts.isError) void scope.hosts.refetch();
        props.onOpenChange(open);
      }}
      value={scope.viewingHost?.hostId ?? ""}
      onValueChange={scope.selectHost}
    >
      <SelectTrigger size="sm" className="max-w-full">
        <SelectValue placeholder="Pick a host">Use another host</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {hosts.length === 0 ? <SelectLabel>{emptyLabel}</SelectLabel> : null}
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
  if (viewing === null) return picker;
  const canSwitch = hosts.some(
    (host) =>
      host.hostId !== viewing.hostId && scope.canSelectHost(host.hostId),
  );
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5 text-ui-xs text-muted-foreground">
      <span className="min-w-0 truncate">
        as reported by {hostNameFromLabel(viewing.hostLabel, viewing.hostId)}
      </span>
      {canSwitch ? (
        <>
          <span aria-hidden>·</span>
          {picker}
        </>
      ) : null}
    </div>
  );
}
