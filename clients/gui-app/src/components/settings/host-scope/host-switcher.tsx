import { useState, type ReactNode } from "react";
import { ChevronDown, Check, Plus } from "lucide-react";
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
  /** A host list request FAILED, so an empty `hosts` proves nothing. */
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const binding = useHostBinding();
  useRefreshHostDirectoryOnOpen(open, binding?.directory ?? null);
  const { hosts, selected } = props;

  // The empty state keys on the LIST, not on the selection.
  //
  // Keying it on `selected === null` conflated two opposite situations: "you
  // own no hosts" and "the host you were viewing was deregistered". The second
  // one still has hosts, and this early return replaced the picker with a dead
  // div — removing the only way back to a working host, and taking `Add host…`
  // with it, since this popover's footer is its sole opener. So the one moment
  // a person most needs the picker was the one moment it disappeared.
  if (hosts.length === 0) {
    // A FAILED list is not an empty account, here as much as in the gate — the
    // same rule, at its second consumer. This branch used to claim "No hosts
    // yet" and offer Add host over a union that was empty because a request
    // never came back: contradicting the panel beside it, and letting Add
    // record an empty known-hosts snapshot that a later successful retry
    // turned into "your existing host just connected". Retry is the honest
    // action; Add returns the moment the claim can be made.
    if (props.listsFailed && !props.isLoading) {
      return (
        <div
          className="flex w-full flex-col gap-2 px-3 py-2"
          data-testid="settings-host-switcher-lists-failed"
        >
          <span className="text-ui-xs text-muted-foreground">
            Couldn&apos;t load your hosts
          </span>
          <button
            type="button"
            onClick={props.onRetryLists}
            className="inline-flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            data-testid="settings-host-switcher-retry-lists"
          >
            Try again
          </button>
        </div>
      );
    }
    return (
      <div
        className="flex w-full flex-col gap-2 px-3 py-2"
        data-testid="settings-host-switcher-empty"
      >
        <span className="text-ui-xs text-muted-foreground">
          {props.isLoading ? "Finding your hosts…" : "No hosts yet"}
        </span>
        {/* Genuinely zero hosts is exactly when Add matters most, and it used
            to be unreachable here — the only opener lived in a popover this
            branch returned before rendering. */}
        {props.isLoading ? null : (
          <button
            type="button"
            onClick={props.onAddHost}
            className="inline-flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            data-testid="settings-host-switcher-empty-add"
          >
            <Plus className="size-3.5 shrink-0" />
            Add host…
          </button>
        )}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        // The DESTINATION belongs in the accessible name, not just the role.
        // A bare "Host" would tell a screen-reader user what the control is
        // for while withholding the one thing it displays.
        aria-label={
          selected === null
            ? "Settings host: none selected"
            : `Settings host: ${selected.name}`
        }
        data-testid="settings-host-switcher"
        // A filled row, not a bordered card. It has to read as a CONTROL among
        // navigation — the sections below it are transparent rows, so a quiet
        // fill separates "this thing opens" from "this thing navigates"
        // without adding a second vertical edge beside the rail's own border,
        // which is what made the earlier bordered version look like a panel
        // wedged into the sidebar. Muted, never accent: the accent is spoken
        // for by the selected section.
        className={cn(
          "flex w-full items-center gap-3 rounded-md bg-muted/50 px-3 py-2 text-left transition-colors",
          "hover:bg-muted/80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        )}
      >
        {/* `selected` is null while the scoped host is gone but others remain.
            The row stays a live control in that state — it is the way out. */}
        <span className="flex size-4 shrink-0 items-center justify-center">
          <HostPresenceDot
            tone={selected === null ? "idle" : selected.health.tone}
            animate={selected !== null && selected.health.live}
            className={undefined}
          />
        </span>
        {/* No ACTIVE chip here. Host names are long and this row is narrow, so
            a chip that is present in the common case bought one word and cost
            the name — and it was never the row's job: the rail says what you
            are VIEWING. Which host is active is stated where it has room and
            where it matters, on the dropdown rows and on Overview, and its
            absence is called out by the "Viewing —" note below. */}
        <span
          className={cn(
            "min-w-0 flex-1 truncate text-ui-sm font-medium",
            selected === null ? "text-muted-foreground" : "text-foreground",
          )}
        >
          {selected === null ? "Select a host" : selected.name}
        </span>
        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
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
                  scoped={selected !== null && host.hostId === selected.hostId}
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
        {/* The same "a FAILED list is not an empty account" rule, at its third
            consumer — the non-empty case. When one source list fails while the
            other still contributes rows, `hosts` is nonempty, so the empty
            branch above never runs and nothing said the picture was partial:
            the sidebar presented half an account as all of it. The rows stay
            usable; this footer says what is missing and offers the retry. */}
        {props.listsFailed && !props.isLoading ? (
          <div
            className="flex items-center justify-between gap-2 border-t border-border/60 px-3 py-2"
            data-testid="settings-host-switcher-partial-failure"
          >
            <span className="text-ui-xs text-muted-foreground">
              Some hosts may be missing
            </span>
            <button
              type="button"
              onClick={props.onRetryLists}
              className="shrink-0 rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              data-testid="settings-host-switcher-retry-lists"
            >
              Try again
            </button>
          </div>
        ) : null}
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
      // The check mark below is aria-hidden and `data-scoped` reaches no
      // assistive tech, so without this a screen reader heard the scoped row
      // and every other row as the same text.
      aria-current={props.scoped ? "true" : undefined}
    >
      <HostGlyph
        host={host}
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 flex-1 truncate text-ui-sm">{host.name}</span>
      {props.scoped ? <span className="sr-only">Currently viewing</span> : null}
      {props.active ? <ActiveTag /> : null}
      {/* A host this client cannot dial is still worth listing — it is the
          account's host and its status is real — but saying so up front
          prevents a click that could only ever fail. Plan-gated is named
          apart from unreachable: the first is fixed by an upgrade, the
          second maybe by waiting, and one word covering both sends people
          debugging their network over a billing limit. */}
      {host.connectable ? null : (
        <span className="shrink-0 text-ui-xs text-muted-foreground">
          {host.planRestricted ? "requires upgrade" : "unreachable"}
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
