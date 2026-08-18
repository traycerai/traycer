import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type MouseEvent,
  type ReactNode,
} from "react";
import { Pencil, Plus, TerminalSquare, X } from "lucide-react";
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
import type { LandingTerminalTabRef } from "@/stores/home/landing-terminal-store";
import type { PlainTerminalViewModel } from "@/lib/terminals/plain-terminal-authority";

export interface LandingTerminalTabStripProps {
  readonly tabs: ReadonlyArray<LandingTerminalTabRef>;
  readonly activeInstanceId: string | null;
  /**
   * Why creating a terminal is currently unavailable, or `null` when the
   * create affordances are live. Doubles as the disabled flag: the "+"
   * button and the empty-strip double-click gate on it, and the button
   * surfaces the string as a tooltip so the dead control explains itself.
   */
  readonly createDisabledReason: string | null;
  readonly onAdd: () => void;
  readonly onActivate: (instanceId: string) => void;
  readonly onClose: (tab: LandingTerminalTabRef) => void;
  readonly onCloseAll: () => void;
  readonly onRename: (instanceId: string, name: string) => void;
  readonly canRename: (tab: LandingTerminalTabRef) => boolean;
  /**
   * Whether this tab's host can currently be asked to close it. `onClose`
   * refuses on its own when authority is not ready, so an always-enabled "x"
   * was a control that swallowed the click and said nothing.
   */
  readonly canClose: (tab: LandingTerminalTabRef) => boolean;
  readonly terminalViewModels: Readonly<
    Partial<Record<string, PlainTerminalViewModel>>
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
  const { createDisabledReason, onAdd } = props;
  const canCreate = createDisabledReason === null;
  // "Close All" closes only the tabs whose host can be asked to, so it is dead
  // exactly when none of them can.
  const canCloseAll = props.tabs.some(props.canClose);
  const handleStripDoubleClick = (event: MouseEvent<HTMLDivElement>): void => {
    if (!canCreate) return;
    // Only the empty strip background opens a terminal. A double-click that
    // lands on a tab (or on the "+"/close buttons, whose own click handler
    // already fired twice) must not spawn a second one.
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
          {props.tabs.map((tab) => (
            <LandingTerminalTab
              key={tab.instanceId}
              tab={tab}
              active={tab.instanceId === props.activeInstanceId}
              onActivate={props.onActivate}
              onClose={props.onClose}
              onCloseAll={props.onCloseAll}
              onRename={props.onRename}
              canRename={props.canRename(tab)}
              canClose={props.canClose(tab)}
              canCloseAll={canCloseAll}
              viewModel={props.terminalViewModels[tab.instanceId] ?? null}
            />
          ))}
        </div>
        <div className="flex shrink-0 items-center px-1">
          <NewTerminalButton
            disabledReason={createDisabledReason}
            onAdd={onAdd}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The strip's "+" affordance. While creation is unavailable the button is
 * `aria-disabled` rather than natively `disabled`, so it stays hoverable and
 * focusable and the reason is reachable as a tooltip - the same
 * disabled-with-hint convention as `ComposerSendButton` / the launch panel's
 * `StartButton` (a native `disabled` button emits no pointer events, so a
 * tooltip on it would never open).
 */
function NewTerminalButton(props: {
  readonly disabledReason: string | null;
  readonly onAdd: () => void;
}): ReactNode {
  const { disabledReason, onAdd } = props;
  const disabled = disabledReason !== null;
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
  const button = (
    <Button
      ref={buttonRef}
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="New terminal"
      data-testid="landing-terminal-new-tab"
      aria-disabled={disabled || undefined}
      className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-current dark:aria-disabled:hover:bg-transparent"
      onClick={() => {
        if (disabled) return;
        onAdd();
      }}
    >
      <Plus className="size-4" />
    </Button>
  );
  if (disabledReason === null) return button;
  return (
    <TooltipWrapper
      label={disabledReason}
      side="bottom"
      sideOffset={undefined}
      align={undefined}
    >
      <span className="inline-flex">{button}</span>
    </TooltipWrapper>
  );
}

function LandingTerminalTab(props: {
  readonly tab: LandingTerminalTabRef;
  readonly active: boolean;
  readonly onActivate: (instanceId: string) => void;
  readonly onClose: (tab: LandingTerminalTabRef) => void;
  readonly onCloseAll: () => void;
  readonly onRename: (instanceId: string, name: string) => void;
  readonly canRename: boolean;
  readonly canClose: boolean;
  readonly canCloseAll: boolean;
  readonly viewModel: PlainTerminalViewModel | null;
}): ReactNode {
  const { tab, active, onActivate, onRename } = props;
  const displayName = props.viewModel?.displayTitle ?? tab.name;
  const displayCwd =
    props.viewModel?.liveCwd ?? props.viewModel?.launchCwd ?? null;
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
          <TerminalSquare className="size-3.5 shrink-0" aria-hidden="true" />
          <LandingTerminalTabLabel
            instanceId={tab.instanceId}
            displayName={displayName}
            isEditing={isEditing}
            inputProps={rename.inputProps}
            viewModel={props.viewModel}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Close ${displayName}`}
            disabled={!props.canClose}
            className="opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
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
        <ContextMenuItem
          disabled={!props.canClose}
          onSelect={() => props.onClose(tab)}
        >
          Close
        </ContextMenuItem>
        <ContextMenuItem
          disabled={!props.canCloseAll}
          onSelect={props.onCloseAll}
        >
          Close All
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function LandingTerminalTabLabel(props: {
  readonly instanceId: string;
  readonly displayName: string;
  readonly isEditing: boolean;
  readonly inputProps: InlineRenameInputProps;
  readonly viewModel: PlainTerminalViewModel | null;
}): ReactNode {
  if (props.isEditing) {
    return (
      <input
        {...props.inputProps}
        aria-label="Rename terminal"
        data-testid={`landing-terminal-tab-input-${props.instanceId}`}
        className="h-6 min-w-[7ch] max-w-40 rounded-sm border border-border bg-background px-1 text-ui-sm text-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    );
  }
  return (
    <>
      <TooltipWrapper
        label={props.viewModel?.liveCwd ?? props.viewModel?.launchCwd}
        side="bottom"
        sideOffset={undefined}
        align={undefined}
      >
        <span className="truncate">{props.displayName}</span>
      </TooltipWrapper>
      {props.viewModel?.manualTitle !== null &&
      props.viewModel?.manualTitle !== undefined &&
      props.viewModel.activeProcessName !== null ? (
        <span
          className="max-w-24 truncate text-ui-xs text-muted-foreground"
          data-testid={`landing-terminal-process-${props.instanceId}`}
        >
          · {props.viewModel.activeProcessName}
        </span>
      ) : null}
      {props.viewModel?.isDormant === true ? (
        <span
          className="text-ui-xs text-muted-foreground"
          data-testid={`landing-terminal-dormant-${props.instanceId}`}
        >
          · dormant
        </span>
      ) : null}
    </>
  );
}
