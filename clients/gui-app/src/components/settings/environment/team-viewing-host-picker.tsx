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

/** Every team live-fact card selects the same viewing host. */
export function TeamViewingHostPicker(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): ReactNode {
  const scope = useTeamViewingHost();
  const hosts = scope.hosts.isError ? [] : (scope.hosts.data?.hosts ?? []);
  let emptyLabel = "No hosts yet";
  if (scope.hosts.isError) emptyLabel = "Couldn't read hosts.";
  else if (scope.hosts.isPending) emptyLabel = "Loading hosts";
  return (
    <Select
      open={props.open}
      onOpenChange={(open) => {
        if (open && scope.hosts.isError) void scope.hosts.refetch();
        props.onOpenChange(open);
      }}
      value={scope.viewingHost?.hostId ?? ""}
      onValueChange={scope.selectHost}
    >
      <SelectTrigger
        aria-label="Host for live facts"
        size="sm"
        className="max-w-full"
      >
        <SelectValue placeholder="Pick a host" />
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
              {host.hostLabel ?? host.hostId}
              {scope.canSelectHost(host.hostId) ? "" : " · offline"}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
