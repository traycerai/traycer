import { useCallback, useSyncExternalStore } from "react";
import {
  ArrowLeftRight,
  CopyPlus,
  ExternalLink,
  Maximize2,
  PanelLeftClose,
  PanelRightClose,
  Pencil,
  Pin,
  SplitSquareHorizontal,
  X,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { cn } from "@/lib/utils";
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useEpicPinLocalHomeSupported } from "@/hooks/epic/use-epic-pin-local-home-support";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { HeaderTab } from "@/stores/tabs/types";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import {
  TAB_SPLIT_COMMANDS,
  resolveTabSplitCommandAvailability,
  type TabSplitCommandAvailability,
  type TabSplitCommandId,
} from "@/stores/tabs/tab-split-commands";

interface TabContextMenuContentProps {
  readonly tab: HeaderTab;
  readonly canCloseOtherTabs: boolean;
  readonly canOpenInNewWindow: boolean;
  readonly canEditTitle: boolean;
  readonly taskPinnedState: TaskPinnedState | null;
  readonly isTaskPinPending: boolean;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  /** Switches the epic tab title into the inline editable input. */
  readonly onEditTitle: () => void;
  readonly onSetTaskPinned: (pinned: boolean) => void;
}

/**
 * Why the tab's History pin is unavailable, or `null` when it is not.
 *
 * The row reasons win over the session one: `local-home` / preserved-orphan are
 * permanent facts about the epic, while a withdrawn cloud verdict is a
 * condition the user can recover from - and naming the recoverable one for a
 * row that could never be pinned would point them at the wrong problem. Same
 * ordering, and the same reasoning, as `historyPinUnavailableReason`.
 */
function tabPinUnavailableReason(input: {
  readonly localOnly: boolean;
  readonly preservedOrphan: boolean;
  readonly cloudAuthorized: boolean;
  /** `epic.setPinned@1.1` negotiated - see `useEpicPinLocalHomeSupported`. */
  readonly localHomePinSupported: boolean;
}): "local-home" | "preserved-orphan" | "unverified-session" | null {
  // The two row reasons are SPLIT rather than one `"row"` verdict, and that is
  // no longer cosmetic. They were collapsed while both were permanent and both
  // wore the same label; `local-home` is now conditional on the host, so a
  // single verdict would have to pick one of two sentences for two states that
  // have stopped coinciding - and the surviving one, preserved-orphan, is the
  // one whose epic is NOT merely local ("its cloud copy was deleted").
  if (input.preservedOrphan) return "preserved-orphan";
  if (input.localOnly && !input.localHomePinSupported) return "local-home";
  if (!input.cloudAuthorized) return "unverified-session";
  return null;
}

/**
 * The pin item's label. States the CONDITION rather than predicting an event:
 * "available after cloud sync" promises a sync a free-tier account never gets,
 * and a stale `home: "local"` reading would keep promising it for an epic
 * already in the cloud.
 */
function pinActionLabel(
  unavailableReason:
    | "local-home"
    | "preserved-orphan"
    | "unverified-session"
    | null,
  taskPinned: boolean | null,
): string {
  // Three different unavailabilities, and one label cannot honestly cover any
  // two of them: "stored on the connected device" is a fact about where the
  // epic LIVES, and stating it for a cloud-backed row whose session merely lost
  // its verdict - or whose cloud copy was deleted - is a false statement about
  // that.
  //
  // "the connected device" rather than "this device": the epic lives on the
  // HOST serving it, which on a phone or a relay-only shell is not the machine
  // rendering this menu. See `history-pin-availability.ts` for the rule.
  if (unavailableReason === "local-home") {
    return "Pin Task in History \u2014 stored on the connected device";
  }
  if (unavailableReason === "preserved-orphan") {
    return "Pin Task in History \u2014 cloud copy deleted";
  }
  if (unavailableReason === "unverified-session") {
    return "Pin Task in History \u2014 sign-in not confirmed";
  }
  return taskPinned === true ? "Unpin Task in History" : "Pin Task in History";
}

/**
 * The epic-only head of the menu: Edit Title and the History pin.
 *
 * Split out of `TabContextMenuContent` purely to keep that function under the
 * complexity ceiling - this block carries most of the menu's branching. It
 * takes `preservedOrphan` as a PROP rather than calling
 * `usePreservedOrphanSession` itself, so the hook keeps running for every tab
 * kind exactly as it did before the split.
 */
function EpicTabMenuItems(props: {
  readonly tabId: string;
  readonly canEditTitle: boolean;
  readonly taskPinned: boolean | null;
  readonly isTaskPinPending: boolean;
  readonly localOnly: boolean;
  /** See `TaskPinnedState.pinnedKnown`. */
  readonly pinReadingKnown: boolean;
  readonly preservedOrphan: boolean;
  readonly onEditTitle: () => void;
  readonly onSetTaskPinned: (pinned: boolean) => void;
}): React.ReactNode {
  const { tabId, taskPinned, localOnly, pinReadingKnown, preservedOrphan } =
    props;
  // Read here rather than threaded as a prop: the two row-intrinsic reasons
  // above are facts about the TAB and belong to its owner, while this is a fact
  // about the session, identical for every tab in the strip.
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // Read here for the same reason as `cloudAuthorized`: it is a fact about the
  // host serving this window, identical for every tab in the strip, and not
  // something a tab's owner knows.
  const localHomePinSupported = useEpicPinLocalHomeSupported();
  const pinUnavailableReason = tabPinUnavailableReason({
    localOnly,
    preservedOrphan,
    cloudAuthorized,
    // A negotiated `@1.1` only enables the control where there is a real pin
    // reading to toggle; see `pinReadingKnown` at the call site.
    localHomePinSupported: localHomePinSupported && pinReadingKnown,
  });
  const pinUnavailable = pinUnavailableReason !== null;
  return (
    <>
      {props.canEditTitle ? (
        <ContextMenuItem
          onSelect={props.onEditTitle}
          data-testid={`tab-edit-title-epic-${tabId}`}
        >
          <Pencil />
          Edit Title
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        // Pin is a cloud-only personal preference. The get-task-contexts
        // cache cannot carry list preservation and is intentionally
        // infinitely fresh, so a live session's orphan-pause state is the
        // authority for an open cloud-deleted-but-locally-preserved epic.
        //
        // `disabled` only for the TRANSIENT states (state unknown, mutation
        // pending). A permanently unavailable item - local home, preserved
        // orphan - is `aria-disabled` instead: Radix drops `disabled` items
        // from roving keyboard navigation, so a keyboard user could never
        // reach the label that explains WHY the pin is unavailable. The
        // `onSelect` guard below is what keeps it inert either way, and
        // `preventDefault` keeps the menu open on that inert select, exactly
        // as a disabled item would have.
        disabled={taskPinned === null || props.isTaskPinPending}
        aria-disabled={pinUnavailable || undefined}
        className={cn(pinUnavailable && "opacity-50")}
        // The REASON, not the raw row fact. `localOnly` no longer implies the
        // pin is unavailable - a `@1.1` host pins a local-homed epic - so an
        // attribute keyed on the row would keep marking an ENABLED item as
        // unavailable, which is both a lie to a reader and a test pinning the
        // wrong thing.
        data-local-home-pin-unavailable={
          pinUnavailableReason === "local-home" || undefined
        }
        data-preserved-orphan-pin-unavailable={
          pinUnavailableReason === "preserved-orphan" || undefined
        }
        onSelect={(event) => {
          if (pinUnavailable || taskPinned === null) {
            event.preventDefault();
            return;
          }
          props.onSetTaskPinned(!taskPinned);
        }}
        data-testid={`tab-pin-history-${tabId}`}
      >
        <Pin className={taskPinned === true ? "fill-current" : undefined} />
        {pinActionLabel(pinUnavailableReason, taskPinned)}
        {!pinUnavailable && (taskPinned === null || props.isTaskPinPending) ? (
          <AgentSpinningDots
            className="ml-auto text-muted-foreground"
            testId={`tab-pin-history-spinner-${tabId}`}
            variant={undefined}
          />
        ) : null}
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}

export function TabContextMenuContent(
  props: TabContextMenuContentProps,
): React.ReactNode {
  const {
    tab,
    canCloseOtherTabs,
    canOpenInNewWindow,
    canEditTitle,
    taskPinnedState,
    isTaskPinPending,
    onCloseOtherTabs,
    onDuplicateTab,
    onOpenInNewWindow,
    onSplitCommand,
    onEditTitle,
    onSetTaskPinned,
  } = props;

  // `null` still means "we do not know yet" and keeps the spinner; the
  // absent-`home` case (older host, pre-`@1.1` negotiation) reads as
  // cloud-or-unknown and keeps exactly today's behaviour.
  const taskPinned = taskPinnedState === null ? null : taskPinnedState.pinned;
  const localOnly = taskPinnedState?.home === "local";
  // A local-homed epic that only a LIVE SESSION knows about carries a filler
  // `pinned` (see `TaskPinnedState.pinnedKnown`): the app-wide host never
  // resolved it, because it does not own it. `@1.1` must not turn that into an
  // offer - the label would guess a pin state and the click would invert the
  // guess, on a host that cannot serve the epic anyway. Such a row keeps the
  // unavailable state it has today, with the corrected copy.
  const pinReadingKnown = taskPinnedState?.pinnedKnown === true;
  const preservedOrphan = usePreservedOrphanSession(tab);

  const showDuplicate = tab.canDuplicate;
  const showOpenInNewWindow = tab.canOpenInNewWindow;

  return (
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      {tab.kind === "epic" ? (
        <EpicTabMenuItems
          tabId={tab.id}
          canEditTitle={canEditTitle}
          taskPinned={taskPinned}
          isTaskPinPending={isTaskPinPending}
          localOnly={localOnly}
          pinReadingKnown={pinReadingKnown}
          preservedOrphan={preservedOrphan}
          onEditTitle={onEditTitle}
          onSetTaskPinned={onSetTaskPinned}
        />
      ) : null}
      {showDuplicate ? (
        <ContextMenuItem
          onSelect={() => onDuplicateTab(tab)}
          data-testid={`tab-duplicate-${tab.kind}-${tab.id}`}
        >
          <CopyPlus />
          Duplicate Tab
          <ShortcutHint>
            <span className="ml-auto text-ui-xs text-muted-foreground">
              ⌘⇧K
            </span>
          </ShortcutHint>
        </ContextMenuItem>
      ) : null}
      {showDuplicate ? <ContextMenuSeparator /> : null}
      {showOpenInNewWindow ? (
        <ContextMenuItem
          disabled={!canOpenInNewWindow}
          onSelect={() => onOpenInNewWindow(tab)}
          data-testid={`tab-open-new-window-${tab.kind}-${tab.id}`}
        >
          <ExternalLink />
          Open in New Window
        </ContextMenuItem>
      ) : null}
      {showOpenInNewWindow ? <ContextMenuSeparator /> : null}
      <TabSplitMenuItems tab={tab} onSplitCommand={onSplitCommand} />
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!canCloseOtherTabs}
        onSelect={() => onCloseOtherTabs(tab)}
        data-testid={`tab-close-others-${tab.kind}-${tab.id}`}
      >
        <X />
        Close Other Tabs
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/**
 * `epic.getTaskContexts@1.1` cannot express a list row's preservation marker.
 * Its `staleTime: Infinity` cache can therefore still report the deleted
 * cloud task as pinnable. A live epic session has the host's durable pause
 * reason, which is the authoritative open-tab signal for this exception.
 */
function usePreservedOrphanSession(tab: HeaderTab): boolean {
  const epicId = tab.kind === "epic" ? tab.epicId : null;
  const registry = getOpenEpicRegistry();
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      if (epicId === null) return () => {};
      let unsubscribeStore: (() => void) | null = null;
      const bindStore = (): void => {
        unsubscribeStore?.();
        const handle = registry.peek(epicId);
        unsubscribeStore =
          handle === null ? null : handle.store.subscribe(listener);
      };
      bindStore();
      const unsubscribeRegistry = registry.subscribe(() => {
        bindStore();
        listener();
      });
      return () => {
        unsubscribeRegistry();
        unsubscribeStore?.();
      };
    },
    [epicId, registry],
  );
  const getSnapshot = useCallback((): boolean => {
    if (epicId === null) return false;
    const state = registry.peek(epicId)?.store.getState();
    return (
      state?.durabilityPauseReason ===
        "orphaned-local-edits-after-cloud-delete" ||
      state?.retainedDurabilityPauseReason ===
        "orphaned-local-edits-after-cloud-delete"
    );
  }, [epicId, registry]);
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

/**
 * The split-command section. Availability is resolved here at render time so
 * the menu reflects the live layout. Group-scoped commands remain directly in
 * the main menu: in a split, the creation commands above them are disabled, so
 * a second arrangement submenu only adds an unnecessary navigation step.
 */
function TabSplitMenuItems(props: {
  readonly tab: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const { tab, onSplitCommand } = props;
  const splitAvailability = resolveTabSplitCommandAvailability({
    kind: tab.kind,
    id: tab.id,
  });
  const showsGroupCommands =
    splitAvailability.swap ||
    splitAvailability.separate ||
    splitAvailability.closeLeft !== null ||
    splitAvailability.closeRight !== null;

  return (
    <>
      <ContextMenuItem
        disabled={!splitAvailability.add}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.add.id, tab)}
        data-testid={`tab-add-split-${tab.kind}-${tab.id}`}
      >
        <SplitSquareHorizontal />
        {TAB_SPLIT_COMMANDS.add.label}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!splitAvailability.pair}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.pair.id, tab)}
        data-testid={`tab-pair-current-${tab.kind}-${tab.id}`}
      >
        {TAB_SPLIT_COMMANDS.pair.label}
      </ContextMenuItem>
      {showsGroupCommands ? (
        <>
          <ContextMenuSeparator />
          <TabSplitArrangeItems
            tab={tab}
            availability={splitAvailability}
            onSplitCommand={onSplitCommand}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * The four group-scoped verbs, ordered to match the platform browser: separate,
 * then the per-side closes, then reverse. Shared verbatim by the arrange
 * submenu and by an empty half's own menu, so the two can never drift.
 */
function TabSplitArrangeItems(props: {
  readonly tab: HeaderTab;
  readonly availability: TabSplitCommandAvailability;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const { tab, availability, onSplitCommand } = props;
  return (
    <>
      <ContextMenuItem
        disabled={!availability.separate}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.separate.id, tab)}
        data-testid={`tab-separate-split-${tab.kind}-${tab.id}`}
      >
        <Maximize2 />
        {TAB_SPLIT_COMMANDS.separate.label}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={availability.closeLeft === null}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.closeLeft.id, tab)}
        data-testid={`tab-close-left-${tab.kind}-${tab.id}`}
      >
        <PanelLeftClose />
        {TAB_SPLIT_COMMANDS.closeLeft.label}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={availability.closeRight === null}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.closeRight.id, tab)}
        data-testid={`tab-close-right-${tab.kind}-${tab.id}`}
      >
        <PanelRightClose />
        {TAB_SPLIT_COMMANDS.closeRight.label}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!availability.swap}
        onSelect={() => onSplitCommand(TAB_SPLIT_COMMANDS.swap.id, tab)}
        data-testid={`tab-swap-split-${tab.kind}-${tab.id}`}
      >
        <ArrowLeftRight />
        {TAB_SPLIT_COMMANDS.swap.label}
      </ContextMenuItem>
    </>
  );
}

/**
 * Menu for a split group's empty half. That half has no tab of its own, so the
 * commands resolve against the populated partner - which names the same group -
 * and are shown flat rather than nested, since the menu is already scoped to
 * this split. Without it, right-clicking a "Choose view" half did nothing.
 */
export function SplitSlotMenuContent(props: {
  readonly partner: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const availability = resolveTabSplitCommandAvailability({
    kind: props.partner.kind,
    id: props.partner.id,
  });
  return (
    <ContextMenuContent onCloseAutoFocus={(event) => event.preventDefault()}>
      <TabSplitArrangeItems
        tab={props.partner}
        availability={availability}
        onSplitCommand={props.onSplitCommand}
      />
    </ContextMenuContent>
  );
}

/** Click-menu counterpart to the flattened context-menu arrangement section. */
export function SplitQuickActionsMenuContent(props: {
  readonly tab: HeaderTab;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
}): React.ReactNode {
  const availability = resolveTabSplitCommandAvailability({
    kind: props.tab.kind,
    id: props.tab.id,
  });
  return (
    <DropdownMenuContent
      align="start"
      className="w-52"
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      <DropdownMenuItem
        disabled={!availability.separate}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.separate.id, props.tab)
        }
        data-testid={`split-quick-separate-${props.tab.kind}-${props.tab.id}`}
      >
        <Maximize2 />
        {TAB_SPLIT_COMMANDS.separate.label}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={availability.closeLeft === null}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.closeLeft.id, props.tab)
        }
        data-testid={`split-quick-close-left-${props.tab.kind}-${props.tab.id}`}
      >
        <PanelLeftClose />
        {TAB_SPLIT_COMMANDS.closeLeft.label}
      </DropdownMenuItem>
      <DropdownMenuItem
        disabled={availability.closeRight === null}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.closeRight.id, props.tab)
        }
        data-testid={`split-quick-close-right-${props.tab.kind}-${props.tab.id}`}
      >
        <PanelRightClose />
        {TAB_SPLIT_COMMANDS.closeRight.label}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        disabled={!availability.swap}
        onSelect={() =>
          props.onSplitCommand(TAB_SPLIT_COMMANDS.swap.id, props.tab)
        }
        data-testid={`split-quick-swap-${props.tab.kind}-${props.tab.id}`}
      >
        <ArrowLeftRight />
        {TAB_SPLIT_COMMANDS.swap.label}
      </DropdownMenuItem>
    </DropdownMenuContent>
  );
}
