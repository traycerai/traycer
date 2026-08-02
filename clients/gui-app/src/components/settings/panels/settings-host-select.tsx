import { useState, type ReactNode } from "react";
import type { HostDirectoryEntry } from "@traycer-clients/shared/host-client/host-directory";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useHostBinding } from "@/lib/host";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { settingsHostOptionLabel } from "./settings-host-labels";

export function SettingsHostSelect(props: {
  readonly hosts: readonly HostDirectoryEntry[];
  readonly value: string | null;
  readonly onChange: (hostId: string) => void;
  readonly ariaLabel: string;
}): ReactNode {
  const binding = useHostBinding();
  const directory = binding === null ? null : binding.directory;
  const [open, setOpen] = useState(false);
  useRefreshHostDirectoryOnOpen(open, directory);
  return (
    <Select
      open={open}
      onOpenChange={setOpen}
      value={props.value ?? undefined}
      onValueChange={props.onChange}
    >
      <SelectTrigger
        size="sm"
        aria-label={props.ariaLabel}
        className="w-[min(60vw,15rem)]"
      >
        <SelectValue placeholder="Select a host" />
      </SelectTrigger>
      <SelectContent>
        {props.hosts.map((host) => (
          <SelectItem key={host.hostId} value={host.hostId}>
            {settingsHostOptionLabel(host)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
