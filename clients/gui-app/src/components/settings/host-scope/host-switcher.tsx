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
 * Search stops being decoration and starts being necessary somewhere around a
 * screenful of rows. Below this, a filter box is one more thing to skip past
 * on the way to a list you can already see whole.
 */
const SEARCH_THRESHOLD = 6;

/**
 * THE host selector. There is exactly one of these in Settings, and it heads
 * the sidebar group whose sections it scopes.
 *
 * It replaced four separate `Select`s (Providers' header, Worktrees' toolbar,
 * the snapshots row, the agent-instructions strip) that differed in width,
 * placement and scoping mechanism while doing one job — and, in an earlier
 * pass, a whole second "Hosts" page that duplicated every host verb.
 *
 * Its row anatomy is deliberately the composer's host picker
 * (`components/home/host-workspace-selector/host-section.tsx`): kind glyph,
 * name, status dot, check. Two pickers over the same concept must not each
 * invent their own vocabulary, so this one inherits the shape people already
 * know from choosing a host below the composer.
 *
 * It is NOT the active-host control. Choosing here swaps a transient client
 * and nothing else — no notification rebinding, no change to where new work
 * lands. That verb lives on the Overview page and states its consequence in
 * words. Hence the two independent marks: the CHECK is what Settings is
 * scoped to, the ACTIVE chip is what this window runs on.
 */
export function HostSwitcher(props: {
  readonly hosts: readonly HostScopeOption[];
  readonly selected: HostScopeOption | null;
  readonly activeHostId: string | null;
  readonly onSelect: (hostId: string) => void;
  readonly onAddHost: () => void;
  readonly isLoading: boolean;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const binding = useHostBinding();
  useRefreshHostDirectoryOnOpen(open, binding?.directory ?? null);
  const { hosts, selected } = props;

  if (selected === null) {
    return (
      <div
        className="flex w-full items-center gap-2 rounded-md border border-dashed border-border/70 px-2.5 py-2 text-ui-xs text-muted-foreground"
        data-testid="settings-host-switcher-empty"
      >
        {props.isLoading ? "Finding your hosts…" : "No hosts available"}
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
          "flex w-full items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-2.5 py-2 text-left transition-colors",
          "hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        <HostPresenceDot
          tone={selected.health.tone}
          animate={selected.health.live}
          className={undefined}
        />
        <span className="min-w-0 flex-1 truncate text-ui-sm font-medium text-foreground">
          {selected.name}
        </span>
        {selected.hostId === props.activeHostId ? <ActiveTag /> : null}
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(90vw,20rem)] p-0"
        data-testid="settings-host-switcher-list"
      >
        <Command>
          {hosts.length >= SEARCH_THRESHOLD ? (
            <CommandInput placeholder="Search hosts…" />
          ) : null}
          <CommandList>
            <CommandEmpty>No hosts match.</CommandEmpty>
            <CommandGroup heading="Host">
              {hosts.map((host) => (
                <HostSwitcherRow
                  key={host.hostId}
                  host={host}
                  scoped={host.hostId === selected.hostId}
                  active={host.hostId === props.activeHostId}
                  onSelect={() => {
                    props.onSelect(host.hostId);
                    setOpen(false);
                  }}
                />
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem
                value={ADD_HOST_VALUE}
                keywords={["add", "new", "install", "connect", "host"]}
                onSelect={() => {
                  setOpen(false);
                  props.onAddHost();
                }}
                data-testid="settings-host-switcher-add"
              >
                <Plus className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-ui-sm">
                  Add host…
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * One row: glyph · name · [ACTIVE] · status dot · check.
 *
 * Single-line by design. The old two-line row restated health as words under
 * every name, which at six hosts read as a log rather than a list; the dot
 * carries it, and the full sentence lives on Overview where there is room for
 * it to be useful.
 */
function HostSwitcherRow(props: {
  readonly host: HostScopeOption;
  readonly scoped: boolean;
  readonly active: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const { host } = props;
  return (
    <CommandItem
      value={host.hostId}
      keywords={[
        host.name,
        formatPlatform(host.platform) ?? "",
        formatHostVersion(host.version) ?? "",
      ]}
      onSelect={props.onSelect}
      data-testid={`settings-host-switcher-option-${host.hostId}`}
      data-scoped={props.scoped ? "true" : "false"}
    >
      <HostGlyph host={host} className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-ui-sm">{host.name}</span>
      {props.active ? <ActiveTag /> : null}
      {/* A host this client cannot dial is still worth listing — it is the
          account's host and its status is real — but saying so up front
          prevents a click that could only ever fail. */}
      {host.connectable ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          unreachable
        </span>
      )}
      <HostPresenceDot
        tone={host.health.tone}
        animate={host.health.live}
        className={undefined}
      />
      {props.scoped ? (
        <Check className="size-3.5 shrink-0 text-primary" aria-hidden />
      ) : (
        <span className="size-3.5 shrink-0" aria-hidden />
      )}
    </CommandItem>
  );
}

/**
 * The accent is reserved for the BINDING — which host this window uses. It
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
