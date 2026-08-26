import { useState, type ReactNode } from "react";
import { ChevronDown, Plus, Settings, type LucideIcon } from "lucide-react";
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
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  hostRowSurfaceState,
  hostOptionStatusWord,
  isHostOptionSelectable,
  type HostPickIntent,
} from "@/components/settings/host-scope/host-option-model";
import { HOST_SWITCHER_LIST_ATTRIBUTE } from "@/components/settings/host-scope/host-switcher-portal";
import {
  formatHostVersion,
  formatPlatform,
  type HostScopeOption,
} from "@/components/settings/host-scope/host-scope-model";
import { useRefreshHostDirectoryOnOpen } from "@/hooks/host/use-refresh-host-directory-on-open";
import { useCoarsePointerOpenAutoFocus } from "@/hooks/ui/use-coarse-pointer-open-autofocus";
import { useHostBinding } from "@/lib/host";
import { cn } from "@/lib/utils";

/**
 * Search stops being decoration and starts being necessary somewhere around a
 * screenful of rows. Below this, a filter box is one more thing to skip past
 * on the way to a list you can already see whole.
 */
const SEARCH_THRESHOLD = 6;

/**
 * The trigger's accessible name. A `view` surface keeps the wording it has had
 * since it was Settings' own control; a `bind` surface says what it is.
 */
function hostSwitcherLabel(
  intent: HostPickIntent,
  selected: HostScopeOption | null,
  status: string | null,
): string {
  const subject = intent === "view" ? "Settings host" : "Host";
  return selected === null
    ? `${subject}: none selected`
    : `${subject}: ${selected.name}${status === null ? "" : `, ${status}`}`;
}

export type HostSwitcherActionKind = "add-host" | "manage-hosts";

/**
 * The picker's trailing action — a prop rather than a constant because only
 * Settings owns the add-host flow; every other surface points back to it.
 *
 * Settings owns ADD: the dialog, the known-hosts snapshot it takes and every
 * failure state it can land in all live there, and this footer is its only
 * opener. A surface that merely WATCHES a host (the header's usage popover) has
 * no business growing a second copy of that flow, so it ends the list by
 * pointing at Settings instead. The rows above are identical either way, which
 * is the point: one picker, one row vocabulary, two endings.
 */
export interface HostSwitcherAction {
  readonly kind: HostSwitcherActionKind;
  readonly onSelect: () => void;
}

interface HostSwitcherActionPresentation {
  readonly label: string;
  readonly icon: LucideIcon;
  /** cmdk needs a stable value that cannot collide with a `hostId`. */
  readonly commandValue: string;
  readonly keywords: readonly string[];
  readonly testId: string;
  /** The same action as the zero-host branch's button, which is not a row. */
  readonly emptyTestId: string;
}

/**
 * Where this picker sits, which decides how its list ATTACHES — the second
 * thing that cannot be one constant for both surfaces.
 *
 * - `rail`: a control among navigation (Settings' sidebar). The trigger is a
 *   filled, rounded row and the list floats below it at its own comfortable
 *   width, because the rail is far too narrow to read host names in.
 * - `field`: one control among other controls, inside a panel that is already
 *   open (the workspace and worktree pickers, where a search field sits right
 *   under it). A quiet fill is not enough there: everything around it is flat,
 *   so the row read as a heading with a stray chevron rather than something you
 *   could open. It borrows the search field's own border and fill, which is
 *   what makes the two read as siblings instead of as a label above a control.
 * - `inline`: a compact peer of other ghost controls below a composer. It
 *   shares their muted resting text and foreground-alpha hover, while its
 *   list still uses the same full host-row vocabulary as every other surface.
 * - `panel-header`: the picker IS the top strip of the card it heads (the
 *   header's usage popover). Here a floating list is actively wrong: a rounded
 *   panel inset inside a rounded panel puts two borders a few pixels apart on
 *   every edge, and the result reads as an unrelated menu that happened to land
 *   there rather than as this row's choices. So the trigger goes full-bleed and
 *   square, and the list drops flush from its bottom edge at exactly its width
 *   — one shared edge, one continuous surface.
 */
export type HostSwitcherSurface = "rail" | "panel-header" | "field" | "inline";

interface HostSwitcherSurfacePresentation {
  /**
   * On the rail: a filled row, not a bordered card. It has to read as a CONTROL
   * among navigation — the sections below it are transparent rows, so a quiet
   * fill separates "this thing opens" from "this thing navigates" without
   * adding a second vertical edge beside the rail's own border, which is what
   * made the earlier bordered version look like a panel wedged into the
   * sidebar. Muted, never accent: the accent is spoken for by the selected
   * section.
   *
   * As a panel header: no resting fill and no radius. The strip already has the
   * card's own edges around it and a divider under it, so a second rounded fill
   * inside them is the "panel wedged into a panel" problem again, one level in.
   * The hover fill still says it opens.
   */
  readonly trigger: string;
  /** Squares off the two corners that would cut back in under the strip. */
  readonly list: string;
  /**
   * Flush against the trigger's bottom edge as a panel header, so the list's
   * own top edge lands ON the strip's divider instead of drawing a second line
   * a few pixels under it. On the rail the usual float is right — there is no
   * card edge for it to double up against.
   */
  readonly sideOffsetPx: number;
}

const HOST_SWITCHER_SURFACES: Record<
  HostSwitcherSurface,
  HostSwitcherSurfacePresentation
> = {
  rail: {
    trigger: "rounded-md bg-foreground/5 hover:bg-foreground/7",
    list: "",
    sideOffsetPx: 4,
  },
  "panel-header": {
    trigger: "hover:bg-foreground/5",
    list: "rounded-t-none",
    sideOffsetPx: 0,
  },
  field: {
    // Deliberately the same tokens as the worktree picker's search input
    // (`InputGroup`, `border-input/40 bg-input/25`), one control above it.
    trigger:
      "rounded-lg border border-input/40 bg-input/25 hover:bg-input/40 dark:hover:bg-input/40",
    list: "",
    sideOffsetPx: 4,
  },
  inline: {
    trigger:
      "h-7 w-fit max-w-full gap-1.5 rounded-lg px-1.5 py-0 text-muted-foreground hover:bg-foreground/5 hover:text-foreground",
    list: "",
    sideOffsetPx: 4,
  },
};

const HOST_SWITCHER_ACTIONS: Record<
  HostSwitcherActionKind,
  HostSwitcherActionPresentation
> = {
  "add-host": {
    label: "Add host…",
    icon: Plus,
    commandValue: "action:add-host",
    keywords: ["add", "new", "install", "connect", "host"],
    testId: "settings-host-switcher-add",
    emptyTestId: "settings-host-switcher-empty-add",
  },
  "manage-hosts": {
    label: "Manage hosts…",
    icon: Settings,
    commandValue: "action:manage-hosts",
    keywords: ["manage", "settings", "add", "install", "host", "hosts"],
    testId: "settings-host-switcher-manage",
    emptyTestId: "settings-host-switcher-empty-manage",
  },
};

/**
 * THE host selector. Settings, monitoring surfaces, worktree pickers, and the
 * composer all mount this component. They may write different selections, but
 * host rows, states, keyboard behavior, and menu layout stay identical.
 *
 * It replaced four separate `Select`s (Providers' header, Worktrees' toolbar,
 * the snapshots row, the agent-instructions strip) that differed in width,
 * placement and scoping mechanism while doing one job — and, in an earlier
 * pass, a whole second "Hosts" page that duplicated every host verb.
 *
 * The caller's `intent` owns the consequence of choosing; it never changes the
 * picker anatomy or invents a second status vocabulary.
 */
export function HostSwitcher(props: {
  readonly hosts: readonly HostScopeOption[];
  readonly selected: HostScopeOption | null;
  readonly activeHostId: string | null;
  readonly onSelect: (hostId: string) => void;
  /** How this list ends — see `HostSwitcherAction`. */
  readonly action: HostSwitcherAction;
  /** Where this picker sits — see `HostSwitcherSurface`. */
  readonly surface: HostSwitcherSurface;
  /**
   * What choosing a host here DOES. `bind` surfaces (the composer, the worktree
   * pickers) and `pin` surfaces (the composer and scoped tools) require a host
   * this client can dial; `view` surfaces may point at one regardless. See
   * `HostPickIntent`.
   */
  readonly intent: HostPickIntent;
  /**
   * Per-host reasons THIS surface cannot use a host, keyed by `hostId` — the
   * fork dialog's "needs update" for a target that does not speak the fork RPC
   * at the required minor. `NO_HOST_OPTION_REFUSALS` for every surface that has
   * none, which is all of them but that one.
   */
  readonly refusalByHostId: ReadonlyMap<string, string>;
  /**
   * Every row but this one is inert with NO explanation on it — the calling
   * surface owns the sentence. `null` imposes nothing. See `HostSection`.
   */
  readonly inertExceptHostId: string | null;
  /**
   * The surface owns the selection right now — a submission is in flight, or it
   * is pinned to one host. The trigger goes inert rather than opening a list
   * whose every row would be refused.
   */
  readonly disabled: boolean;
  /** Keep a disabled trigger focusable so its explanatory tooltip is reachable. */
  readonly keepFocusableWhenDisabled?: boolean;
  readonly isLoading: boolean;
  /** A host list request FAILED, so an empty `hosts` proves nothing. */
  readonly listsFailed: boolean;
  readonly onRetryLists: () => void;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const { contentRef, onOpenAutoFocus: coarseOpenAutoFocus } =
    useCoarsePointerOpenAutoFocus();
  const binding = useHostBinding();
  useRefreshHostDirectoryOnOpen(open, binding?.directory ?? null);
  const { hosts, selected } = props;
  const action = HOST_SWITCHER_ACTIONS[props.action.kind];
  const ActionIcon = action.icon;
  const surface = HOST_SWITCHER_SURFACES[props.surface];

  // The empty state keys on the LIST, not on the selection.
  //
  // Keying it on `selected === null` conflated two opposite situations: "you
  // own no hosts" and "the host you were viewing was deregistered". The second
  // one still has hosts, and this early return replaced the picker with a dead
  // div — removing the only way back to a working host, and taking Settings'
  // `Add host…` with it, since that footer is its sole opener. So the one moment
  // a person most needs the picker was the one moment it disappeared.
  if (hosts.length === 0) {
    // A FAILED list is not an empty account, here as much as in the gate — the
    // same rule, at its second consumer. This branch used to claim "No hosts
    // yet" and offer the trailing action over a union that was empty because a
    // request never came back: contradicting the panel beside it, and letting
    // Add record an empty known-hosts snapshot that a later successful retry
    // turned into "your existing host just connected". Retry is the honest
    // action; the rest returns the moment the claim can be made.
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
        {/* Genuinely zero hosts is exactly when this action matters most, and
            it used to be unreachable here — the only opener lived in a popover
            this branch returned before rendering. */}
        {props.isLoading ? null : (
          <button
            type="button"
            onClick={props.action.onSelect}
            className="inline-flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            data-testid={action.emptyTestId}
          >
            <ActionIcon className="size-3.5 shrink-0" />
            {action.label}
          </button>
        )}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <HostSwitcherTrigger
        intent={props.intent}
        selected={selected}
        disabled={props.disabled}
        keepFocusableWhenDisabled={props.keepFocusableWhenDisabled}
        surfaceKind={props.surface}
        surface={surface}
      />
      <PopoverContent
        align="start"
        sideOffset={surface.sideOffsetPx}
        // Never narrower than the row it drops out of. A list floating at its
        // own width under a wider trigger reads as an unrelated panel that
        // happened to land there — the connection between "this row" and "these
        // choices" is carried by the shared left edge AND the shared width. The
        // 20rem is a FLOOR for the narrow case (the rail, whose trigger is far
        // too narrow to read host names in), not a size.
        className={cn(
          "w-[min(90vw,20rem)] min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)] p-0",
          surface.list,
        )}
        data-testid="settings-host-switcher-list"
        {...{ [HOST_SWITCHER_LIST_ATTRIBUTE]: "true" }}
        ref={contentRef}
        // Only the search input is worth declining for; below the threshold
        // there is no input and Radix's default lands on a host row, which
        // summons nothing.
        onOpenAutoFocus={
          hosts.length >= SEARCH_THRESHOLD ? coarseOpenAutoFocus : undefined
        }
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
                  intent={props.intent}
                  surfaceRefusal={
                    props.refusalByHostId.get(host.hostId) ?? null
                  }
                  surfaceInert={
                    props.inertExceptHostId !== null &&
                    host.hostId !== props.inertExceptHostId
                  }
                  onSelect={() => {
                    props.onSelect(host.hostId);
                    setOpen(false);
                  }}
                />
              ))}
            </CommandGroup>
            <CommandGroup>
              <CommandItem
                value={action.commandValue}
                keywords={[...action.keywords]}
                onSelect={() => {
                  setOpen(false);
                  props.action.onSelect();
                }}
                data-testid={action.testId}
              >
                <ActionIcon className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate text-ui-sm">
                  {action.label}
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

function HostSwitcherTrigger(props: {
  readonly intent: HostPickIntent;
  readonly selected: HostScopeOption | null;
  readonly disabled: boolean;
  readonly keepFocusableWhenDisabled?: boolean;
  readonly surfaceKind: HostSwitcherSurface;
  readonly surface: HostSwitcherSurfacePresentation;
}): ReactNode {
  const { selected } = props;
  const triggerStatus =
    selected === null
      ? null
      : hostOptionStatusWord(selected, AVAILABLE_HOST_ROW_SURFACE_STATE);
  const keepFocusableWhenDisabled =
    props.disabled && props.keepFocusableWhenDisabled === true;

  return (
    <PopoverTrigger
      // The DESTINATION belongs in the accessible name, not just the role.
      // A bare "Host" would tell a screen-reader user what the control is
      // for while withholding the one thing it displays.
      // Named for what choosing DOES here. "Settings host" is the viewing
      // scope; a `bind` surface is choosing the host the window runs on, and
      // a screen reader that hears "Settings host" in the composer is being
      // told about a different control than the one it is on.
      aria-label={hostSwitcherLabel(props.intent, selected, triggerStatus)}
      aria-disabled={keepFocusableWhenDisabled ? true : undefined}
      disabled={props.disabled ? !keepFocusableWhenDisabled : undefined}
      onClick={
        keepFocusableWhenDisabled
          ? (event) => event.preventDefault()
          : undefined
      }
      data-testid="settings-host-switcher"
      className={cn(
        "group/host-switcher flex w-full items-center gap-3 px-3 py-2 text-start transition-colors",
        "focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
        "disabled:pointer-events-none disabled:opacity-60",
        "aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent",
        props.surface.trigger,
      )}
    >
      {/* Healthy is the default and stays silent. Only an exception status
          earns space in this compact trigger. */}
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-ui-sm font-medium",
          selected === null || props.surfaceKind === "inline"
            ? "text-muted-foreground"
            : "text-foreground",
          !props.disabled && "group-hover/host-switcher:text-foreground",
        )}
      >
        {selected === null ? "Select a host" : selected.name}
      </span>
      {triggerStatus === null ? null : (
        <span
          className="shrink-0 text-ui-xs text-muted-foreground"
          data-testid="settings-host-switcher-status"
        >
          {triggerStatus}
        </span>
      )}
      <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
    </PopoverTrigger>
  );
}

/**
 * The combobox's interaction shell around the shared row: a cmdk item, its
 * search keywords, and the assistive-tech mark for "this is the one you are
 * viewing". Everything the row SAYS lives in `HostOptionRow`, which the
 * embedded sections and the Select host dialog draw too.
 */
function HostSwitcherRow(props: {
  readonly host: HostScopeOption;
  readonly scoped: boolean;
  readonly active: boolean;
  readonly intent: HostPickIntent;
  /** This surface's own refusal for the host — see `HostSwitcher`'s prop. */
  readonly surfaceRefusal: string | null;
  /** Inert with no word on the row — see `HostSwitcher`'s `inertExceptHostId`. */
  readonly surfaceInert: boolean;
  readonly onSelect: () => void;
}): ReactNode {
  const { host } = props;
  // Resolved ONCE and used for both the disable and the word, so the two can
  // never disagree about why a row cannot be picked.
  const surfaceState = hostRowSurfaceState({
    surfaceRefusal: props.surfaceRefusal,
    surfaceInert: props.surfaceInert,
  });
  return (
    <CommandItem
      value={host.hostId}
      // One predicate, asked here exactly as the button list asks it, so a row
      // that explains why it cannot be picked is also a row that cannot be
      // picked — on both kinds of container.
      disabled={!isHostOptionSelectable(host, props.intent, surfaceState)}
      keywords={[
        host.name,
        formatPlatform(host.platform) ?? "",
        formatHostVersion(host.version) ?? "",
      ]}
      onSelect={props.onSelect}
      data-testid={`settings-host-switcher-option-${host.hostId}`}
      data-scoped={props.scoped ? "true" : "false"}
      data-checked={props.scoped ? "true" : undefined}
      // The check mark inside the row is aria-hidden and `data-scoped` reaches
      // no assistive tech, so without this a screen reader heard the scoped row
      // and every other row as the same text.
      aria-current={props.scoped ? "true" : undefined}
      className="text-ui-sm"
    >
      <HostOptionRow
        host={host}
        picked={props.scoped}
        active={props.active}
        intent={props.intent}
        surfaceState={surfaceState}
      />
    </CommandItem>
  );
}
