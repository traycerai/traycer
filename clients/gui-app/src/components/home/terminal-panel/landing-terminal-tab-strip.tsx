import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  Globe,
  Pencil,
  Plus,
  SquareDashed,
  TerminalSquare,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
import {
  useInlineRename,
  type InlineRenameInputProps,
} from "@/hooks/ui/use-inline-rename";
import { registerPrimaryFocusEndpoint } from "@/lib/focus/primary-focus-coordinator";
import { cn } from "@/lib/utils";
import type {
  LandingPanelPlaceholder,
  LandingPanelTabRef,
} from "@/stores/home/landing-panel-store";
import type { PlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";
import {
  LANDING_BROWSER_UNWATCHED_TOOLTIP,
  type LandingBrowserViewModel,
} from "./landing-browser-presentation";
import { landingStripRows } from "./landing-strip-rows";

export interface LandingTerminalTabStripProps {
  readonly tabs: ReadonlyArray<LandingPanelTabRef>;
  /**
   * The unpicked "New tab" row, rendered at its own index among {@link tabs}.
   * `null` when there is none.
   */
  readonly placeholder: LandingPanelPlaceholder | null;
  readonly activeInstanceId: string | null;
  /**
   * The "+" and the empty-strip double-click open the CHOOSER, which is
   * reachable whatever the devices are doing - a device that cannot start a
   * terminal can still open a browser, and the chooser is where a refusal can
   * say which half it applies to. So neither affordance is gated any more, and
   * this is a plain tooltip.
   */
  readonly addTooltip: string;
  readonly onAdd: () => void;
  readonly onActivate: (instanceId: string) => void;
  readonly onClose: (tab: LandingPanelTabRef) => void;
  /** The placeholder's own "×": there is no tab to close, only a pick to drop. */
  readonly onDismissPlaceholder: () => void;
  readonly onCloseAll: () => void;
  readonly onRename: (instanceId: string, name: string) => void;
  readonly canRename: (tab: LandingPanelTabRef) => boolean;
  readonly terminalViewModels: Readonly<
    Partial<Record<string, PlainTerminalViewModel>>
  >;
  readonly browserViewModels: Readonly<
    Partial<Record<string, LandingBrowserViewModel>>
  >;
}

/**
 * Presentational, scrollable terminal tab strip mirroring epic tab chrome.
 *
 * Layout follows the header `TabStrip`: the scroller and the "+" share a
 * `flex-[0_1_auto]` wrapper, so "+" trails the last tab directly and only
 * parks against the right edge once the tabs fill the strip. The leftover
 * strip space is empty background - double-clicking it opens a terminal, the
 * same gesture the header strip uses for a new tab.
 */
export function LandingTerminalTabStrip(
  props: LandingTerminalTabStripProps,
): ReactNode {
  const { onAdd } = props;
  const handleStripDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    // Only the empty strip background opens a new tab. A double-click that
    // lands on a tab (or on the "+"/close buttons, whose own click handler
    // already fired twice) must not open a second one.
    if (
      event.target instanceof Element &&
      event.target.closest('[role="tab"], button') !== null
    ) {
      return;
    }
    onAdd();
  };
  return (
    <div
      data-testid="landing-terminal-tab-strip"
      className="relative flex h-9 shrink-0 items-stretch border-b border-canvas-border/70 bg-canvas"
      onDoubleClick={handleStripDoubleClick}
    >
      <div className="flex min-w-0 max-w-full flex-[0_1_auto] items-stretch">
        <div className="no-scrollbar flex min-w-0 max-w-full flex-[0_1_auto] items-stretch overflow-x-auto overscroll-x-contain">
          {landingStripRows(props.tabs, props.placeholder).map((row) =>
            row.kind === "placeholder" ? (
              <LandingPlaceholderTab
                key={row.placeholder.instanceId}
                instanceId={row.placeholder.instanceId}
                active={row.placeholder.instanceId === props.activeInstanceId}
                onActivate={props.onActivate}
                onDismiss={props.onDismissPlaceholder}
                onCloseAll={props.onCloseAll}
              />
            ) : (
              <LandingPanelTab
                key={row.tab.instanceId}
                tab={row.tab}
                active={row.tab.instanceId === props.activeInstanceId}
                onActivate={props.onActivate}
                onClose={props.onClose}
                onCloseAll={props.onCloseAll}
                onRename={props.onRename}
                canRename={props.canRename(row.tab)}
                row={landingPanelRowFor({
                  tab: row.tab,
                  terminal:
                    props.terminalViewModels[row.tab.instanceId] ?? null,
                  browser: props.browserViewModels[row.tab.instanceId] ?? null,
                })}
              />
            ),
          )}
        </div>
        <div className="flex shrink-0 items-center px-1">
          <NewTabButton tooltip={props.addTooltip} onAdd={onAdd} />
        </div>
      </div>
    </div>
  );
}

/**
 * The strip's "+" affordance, which opens the chooser.
 *
 * It carries a tooltip but is never disabled: the chooser is what knows whether
 * either kind can be started, and it says so per card. The button previously
 * gated on the terminal create reason, which would now hide the browser the
 * device can perfectly well open.
 */
function NewTabButton(props: {
  readonly tooltip: string;
  readonly onAdd: () => void;
}): ReactNode {
  const { onAdd } = props;
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(
    () =>
      registerPrimaryFocusEndpoint(
        { kind: "landing-terminal-new-tab" },
        {
          focus: () => buttonRef.current?.focus(),
          containsActiveElement: (activeElement) =>
            activeElement === buttonRef.current,
          isEligible: () => buttonRef.current !== null,
        },
      ),
    [],
  );
  return (
    <TooltipWrapper
      label={props.tooltip}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <Button
        ref={buttonRef}
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="New tab"
        data-testid="landing-terminal-new-tab"
        onClick={onAdd}
      >
        <Plus className="size-4" />
      </Button>
    </TooltipWrapper>
  );
}

/**
 * The "New tab" row: a real strip entry the user can activate, close, or switch
 * away from, whose body is the chooser. It has no rename and no view model -
 * there is nothing yet to name.
 */
function LandingPlaceholderTab(props: {
  readonly instanceId: string;
  readonly active: boolean;
  readonly onActivate: (instanceId: string) => void;
  readonly onDismiss: () => void;
  readonly onCloseAll: () => void;
}): ReactNode {
  const { active, instanceId, onActivate } = props;
  const tabRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);
  return (
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          ref={tabRef}
          role="tab"
          aria-label="New tab"
          aria-selected={active}
          tabIndex={0}
          data-testid={`landing-terminal-tab-${instanceId}`}
          onClick={() => onActivate(instanceId)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onActivate(instanceId);
          }}
          className={cn(
            "group relative flex min-w-0 shrink-0 items-center gap-1.5 border-r border-canvas-border/70 px-3 text-ui-sm text-muted-foreground outline-hidden transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
            "max-w-[45vw]",
            active &&
              "bg-(--app-background) text-foreground shadow-[inset_0_-1px_0_var(--color-background)] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary",
          )}
        >
          <SquareDashed className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">New tab</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close New tab"
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              props.onDismiss();
            }}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem onSelect={props.onDismiss}>Close</ContextMenuItem>
        <ContextMenuItem onSelect={props.onCloseAll}>Close All</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/**
 * One row's rendered facts, resolved from whichever authority owns its kind.
 *
 * The two kinds share the row chrome - selection, rename, close, context menu,
 * scroll-into-view - and differ only in these fields and the icon, so they are
 * flattened here rather than branched inside the row. A row that reached for
 * its own authority would be the third place that decides what a browser tab
 * is called.
 */
interface LandingPanelRowModel {
  readonly displayName: string;
  /** The row's tooltip and the tail of its aria-label: a cwd, or an address. */
  readonly detail: string | null;
  /** `· <process>` on a renamed terminal. Browsers have no counterpart. */
  readonly processName: string | null;
  readonly isDormant: boolean;
  readonly isRuntimeUnknown: boolean;
  /**
   * The panel is not watching this row's device, so neither flag above is a
   * fact it can report. Terminals never carry it - the panel mounts an
   * authority for every terminal tab host.
   */
  readonly isUnwatched: boolean;
}

function landingPanelRowFor(args: {
  readonly tab: LandingPanelTabRef;
  readonly terminal: PlainTerminalViewModel | null;
  readonly browser: LandingBrowserViewModel | null;
}): LandingPanelRowModel {
  return args.tab.kind === "browser"
    ? landingBrowserRowFor(args.tab.name, args.browser)
    : landingTerminalRowFor(args.tab.name, args.terminal);
}

function landingBrowserRowFor(
  storedName: string,
  browser: LandingBrowserViewModel | null,
): LandingPanelRowModel {
  // The three states are mutually exclusive HERE as well as in the view model,
  // so no later reader of this row can render two suffixes at once: an
  // unwatched device is one this window holds no stream for, and "dormant" and
  // "status unavailable" are both claims only a watched stream could support.
  const isUnwatched = browser?.isUnwatched === true;
  return {
    displayName: browser?.displayTitle ?? storedName,
    // The address is a live reading, so an unwatched row has none. The tooltip
    // takes its place and says why, rather than leaving the row mute.
    detail: isUnwatched
      ? LANDING_BROWSER_UNWATCHED_TOOLTIP
      : (browser?.address ?? null),
    processName: null,
    isDormant: !isUnwatched && browser?.isDormant === true,
    // No view model at all means the panel has not resolved this device's
    // inventory, which is the same thing the flag says when it has not
    // spoken yet.
    isRuntimeUnknown:
      !isUnwatched && (browser === null || browser.isRuntimeUnknown),
    isUnwatched,
  };
}

function landingTerminalRowFor(
  storedName: string,
  terminal: PlainTerminalViewModel | null,
): LandingPanelRowModel {
  return {
    displayName: terminal?.displayTitle ?? storedName,
    detail: terminal?.liveCwd ?? terminal?.launchCwd ?? null,
    processName:
      terminal !== null &&
      terminal.manualTitle !== null &&
      terminal.activeProcessName !== null
        ? terminal.activeProcessName
        : null,
    isDormant: terminal?.isDormant === true,
    isRuntimeUnknown: terminal?.isRuntimeUnknown === true,
    isUnwatched: false,
  };
}

function LandingPanelTab(props: {
  readonly tab: LandingPanelTabRef;
  readonly active: boolean;
  readonly onActivate: (instanceId: string) => void;
  readonly onClose: (tab: LandingPanelTabRef) => void;
  readonly onCloseAll: () => void;
  readonly onRename: (instanceId: string, name: string) => void;
  readonly canRename: boolean;
  readonly row: LandingPanelRowModel;
}): ReactNode {
  const { tab, active, onActivate, onRename } = props;
  const displayName = props.row.displayName;
  const displayCwd = props.row.detail;
  const tabRef = useRef<HTMLDivElement | null>(null);

  // Keep the active tab on screen. A tab created past the right edge of the
  // scroller mounts already-active, so this runs on mount too - without it,
  // spamming "+" silently opens terminals nobody can see. `nearest` on both
  // axes makes it a no-op when the tab is already fully visible.
  useEffect(() => {
    if (!active) return;
    tabRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active]);

  const commitRename = useCallback(
    (next: string) => {
      onRename(tab.instanceId, next);
    },
    [onRename, tab.instanceId],
  );
  // The shared state machine the epic tab strips use. It owns the two things a
  // hand-rolled rename gets wrong: focusing past the closing context menu's
  // focus-restore, and settling commit/cancel exactly once.
  const rename = useInlineRename({
    value: displayName,
    canEdit: props.canRename,
    onCommit: commitRename,
  });
  const { isEditing } = rename;

  const activate = useCallback(() => {
    if (isEditing) return;
    onActivate(tab.instanceId);
  }, [isEditing, onActivate, tab.instanceId]);

  return (
    // `modal={false}` is load-bearing for rename. A modal Radix menu keeps a
    // TRAPPED focus scope while it closes: the rename input mounts and focuses
    // inside the trigger (outside that scope), the scope yanks focus back, the
    // input blurs, and `useInlineRename` blur-commits and unmounts it - so the
    // edit box vanishes and you have to click the tab again. Un-trapped, the
    // input keeps the focus it takes on mount.
    <ContextMenu modal={false}>
      <ContextMenuTrigger asChild>
        <div
          ref={tabRef}
          role="tab"
          aria-label={
            displayCwd === null ? displayName : `${displayName}, ${displayCwd}`
          }
          aria-selected={active}
          tabIndex={0}
          data-testid={`landing-terminal-tab-${tab.instanceId}`}
          onClick={activate}
          onKeyDown={(event) => {
            if (isEditing) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            activate();
          }}
          className={cn(
            "group relative flex min-w-0 shrink-0 items-center gap-1.5 border-r border-canvas-border/70 px-3 text-ui-sm text-muted-foreground outline-hidden transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring",
            "max-w-[45vw]",
            active &&
              "bg-(--app-background) text-foreground shadow-[inset_0_-1px_0_var(--color-background)] before:absolute before:inset-x-0 before:top-0 before:h-px before:bg-primary",
          )}
        >
          {tab.kind === "browser" ? (
            <Globe className="size-3.5 shrink-0" aria-hidden="true" />
          ) : (
            <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <LandingPanelTabLabel
            instanceId={tab.instanceId}
            displayName={displayName}
            isEditing={isEditing}
            inputProps={rename.inputProps}
            row={props.row}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Close ${displayName}`}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100"
            onClick={(event) => {
              event.stopPropagation();
              props.onClose(tab);
            }}
          >
            <X className="size-3.5" />
          </Button>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
        <ContextMenuItem
          disabled={!props.canRename}
          onSelect={rename.startEditing}
        >
          <Pencil className="size-4" />
          Rename
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => props.onClose(tab)}>
          Close
        </ContextMenuItem>
        <ContextMenuItem onSelect={props.onCloseAll}>Close All</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function LandingPanelTabLabel(props: {
  readonly instanceId: string;
  readonly displayName: string;
  readonly isEditing: boolean;
  readonly inputProps: InlineRenameInputProps;
  readonly row: LandingPanelRowModel;
}): ReactNode {
  if (props.isEditing) {
    return (
      <input
        {...props.inputProps}
        aria-label="Rename tab"
        data-testid={`landing-terminal-tab-input-${props.instanceId}`}
        className="h-6 min-w-[7ch] max-w-40 rounded-sm border border-border bg-background px-1 text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    );
  }
  return (
    <>
      <TooltipWrapper
        label={props.row.detail}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="truncate">{props.displayName}</span>
      </TooltipWrapper>
      {props.row.processName === null ? null : (
        <span
          className="max-w-24 truncate text-ui-xs text-muted-foreground"
          data-testid={`landing-terminal-process-${props.instanceId}`}
        >
          · {props.row.processName}
        </span>
      )}
      {props.row.isDormant ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid={`landing-terminal-dormant-${props.instanceId}`}
        >
          · dormant
        </span>
      ) : null}
      {props.row.isRuntimeUnknown ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid={`landing-terminal-unavailable-${props.instanceId}`}
        >
          · status unavailable
        </span>
      ) : null}
      {props.row.isUnwatched ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid={`landing-terminal-unwatched-${props.instanceId}`}
        >
          · not watched
        </span>
      ) : null}
    </>
  );
}
