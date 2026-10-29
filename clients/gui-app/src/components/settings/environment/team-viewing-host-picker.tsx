import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SelectGroup,
} from "@/components/ui/select";
import { useTeamViewingHost } from "@/hooks/environment/team/use-team-viewing-host";
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
  const hosts = scope.hosts.isError ? [] : (scope.hosts.data?.hosts ?? []);
  const viewing = scope.viewingHost;
  if (viewing === null) return null;
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
        </>
      ) : null}
    </div>
  );
}
