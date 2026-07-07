import { useMemo, useState, type ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import { SettingsPanelShell } from "@/components/settings/settings-panel-shell";
import { CommandAllowlistSection } from "@/components/settings/panels/command-allowlist-section";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHostClientFor } from "@/hooks/host/use-host-client-for";
import { useHostDirectoryList } from "@/hooks/host/use-host-directory-list-query";
import { useReactiveActiveHostId } from "@/hooks/host/use-reactive-active-host-id";
import { HostRuntimeContext, useHostBinding } from "@/lib/host/runtime";

export function PermissionsSettingsPanel() {
  const activeHostId = useReactiveActiveHostId();
  const hostsQuery = useHostDirectoryList();
  const hosts = useMemo(() => hostsQuery.data ?? [], [hostsQuery.data]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const effectiveId = selectedId ?? activeHostId;
  // Reach a non-active host through a transient client (the Worktrees
  // pattern) so picking one never rebinds the app-wide active host. Null when
  // the active host is selected - the inherited runtime context already
  // targets it, so no override client is built.
  const targetEntry = useMemo(() => {
    if (effectiveId === null || effectiveId === activeHostId) return null;
    return hosts.find((entry) => entry.hostId === effectiveId) ?? null;
  }, [hosts, effectiveId, activeHostId]);
  const transientClient = useHostClientFor(targetEntry);
  const realBinding = useHostBinding();
  // Scope the panel (the allowlist list + every allowlist mutation) to the
  // selected host by re-providing the runtime client for this subtree; the
  // allowlist hooks all read `useHostClient()`, so none need a client prop.
  const scopedBinding = useMemo(() => {
    if (transientClient === null || realBinding === null) return null;
    return { ...realBinding, hostClient: transientClient };
  }, [transientClient, realBinding]);

  const hostPicker =
    hosts.length > 0 ? (
      <PermissionsHostSelect
        hosts={hosts}
        value={effectiveId}
        onChange={setSelectedId}
      />
    ) : null;

  // A non-active host was picked but couldn't be bound (offline/unreachable).
  // Block the allowlist UI instead of silently falling back to the ambient
  // active host — otherwise the list/mutations would target the wrong host.
  const overrideUnavailable =
    effectiveId !== null &&
    effectiveId !== activeHostId &&
    scopedBinding === null;

  const inner = (
    <SettingsPanelShell
      title="Permissions"
      description="Actions you allowed to skip the approval prompt. Manage them per host."
      headerAction={hostPicker}
    >
      {overrideUnavailable ? (
        <div className="p-5 text-ui-sm text-muted-foreground">
          This host is offline. Reconnect to it to view or manage its saved
          actions.
        </div>
      ) : (
        <CommandAllowlistSection />
      )}
    </SettingsPanelShell>
  );
  if (scopedBinding === null) return inner;
  return (
    <HostRuntimeContext.Provider value={scopedBinding}>
      {inner}
    </HostRuntimeContext.Provider>
  );
}

function PermissionsHostSelect(props: {
  readonly hosts: readonly HostDirectoryEntry[];
  readonly value: string | null;
  readonly onChange: (hostId: string) => void;
}): ReactNode {
  return (
    <Select value={props.value ?? undefined} onValueChange={props.onChange}>
      <SelectTrigger
        size="sm"
        aria-label="Host"
        className="w-[min(40vw,12rem)]"
      >
        <SelectValue placeholder="Select a host" />
      </SelectTrigger>
      <SelectContent>
        {props.hosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {hostOptionLabel(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function hostOptionLabel(host: HostDirectoryEntry): string {
  const label = host.label.length > 0 ? host.label : host.hostId;
  return host.status === "unavailable" ? `${label} (offline)` : label;
}
