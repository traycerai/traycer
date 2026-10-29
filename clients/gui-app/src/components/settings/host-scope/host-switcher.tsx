import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { Badge } from "@/components/ui/badge";
import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  Settings,
  type LucideIcon,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
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
import { Button } from "@/components/ui/button";
import { HostGlyph } from "@/components/settings/host-scope/host-glyph";
import { HostOptionRow } from "@/components/settings/host-scope/host-option-row";
import {
  AVAILABLE_HOST_ROW_SURFACE_STATE,
  awakeSandboxCount,
  composerComputerSubLine,
  groupComposerHostOptions,
  groupHostOptions,
  hostOptionKindLabel,
  hostRowSurfaceState,
  hostOptionStatusWord,
  isHostOptionSelectable,
  type HostPickIntent,
  type HostRowSurfaceState,
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
import type { FleetUpdateView } from "@/lib/host/fleet-update/fleet-update-view";
import { cn } from "@/lib/utils";
import { wakeSandboxOnPick } from "@/lib/sandboxes/sandbox-wake";
import {
  splitNewRows,
  type HostSwitcherNewRow,
} from "@/components/settings/host-scope/host-switcher-new-rows";
import { UNRELEASED_FEATURES_ENABLED } from "@/unreleased-features";
import {
  IN_THIS_TASK_LABEL,
  MANAGE_SANDBOXES_IN_SETTINGS,
  NO_MATCH_ELSEWHERE_LINE,
  SANDBOXES_YOU_STARTED_LABEL,
  SEARCH_HOSTS_PLACEHOLDER,
  THIS_COMPUTER,
  YOURS_GROUP_LABEL,
  collapsedConfigurationsLabel,
  configurationLabel,
  noHostMatchesLine,
  sandboxDefiningLine,
  sandboxesYouStartedCount,
} from "@/lib/sandboxes/sandbox-strings";

/**
 * Search stops being decoration and starts being necessary somewhere around a
 * screenful of rows. Below this, a filter box is one more thing to skip past
 * on the way to a list you can already see whole. The composer and in-task
 * pickers carry it at any length: the person is mid-draft there, and the
 * keys they type on opening belong to the picker, not the draft.
 */
const SEARCH_THRESHOLD = 6;

/**
 * The trigger's accessible name. A `view` surface keeps the wording it has had
 * since it was Settings' own control; a `bind` surface says what it is.
 */
function hostSwitcherLabel(
  intent: HostPickIntent,
  name: string | null,
  status: string | null,
): string {
  const subject = intent === "view" ? "Settings host" : "Host";
  return name === null
    ? `${subject}: none selected`
    : `${subject}: ${name}${status === null ? "" : `, ${status}`}`;
}

/**
 * What a host is called on the chip and its row. The composer and in-task
 * pickers call the machine this app runs on `This computer`, its own name
 * moving to the row's sub-line, so it reads beside the sandbox rows; every
 * other list names it, and so does a build without sandboxes
 * (`unreleased-features.ts`).
 */
function hostRowTitle(host: HostScopeOption, composer: boolean): string {
  return composer && host.isLocalMachine && UNRELEASED_FEATURES_ENABLED
    ? THIS_COMPUTER
    : host.name;
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
 * The composer and new-terminal pickers' mode (sandboxes redesign D9): the
 * person's computers under `Yours`, the sandboxes they started or kept in one
 * collapsed group, a New sandbox row per configuration with a gear, and
 * `Manage sandboxes in Settings` at the foot. A pick here only STAGES: no
 * sandbox is woken or created until the first action (the send, or the
 * terminal open), so this mode never calls `wakeSandboxOnPick`. A chat's
 * host chip uses the same mode, where its `onPickHost` and `onPickNew` fork
 * the chat instead.
 */
export interface HostSwitcherComposerMode {
  readonly viewerUserId: string | null;
  /**
   * In-task pickers: the hosts the task already uses, listed first under
   * `In this task`; `null` on the landing composer.
   */
  readonly inThisTask: readonly HostScopeOption[] | null;
  /** Lines under a host row (the Local sub-line, the reach sentence). */
  readonly subLinesFor: (hostId: string) => readonly string[];
  /** The configuration tag beside an agent sandbox's title, else `null`. */
  readonly tagFor: (hostId: string) => string | null;
  readonly newRows: readonly HostSwitcherNewRow[];
  /** The configuration that heads the New group past two configurations. */
  readonly rememberedConfigurationKey: string | null;
  /** The New row that is staged, marked picked. */
  readonly stagedConfigurationKey: string | null;
  /** What the trigger reads instead of the host's name, while staged. */
  readonly stagedLabel: string | null;
  /** The staged create is running: the trigger carries a spinner. */
  readonly stagedBusy: boolean;
  /** Called with a host row's pick, before `onSelect`. */
  readonly onPickHost: (host: HostScopeOption) => void;
  readonly onPickNew: (configurationKey: string) => void;
  /** A New row's gear, or the staged chip's gear: the shape sheet. */
  readonly onOpenShape: (configurationKey: string) => void;
  readonly onManage: () => void;
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
  /**
   * `null` for a surface with nowhere to send host management - the onboarding
   * tour renders outside the app shell, so the Settings overlay it would open
   * has no surface to appear on, and a row that does nothing is worse than no
   * row. The empty-list branch then states the fact and offers no verb.
   */
  readonly action: HostSwitcherAction | null;
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
  /**
   * Resolves each row's projected update state, or `null` for a picker that
   * does not show update badges.
   *
   * `null` for three of the four callers — the landing workspace selector, the
   * header rate-limit popover, the resource monitor — because the settled
   * product decision puts fleet update state in **Settings**, and `intent` is
   * not a proxy for that (those popovers are `view` surfaces too). Only
   * `SettingsSidebar` passes a resolver.
   *
   * Passing the RESOLVER rather than a flag is what keeps this honest: a
   * surface can only badge state it already has, so no picker can turn badges
   * on and reach for a per-row query to feed them — which is the "Settings
   * does not silently connect to other hosts to improve their badges" rule.
   */
  readonly updateViewForHost: ((hostId: string) => FleetUpdateView) | null;
  /**
   * The composer and new-terminal pickers' mode, or `null` for every other
   * list. See `HostSwitcherComposerMode`.
   */
  readonly composer: HostSwitcherComposerMode | null;
  /**
   * Resolves each row's environment label (Tracy Bots), or `null` for a
   * picker that does not say. Settings' host list is the one caller: the
   * environment is changed there, so it is read there. Same shape as
   * `updateViewForHost`, for the same reason - a resolver, never a flag.
   */
  readonly environmentLabelForHost: ((hostId: string) => string | null) | null;
}): ReactNode {
  const [open, setOpenState] = useState(false);
  const [search, setSearch] = useState("");
  // The search lives outside the popover's content, so it outlives a close:
  // cleared on every close (dismiss, pick or action), or reopening would
  // restore the old filter and greet the user with "No hosts match".
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) setSearch("");
  };
  const { contentRef, onOpenAutoFocus: coarseOpenAutoFocus } =
    useCoarsePointerOpenAutoFocus();
  const binding = useHostBinding();
  useRefreshHostDirectoryOnOpen(open, binding?.directory ?? null);
  const { hosts, selected } = props;
  // Resolved once, as one value, so the two render sites below narrow on a
  // local rather than on a prop a closure cannot keep narrowed.
  const trailingAction = hostSwitcherTrailingAction(
    props.action,
    props.composer,
  );
  const surface = HOST_SWITCHER_SURFACES[props.surface];
  const showSearch = hostSwitcherShowsSearch(hosts, props.composer);

  // The empty state keys on the LIST, not on the selection.
  //
  // Keying it on `selected === null` conflated two opposite situations: "you
  // own no hosts" and "the host you were viewing was deregistered". The second
  // one still has hosts, and this early return replaced the picker with a dead
  // div — removing the only way back to a working host, and taking Settings'
  // `Add host…` with it, since that footer is its sole opener. So the one moment
  // a person most needs the picker was the one moment it disappeared.
  if (hosts.length === 0 && props.composer === null) {
    return (
      <HostSwitcherEmptyList
        listsFailed={props.listsFailed}
        isLoading={props.isLoading}
        onRetryLists={props.onRetryLists}
        trailingAction={trailingAction}
      />
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <HostSwitcherTrigger
          intent={props.intent}
          selected={selected}
          disabled={props.disabled}
          keepFocusableWhenDisabled={props.keepFocusableWhenDisabled}
          surfaceKind={props.surface}
          surface={surface}
          composer={props.composer}
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
            "w-[min(90vw,20rem)] min-w-[var(--radix-popover-trigger-width)] max-w-[var(--radix-popover-content-available-width)]",
            surface.list,
          )}
          data-testid="settings-host-switcher-list"
          {...{ [HOST_SWITCHER_LIST_ATTRIBUTE]: "true" }}
          ref={contentRef}
          // Only the search input is worth declining for; below the threshold
          // there is no input and Radix's default lands on a host row, which
          // summons nothing.
          onOpenAutoFocus={showSearch ? coarseOpenAutoFocus : undefined}
          // The list is portalled, but React still bubbles its keys up the
          // tree it was mounted from: a composer above this picker would
          // take the search's keystrokes (an Enter that picks a row would
          // also send the draft).
          onKeyDown={(event) => event.stopPropagation()}
        >
          <Command
            filter={props.composer === null ? undefined : composerSearchFilter}
          >
            {showSearch ? (
              <CommandInput
                placeholder={SEARCH_HOSTS_PLACEHOLDER}
                value={search}
                onValueChange={setSearch}
              />
            ) : null}
            <CommandList>
              {/* The composer's New rows never filter out, so its no-match
                  line is drawn by its groups instead. */}
              {props.composer === null ? (
                <CommandEmpty>No hosts match.</CommandEmpty>
              ) : null}
              <HostSwitcherGroups
                hosts={hosts}
                action={props.action}
                composer={props.composer}
                onPickNew={(configurationKey) => {
                  props.composer?.onPickNew(configurationKey);
                  setOpen(false);
                }}
                onOpenShape={(configurationKey) => {
                  setOpen(false);
                  props.composer?.onOpenShape(configurationKey);
                }}
                searching={search.length > 0}
                search={search}
                renderRow={(host) => (
                  <HostSwitcherRow
                    key={host.hostId}
                    host={host}
                    scoped={
                      selected !== null && host.hostId === selected.hostId
                    }
                    active={host.hostId === props.activeHostId}
                    intent={props.intent}
                    surfaceRefusal={
                      props.refusalByHostId.get(host.hostId) ?? null
                    }
                    surfaceInert={
                      props.inertExceptHostId !== null &&
                      host.hostId !== props.inertExceptHostId
                    }
                    updateView={props.updateViewForHost?.(host.hostId) ?? null}
                    environmentLabel={
                      props.environmentLabelForHost?.(host.hostId) ?? null
                    }
                    composer={props.composer !== null}
                    subLines={hostSubLines(props.composer, host.hostId)}
                    tag={
                      props.composer === null
                        ? null
                        : props.composer.tagFor(host.hostId)
                    }
                    onSelect={() => {
                      pickHostRow(props.composer, props.intent, host);
                      props.onSelect(host.hostId);
                      setOpen(false);
                    }}
                  />
                )}
                selected={selected}
              />
              {trailingAction === null ? null : (
                // The composer's footer stays under a search that matched
                // nothing: it is where the rest are.
                <CommandGroup forceMount={props.composer !== null}>
                  <CommandItem
                    forceMount={props.composer !== null}
                    value={trailingAction.commandValue}
                    keywords={[...trailingAction.keywords]}
                    onSelect={() => {
                      setOpen(false);
                      trailingAction.onSelect();
                    }}
                    data-testid={trailingAction.testId}
                  >
                    <trailingAction.icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-ui-sm">
                      {trailingAction.label}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>
          {/* The same "a FAILED list is not an empty account" rule, at its third
            consumer — the non-empty case. When one source list fails while the
            other still contributes rows, `hosts` is nonempty, so the empty
            branch above never runs and nothing said the picture was partial:
            the sidebar presented half an account as all of it. The rows stay
            usable; this footer says what is missing and offers the retry. */}
          {/* Rows can be listed while a list is still on its first read (a
            sandbox list withholds its rows until it answers): say more are
            coming, so the rows shown do not read as the whole account. */}
          {props.isLoading ? (
            <div
              className="flex items-center gap-2 border-t border-border/60 px-3 py-2"
              data-testid="settings-host-switcher-loading-more"
            >
              <AgentSpinningDots
                className={undefined}
                testId={undefined}
                variant={undefined}
                tone="muted"
              />
              <span className="text-ui-xs text-muted-foreground">
                Loading more hosts…
              </span>
            </div>
          ) : null}
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
      <HostSwitcherStagedGear
        composer={props.composer}
        disabled={props.disabled}
      />
    </>
  );
}

/** Whether the list opens with its search field: see `SEARCH_THRESHOLD`. */
function hostSwitcherShowsSearch(
  hosts: readonly HostScopeOption[],
  composer: HostSwitcherComposerMode | null,
): boolean {
  return composer !== null || hosts.length >= SEARCH_THRESHOLD;
}

/** Item values the composer's search never filters out: New rows, the footer. */
const COMPOSER_UNFILTERED_PREFIXES = ["new-sandbox:", "action:"] as const;

/**
 * Whether a composer host row matches a search: its title or its name
 * contains the term, ignoring case. Partial terms narrow (`p2` keeps
 * `e2e-sbx-p2` alone), unlike cmdk's scattered-letter scoring.
 */
function composerHostMatches(host: HostScopeOption, term: string): boolean {
  const needle = term.trim().toLocaleLowerCase();
  if (needle.length === 0) return true;
  return [hostRowTitle(host, true), host.name].some((text) =>
    text.toLocaleLowerCase().includes(needle),
  );
}

/**
 * The composer list's cmdk filter. A host row's first two keywords are its
 * title and name (see `HostSwitcherRow`), which `composerHostMatches` reads.
 */
function composerSearchFilter(
  value: string,
  search: string,
  keywords: string[] | undefined,
): number {
  if (COMPOSER_UNFILTERED_PREFIXES.some((prefix) => value.startsWith(prefix))) {
    return 1;
  }
  const needle = search.trim().toLocaleLowerCase();
  if (needle.length === 0) return 1;
  return (keywords ?? [])
    .slice(0, 2)
    .some((text) => text.toLocaleLowerCase().includes(needle))
    ? 1
    : 0;
}

/** The composer's empty search: no host of yours, and where the rest are. */
function HostSwitcherNoMatch(props: { readonly search: string }): ReactNode {
  return (
    <div
      className="flex flex-col gap-0.5 px-2 py-3 text-center text-ui-sm text-muted-foreground"
      data-testid="host-switcher-composer-no-match"
    >
      <span>{noHostMatchesLine(props.search.trim())}</span>
      <span className="text-ui-xs">{NO_MATCH_ELSEWHERE_LINE}</span>
    </div>
  );
}

function hostSubLines(
  composer: HostSwitcherComposerMode | null,
  hostId: string,
): readonly string[] {
  return composer === null ? [] : composer.subLinesFor(hostId);
}

/**
 * A row's pick before the selection is written: a composer pick only
 * stages (the first action wakes); a `pin` or `bind` pick of a sleeping
 * sandbox wakes it.
 */
function pickHostRow(
  composer: HostSwitcherComposerMode | null,
  intent: HostPickIntent,
  host: HostScopeOption,
): void {
  if (composer !== null) {
    composer.onPickHost(host);
    return;
  }
  if (intent !== "view") wakeSandboxOnPick(host, null);
}

/** The staged New row's gear beside the trigger: the shape sheet. */
function HostSwitcherStagedGear(props: {
  readonly composer: HostSwitcherComposerMode | null;
  readonly disabled: boolean;
}): ReactNode {
  const { composer } = props;
  if (composer === null || composer.stagedConfigurationKey === null) {
    return null;
  }
  const configurationKey = composer.stagedConfigurationKey;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      aria-label="Change the staged sandbox's shape"
      data-testid="host-switcher-staged-gear"
      disabled={props.disabled || composer.stagedBusy}
      onClick={() => composer.onOpenShape(configurationKey)}
    >
      <Settings aria-hidden />
    </Button>
  );
}

/** The picker's place when the account lists no host: why, and what to do. */
function HostSwitcherEmptyList(props: {
  readonly listsFailed: boolean;
  readonly isLoading: boolean;
  readonly onRetryLists: () => void;
  readonly trailingAction:
    | (HostSwitcherActionPresentation & { readonly onSelect: () => void })
    | null;
}): ReactNode {
  const { trailingAction } = props;
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
      {props.isLoading || trailingAction === null ? null : (
        <button
          type="button"
          onClick={trailingAction.onSelect}
          className="inline-flex items-center gap-1.5 self-start rounded-md px-1 py-0.5 text-ui-xs text-primary transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          data-testid={trailingAction.emptyTestId}
        >
          <trailingAction.icon className="size-3.5 shrink-0" />
          {trailingAction.label}
        </button>
      )}
    </div>
  );
}

/**
 * The list's ending: the caller's action, or the composer's Manage row. A
 * build without sandboxes (`unreleased-features.ts`) has no Sandboxes page
 * for that row to open, so the composer's list ends with its hosts.
 */
function hostSwitcherTrailingAction(
  action: HostSwitcherAction | null,
  composer: HostSwitcherComposerMode | null,
): (HostSwitcherActionPresentation & { readonly onSelect: () => void }) | null {
  if (composer !== null && UNRELEASED_FEATURES_ENABLED) {
    return {
      label: MANAGE_SANDBOXES_IN_SETTINGS,
      icon: Settings,
      commandValue: "action:manage-sandboxes",
      keywords: ["manage", "settings", "sandboxes", "sandbox"],
      testId: "host-switcher-manage-sandboxes",
      emptyTestId: "host-switcher-empty-manage-sandboxes",
      onSelect: composer.onManage,
    };
  }
  if (action === null) return null;
  return { ...HOST_SWITCHER_ACTIONS[action.kind], onSelect: action.onSelect };
}

/**
 * The list's host groups: personal hosts under "Host", then the user's
 * sandboxes in a collapsible group below them, then (host list only) the
 * agent-created burst sandboxes in a sub-group that starts collapsed, then
 * one group per team the person is in, named for the team, each with its own
 * collapsed agent sub-group. A search opens every group, so a match is never
 * hidden behind a closed one. The composer mode draws its own groups.
 */
function HostSwitcherGroups(props: {
  readonly hosts: readonly HostScopeOption[];
  readonly action: HostSwitcherAction | null;
  readonly composer: HostSwitcherComposerMode | null;
  readonly onPickNew: (configurationKey: string) => void;
  readonly onOpenShape: (configurationKey: string) => void;
  readonly searching: boolean;
  readonly search: string;
  readonly selected: HostScopeOption | null;
  readonly renderRow: (host: HostScopeOption) => ReactNode;
}): ReactNode {
  if (props.composer !== null) {
    return (
      <HostSwitcherComposerGroups
        hosts={props.hosts}
        composer={props.composer}
        onPickNew={props.onPickNew}
        onOpenShape={props.onOpenShape}
        searching={props.searching}
        search={props.search}
        selected={props.selected}
        renderRow={props.renderRow}
      />
    );
  }
  const groups = groupHostOptions(
    props.hosts,
    // Settings' list is the account's HOST LIST, and the only switcher that
    // owns Add host: it shows every sandbox, burst ones included, under their
    // own collapsed group. Every other surface is a picker and offers no burst
    // sandbox.
    props.action?.kind === "add-host",
    null,
    props.selected?.hostId ?? null,
  );
  return (
    <>
      {groups.personal.length === 0 ? null : (
        <CommandGroup heading="Host">
          {groups.personal.map(props.renderRow)}
        </CommandGroup>
      )}
      {groups.sandboxes.length === 0 ? null : (
        <HostSwitcherSandboxGroup
          title="Sandboxes"
          countLabel={String(groups.sandboxes.length)}
          defaultOpen
          forceOpen={props.searching}
          testId="settings-host-switcher-sandboxes"
        >
          {groups.sandboxes.map(props.renderRow)}
        </HostSwitcherSandboxGroup>
      )}
      {groups.agentSandboxes.length === 0 ? null : (
        <HostSwitcherSandboxGroup
          title="Agent sandboxes"
          countLabel={String(groups.agentSandboxes.length)}
          defaultOpen={false}
          forceOpen={props.searching}
          testId="settings-host-switcher-agent-sandboxes"
        >
          {groups.agentSandboxes.map(props.renderRow)}
        </HostSwitcherSandboxGroup>
      )}
      {groups.teams.map((team) => (
        <HostSwitcherSandboxGroup
          key={team.teamId}
          title={team.teamName}
          countLabel={String(
            team.sandboxes.length + team.agentSandboxes.length,
          )}
          defaultOpen
          forceOpen={props.searching}
          testId={`settings-host-switcher-team-${team.teamId}`}
        >
          {team.sandboxes.map(props.renderRow)}
          {team.agentSandboxes.length === 0 ? null : (
            <HostSwitcherCollapsible
              title="Agent sandboxes"
              countLabel={String(team.agentSandboxes.length)}
              defaultOpen={false}
              forceOpen={props.searching}
              testId={`settings-host-switcher-team-${team.teamId}-agent-sandboxes`}
            >
              {team.agentSandboxes.map(props.renderRow)}
            </HostSwitcherCollapsible>
          )}
        </HostSwitcherSandboxGroup>
      ))}
    </>
  );
}

/**
 * The composer mode's groups: `In this task` (in-task pickers), `Yours`,
 * `Sandboxes you started` collapsed behind its count, then the New sandbox
 * group headed by the defining line.
 */
function HostSwitcherComposerGroups(props: {
  readonly hosts: readonly HostScopeOption[];
  readonly composer: HostSwitcherComposerMode;
  readonly onPickNew: (configurationKey: string) => void;
  readonly onOpenShape: (configurationKey: string) => void;
  readonly searching: boolean;
  readonly search: string;
  readonly selected: HostScopeOption | null;
  readonly renderRow: (host: HostScopeOption) => ReactNode;
}): ReactNode {
  const { composer } = props;
  const inTask = composer.inThisTask ?? [];
  const inTaskIds = new Set(inTask.map((host) => host.hostId));
  const groups = groupComposerHostOptions(
    props.hosts,
    { userId: composer.viewerUserId },
    props.selected?.hostId ?? null,
  );
  // A host the task already uses is listed once, under In this task.
  const yours = groups.yours.filter((host) => !inTaskIds.has(host.hostId));
  const started = groups.started.filter((host) => !inTaskIds.has(host.hostId));
  const noHostMatches =
    props.search.trim().length > 0 &&
    ![...inTask, ...yours, ...started].some((host) =>
      composerHostMatches(host, props.search),
    );
  return (
    <>
      {noHostMatches ? <HostSwitcherNoMatch search={props.search} /> : null}
      {inTask.length === 0 ? null : (
        <CommandGroup
          heading={IN_THIS_TASK_LABEL}
          data-testid="host-switcher-in-this-task"
        >
          {inTask.map(props.renderRow)}
        </CommandGroup>
      )}
      {yours.length === 0 ? null : (
        <CommandGroup
          heading={YOURS_GROUP_LABEL}
          data-testid="host-switcher-yours"
        >
          {yours.map(props.renderRow)}
        </CommandGroup>
      )}
      {started.length === 0 ? null : (
        <HostSwitcherSandboxGroup
          title={SANDBOXES_YOU_STARTED_LABEL}
          countLabel={sandboxesYouStartedCount(
            started.length,
            awakeSandboxCount(started),
          )}
          defaultOpen={false}
          forceOpen={props.searching}
          testId="host-switcher-sandboxes-you-started"
        >
          {started.map(props.renderRow)}
        </HostSwitcherSandboxGroup>
      )}
      <HostSwitcherNewGroup
        rows={composer.newRows}
        rememberedConfigurationKey={composer.rememberedConfigurationKey}
        stagedConfigurationKey={composer.stagedConfigurationKey}
        searching={props.searching}
        onPickNew={props.onPickNew}
        onOpenShape={props.onOpenShape}
      />
    </>
  );
}

/**
 * The New sandbox group: one row per configuration while there are one or
 * two; past two, the remembered configuration's row and the rest behind a
 * collapsible that counts and names them (`4 teams: …`), the same affordance
 * as Sandboxes you started.
 */
function HostSwitcherNewGroup(props: {
  readonly rows: readonly HostSwitcherNewRow[];
  readonly rememberedConfigurationKey: string | null;
  readonly stagedConfigurationKey: string | null;
  readonly searching: boolean;
  readonly onPickNew: (configurationKey: string) => void;
  readonly onOpenShape: (configurationKey: string) => void;
}): ReactNode {
  if (props.rows.length === 0) return null;
  const renderNewRow = (row: HostSwitcherNewRow): ReactNode => (
    <HostSwitcherNewSandboxRow
      key={row.configurationKey}
      row={row}
      picked={row.configurationKey === props.stagedConfigurationKey}
      onPick={props.onPickNew}
      onOpenShape={props.onOpenShape}
    />
  );
  const { head, rest } = splitNewRows(
    props.rows,
    props.rememberedConfigurationKey,
  );
  return (
    <CommandGroup
      heading={sandboxDefiningLine()}
      data-testid="host-switcher-new-sandbox"
    >
      {head.map(renderNewRow)}
      {rest.length === 0 ? null : (
        <HostSwitcherCollapsible
          title={collapsedConfigurationsLabel(
            rest.map((row) => row.configuration),
          )}
          countLabel={null}
          defaultOpen={false}
          forceOpen={props.searching}
          testId="host-switcher-new-sandbox-more"
        >
          {rest.map(renderNewRow)}
        </HostSwitcherCollapsible>
      )}
    </CommandGroup>
  );
}

/** A New row: picking it stages; its gear opens the shape sheet. */
function HostSwitcherNewSandboxRow(props: {
  readonly row: HostSwitcherNewRow;
  readonly picked: boolean;
  readonly onPick: (configurationKey: string) => void;
  readonly onOpenShape: (configurationKey: string) => void;
}): ReactNode {
  const { row } = props;
  return (
    <CommandItem
      value={`new-sandbox:${row.configurationKey}`}
      keywords={[
        "new sandbox",
        configurationLabel(row.configuration),
        row.label,
      ]}
      onSelect={() => props.onPick(row.configurationKey)}
      disabled={row.disabled}
      data-testid={`host-switcher-new-sandbox-${row.configurationKey}`}
      data-checked={props.picked ? "true" : undefined}
      aria-current={props.picked ? "true" : undefined}
    >
      <Plus className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-ui-sm wrap-break-word">{row.label}</span>
        <span className="text-ui-xs text-muted-foreground wrap-break-word">
          {row.subLine}
        </span>
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Shape of ${row.label}`}
        data-testid={`host-switcher-new-sandbox-gear-${row.configurationKey}`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          props.onOpenShape(row.configurationKey);
        }}
      >
        <Settings aria-hidden />
      </Button>
    </CommandItem>
  );
}

function HostSwitcherSandboxGroup(props: {
  readonly title: string;
  readonly countLabel: string;
  readonly defaultOpen: boolean;
  readonly forceOpen: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <CommandGroup>
      <HostSwitcherCollapsible
        title={props.title}
        countLabel={props.countLabel}
        defaultOpen={props.defaultOpen}
        forceOpen={props.forceOpen}
        testId={props.testId}
      >
        {props.children}
      </HostSwitcherCollapsible>
    </CommandGroup>
  );
}

/**
 * A collapsible titled run of rows. Not a `CommandGroup` itself, so a team's
 * agent sub-group can sit inside the team's group.
 */
function HostSwitcherCollapsible(props: {
  readonly title: string;
  /** `null` where the title counts for itself. */
  readonly countLabel: string | null;
  readonly defaultOpen: boolean;
  readonly forceOpen: boolean;
  readonly testId: string;
  readonly children: ReactNode;
}): ReactNode {
  const [open, setOpen] = useState(props.defaultOpen);
  const expanded = open || props.forceOpen;
  return (
    <Collapsible
      open={expanded}
      onOpenChange={setOpen}
      className="flex flex-col"
      data-testid={props.testId}
    >
      <CollapsibleTrigger
        variant="quiet"
        className="flex w-full items-center text-ui-xs font-medium"
        data-testid={`${props.testId}-toggle`}
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" aria-hidden />
        )}
        {/* Wraps rather than truncates: a cut list of names reads as more
            of them than there are. */}
        <span className="min-w-0 flex-1 text-start wrap-break-word">
          {props.title}
        </span>
        {props.countLabel === null ? null : (
          <span className="shrink-0 tabular-nums">{props.countLabel}</span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>{props.children}</CollapsibleContent>
    </Collapsible>
  );
}

/**
 * What the trigger reads. A staged pick names what the first action will
 * create or wake, in place of the host the composer resolves to until then.
 */
function hostSwitcherTriggerText(
  intent: HostPickIntent,
  selected: HostScopeOption | null,
  composer: HostSwitcherComposerMode | null,
): {
  readonly label: string;
  readonly ariaLabel: string;
  readonly status: string | null;
} {
  const stagedLabel = composer === null ? null : composer.stagedLabel;
  if (stagedLabel !== null) {
    return {
      label: stagedLabel,
      ariaLabel: `Host: ${stagedLabel}`,
      status: null,
    };
  }
  const status =
    selected === null
      ? null
      : hostOptionStatusWord(selected, AVAILABLE_HOST_ROW_SURFACE_STATE);
  const name =
    selected === null ? null : hostRowTitle(selected, composer !== null);
  return {
    label: name ?? "Select a host",
    ariaLabel: hostSwitcherLabel(intent, name, status),
    status,
  };
}

/** The staged create is running: a spinner in the trigger. */
function HostSwitcherStagedBusy(props: {
  readonly composer: HostSwitcherComposerMode | null;
}): ReactNode {
  if (props.composer === null || !props.composer.stagedBusy) return null;
  return (
    <AgentSpinningDots
      className={undefined}
      testId="host-switcher-staged-busy"
      variant={undefined}
      tone="muted"
    />
  );
}

function HostSwitcherTrigger(props: {
  readonly intent: HostPickIntent;
  readonly selected: HostScopeOption | null;
  readonly disabled: boolean;
  readonly keepFocusableWhenDisabled?: boolean;
  readonly surfaceKind: HostSwitcherSurface;
  readonly surface: HostSwitcherSurfacePresentation;
  readonly composer: HostSwitcherComposerMode | null;
}): ReactNode {
  const { selected } = props;
  const text = hostSwitcherTriggerText(props.intent, selected, props.composer);
  const triggerStatus = text.status;
  const keepFocusableWhenDisabled =
    props.disabled && props.keepFocusableWhenDisabled === true;

  return (
    <PopoverTrigger asChild>
      <Button
        type="button"
        variant="ghost"
        // The DESTINATION belongs in the accessible name, not just the role.
        // A bare "Host" would tell a screen-reader user what the control is
        // for while withholding the one thing it displays.
        // Named for what choosing DOES here. "Settings host" is the viewing
        // scope; a `bind` surface is choosing the host the window runs on, and
        // a screen reader that hears "Settings host" in the composer is being
        // told about a different control than the one it is on.
        aria-label={text.ariaLabel}
        aria-disabled={keepFocusableWhenDisabled ? true : undefined}
        disabled={props.disabled ? !keepFocusableWhenDisabled : undefined}
        onClick={
          keepFocusableWhenDisabled
            ? (event: React.MouseEvent<HTMLButtonElement>) =>
                event.preventDefault()
            : undefined
        }
        data-testid="settings-host-switcher"
        className={cn(
          "group/host-switcher h-auto w-full justify-start gap-3 px-3 py-2 text-start",
          "aria-disabled:cursor-not-allowed aria-disabled:opacity-60 aria-disabled:hover:bg-transparent",
          props.surface.trigger,
        )}
      >
        <HostSwitcherStagedBusy composer={props.composer} />
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
          {text.label}
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
      </Button>
    </PopoverTrigger>
  );
}

/** The shared row, with any lines the surface puts under it. */
function HostSwitcherOptionRow(props: {
  readonly host: HostScopeOption;
  readonly picked: boolean;
  readonly active: boolean;
  readonly intent: HostPickIntent;
  readonly surfaceState: HostRowSurfaceState;
  readonly updateView: FleetUpdateView | null;
  readonly environmentLabel: string | null;
  /** The composer and in-task pickers: the title wraps, never cut. */
  readonly composer: boolean;
  readonly subLines: readonly string[];
  readonly tag: string | null;
}): ReactNode {
  const tag =
    props.tag === null ? null : (
      <Badge size="xs" variant="muted" data-testid="host-switcher-row-tag">
        {props.tag}
      </Badge>
    );
  const row = (
    <HostOptionRow
      host={props.host}
      picked={props.picked}
      active={props.active}
      intent={props.intent}
      surfaceState={props.surfaceState}
      updateView={props.updateView}
      nameRef={null}
      nameWraps={props.composer}
      environmentLabel={props.environmentLabel}
    />
  );
  if (props.subLines.length === 0) {
    return (
      <>
        {row}
        {tag}
      </>
    );
  }
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        {row}
        {tag}
      </span>
      {props.subLines.map((line) => (
        <span
          key={line}
          className="ps-6 text-ui-xs whitespace-normal text-muted-foreground"
        >
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * A computer in the composer and in-task pickers: its title, then what it is
 * and whether it answers on the line below, which is where its status is
 * said (so the title carries no status word beside it).
 */
function ComposerComputerRow(props: {
  readonly host: HostScopeOption;
  readonly title: string;
  readonly subLines: readonly string[];
}): ReactNode {
  return (
    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-2">
        <HostGlyph
          host={props.host}
          className="size-4 shrink-0 text-muted-foreground"
        />
        {/* A title that already says what it is (`This computer`) is not
            announced twice. */}
        {props.title === hostOptionKindLabel(props.host) ? null : (
          <span className="sr-only">{hostOptionKindLabel(props.host)}</span>
        )}
        <span className="min-w-0 flex-1 text-start wrap-break-word">
          {props.title}
        </span>
      </span>
      {props.subLines.map((line) => (
        <span
          key={line}
          className="ps-6 text-ui-xs whitespace-normal text-muted-foreground"
        >
          {line}
        </span>
      ))}
    </span>
  );
}

/**
 * The combobox's interaction shell around the shared row: a cmdk item, its
 * search keywords, and the assistive-tech mark for "this is the one you are
 * viewing". Everything the row SAYS lives in `HostOptionRow`, which the
 * embedded sections and the Select host dialog draw too, except a computer's
 * in the composer and in-task pickers (`ComposerComputerRow`).
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
  /** This row's projected update state, or `null` for a non-badging picker. */
  readonly updateView: FleetUpdateView | null;
  /** This row's environment label, or `null` for a picker that does not say. */
  readonly environmentLabel: string | null;
  /** The composer and in-task pickers: a computer row says what it is below its title. */
  readonly composer: boolean;
  /** Lines under the row (the composer's Local sub-line, the reach sentence). */
  readonly subLines: readonly string[];
  /** The composer's configuration tag beside the title, or `null`. */
  readonly tag: string | null;
  readonly onSelect: () => void;
}): ReactNode {
  const { host } = props;
  // Resolved ONCE and used for both the disable and the word, so the two can
  // never disagree about why a row cannot be picked.
  const surfaceState = hostRowSurfaceState({
    surfaceRefusal: props.surfaceRefusal,
    surfaceInert: props.surfaceInert,
  });
  const selectable = isHostOptionSelectable(host, props.intent, surfaceState);
  const title = hostRowTitle(host, props.composer);
  return (
    <CommandItem
      value={host.hostId}
      // One predicate, asked here exactly as the button list asks it, so a row
      // that explains why it cannot be picked is also a row that cannot be
      // picked — on both kinds of container.
      disabled={!selectable}
      keywords={[
        title,
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
    >
      {props.composer && host.sandbox === null ? (
        <ComposerComputerRow
          host={host}
          title={title}
          subLines={[
            composerComputerSubLine(host, selectable, title !== host.name),
            ...props.subLines,
          ]}
        />
      ) : (
        <HostSwitcherOptionRow
          host={host}
          picked={props.scoped}
          active={props.active}
          intent={props.intent}
          surfaceState={surfaceState}
          updateView={props.updateView}
          environmentLabel={props.environmentLabel}
          composer={props.composer}
          subLines={props.subLines}
          tag={props.tag}
        />
      )}
    </CommandItem>
  );
}
