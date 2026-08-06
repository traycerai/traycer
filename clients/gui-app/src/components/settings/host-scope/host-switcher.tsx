import { useState, type ReactNode } from "react";
import { ChevronsUpDown, Check, Plus } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  HostGlyph,
  HostPresenceDot,
} from "@/components/settings/host-scope/host-glyph";
import {
  formatHostVersion,
  formatPlatform,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useHostBinding } from "@/lib/host";
import { cn } from "@/lib/utils";

const ADD_HOST_VALUE = "action:add-host";

/**
 * THE host selector. There is exactly one of these in Settings, and it heads
 * the sidebar group whose sections it scopes.
 *
 * It replaced four separate `Select`s (Providers' header, Worktrees' toolbar,
 * the snapshots row, the agent-instructions strip) that differed in width,
 * placement and scoping mechanism while doing one job. The rule it encodes is
 * the same one `McpScopePicker` established for MCP config location: **one
 * picker that always names its destination.** The trigger states the machine
 * in every state, so "which host am I editing?" is never a question the screen
 * declines to answer.
 *
 * It is deliberately NOT the active-host control. Choosing here swaps a
 * transient client and nothing else — no notification rebinding, no change to
 * where new work lands. That verb lives on the Overview page and states its
 * consequence in words.
 */
export function HostSwitcher(props: {
  readonly hosts: readonly HostScopeOption[];
  readonly selected: HostScopeOption | null;
  readonly onSelect: (hostId: string) => void;
  readonly onAddHost: () => void;
  readonly isLoading: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const binding = useHostBinding();
  useRefreshHostDirectoryOnOpen(open, binding?.directory ?? null);
  const { hosts, selected } = props;

  // A person with one machine should never be taxed by a control that offers
  // no choice. The identity still renders — that is the visibility half of the
  // brief — but as a plain card with no chevron, no search, and no popover.
  const isSoleHost = hosts.length <= 1;

  if (selected === null) {
    return (
      <div
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border/70 px-2.5 py-2 text-ui-xs text-muted-foreground"
        data-testid="settings-host-switcher-empty"
      >
        {props.isLoading ? "Finding your machines…" : "No hosts available"}
      </div>
    );
  }

  if (isSoleHost) {
    return (
      <div
        className="w-full rounded-md border border-border/60 bg-card/40 px-2.5 py-2"
        data-testid="settings-host-switcher-sole"
      >
        <HostSwitcherIdentity host={selected} />
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        // The DESTINATION belongs in the accessible name, not just the role.
        // A bare "Host" would tell a screen-reader user what the control is
        // for while withholding the one thing it displays.
        aria-label={`Settings host: ${selected.name}`}
        data-testid="settings-host-switcher"
        className={cn(
          "w-full rounded-md border border-border/60 bg-card/40 px-2.5 py-2 text-left transition-colors",
          "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        <div className="flex items-center gap-2">
          <HostSwitcherIdentity host={selected} />
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(90vw,22rem)] p-0"
        data-testid="settings-host-switcher-list"
      >
        <Command>
          <CommandInput placeholder="Search machines…" />
          <CommandList>
            <CommandEmpty>No machines match.</CommandEmpty>
            <HostSwitcherGroup
              heading="This device"
              hosts={hosts.filter((host) => host.isLocalMachine)}
              selectedId={selected.hostId}
              onSelect={(hostId) => {
                props.onSelect(hostId);
                setOpen(false);
              }}
            />
            <HostSwitcherGroup
              heading="Your other machines"
              hosts={hosts.filter((host) => !host.isLocalMachine)}
              selectedId={selected.hostId}
              onSelect={(hostId) => {
                props.onSelect(hostId);
                setOpen(false);
              }}
            />
            <CommandGroup>
              <CommandItem
                value={ADD_HOST_VALUE}
                keywords={["add", "new", "install", "connect", "machine"]}
                onSelect={() => {
                  setOpen(false);
                  props.onAddHost();
                }}
              >
                <Plus className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-ui-sm">
                  Add a machine…
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function HostSwitcherGroup(props: {
  readonly heading: string;
  readonly hosts: readonly HostScopeOption[];
  readonly selectedId: string;
  readonly onSelect: (hostId: string) => void;
}): ReactNode {
  if (props.hosts.length === 0) return null;
  return (
    <CommandGroup heading={props.heading}>
      {props.hosts.map((host) => (
        <CommandItem
          key={host.hostId}
          value={host.hostId}
          keywords={[host.name, formatPlatform(host.platform) ?? ""]}
          onSelect={() => props.onSelect(host.hostId)}
          data-testid={`settings-host-switcher-option-${host.hostId}`}
        >
          <HostGlyph host={host} className="size-4 text-muted-foreground" />
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="truncate text-ui-sm">{host.name}</span>
              {host.isActive ? <ActiveTag /> : null}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
              <HostPresenceDot
                tone={host.health.tone}
                animate={host.health.live}
                className={undefined}
              />
              <span className="truncate">{host.health.label}</span>
              {/* A host this client cannot dial is still worth listing — it is
                  the account's machine and its status is real — but saying so
                  up front prevents a click that could only ever fail. */}
              {host.connectable ? null : (
                <span className="shrink-0">· can't reach from here</span>
              )}
            </span>
          </span>
          {host.hostId === props.selectedId ? (
            <Check className="size-4 shrink-0 text-primary" aria-hidden />
          ) : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

function HostSwitcherIdentity(props: {
  readonly host: HostScopeOption;
}): ReactNode {
  const { host } = props;
  const platform = formatPlatform(host.platform);
  const version = formatHostVersion(host.version);
  // Two facts at most. The old row carried five (name, platform triple, build
  // id, three status pills, a bare switch) and read as a log line.
  const detail = [host.health.label, platform ?? version]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <HostGlyph host={host} className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-ui-sm font-medium text-foreground">
            {host.name}
          </span>
          {host.isActive ? <ActiveTag /> : null}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-ui-xs text-muted-foreground">
          <HostPresenceDot
            tone={host.health.tone}
            animate={host.health.live}
            className={undefined}
          />
          <span className="truncate">{detail}</span>
        </span>
      </span>
    </span>
  );
}

/**
 * The accent is reserved for the BINDING — which machine this window uses. It
 * never marks the viewing selection, so the two can always be told apart at a
 * glance even when they happen to be the same host.
 */
function ActiveTag(): ReactNode {
  return (
    <span className="shrink-0 rounded-sm bg-primary/15 px-1 py-px text-[0.625rem] font-medium uppercase tracking-wide text-primary">
      Active
    </span>
  );
}
