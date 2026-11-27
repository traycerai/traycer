import { TabAppearanceMenu } from "./tab-appearance-menu";
import { POOL_HOST_ID } from "@traycer-clients/shared/host-client/host-directory";
import {
  accountWideAnswerer,
  readProcessHostRpcTierPlan,
} from "@traycer-clients/shared/host-client/host-rpc-routing";
import {
  getEpicSessionHostId,
  useEpicSessionHostIdForEpic,
} from "@/lib/registries/epic-session-registry";
import { useServingPeerHostId } from "@/lib/host/serving-decision";
import { useAppServingDecision } from "@/lib/host/app-serving-decision";
import {
  useCallback,
  useId,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTabRecovery } from "@/lib/tab-recovery/use-tab-recovery";
import { formatChordForDisplay } from "@/lib/keybindings/chord";
import { useBindingForAction } from "@/stores/settings/keybinding-store";
import { useGroupEditorStore } from "@/stores/tabs/group-editor-store";
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
import { ShortcutHint } from "@/components/ui/shortcut-hint";
import {
  useComputerTaskPinReading,
  usePoolTaskPinReading,
  type TaskPinnedState,
} from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useEpicPinLocalHomeSupported } from "@/hooks/epic/use-epic-pin-local-home-support";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import { LayoutRegionContextMenuWithItems } from "@/components/layout-editor/region-quick-verbs";
import { writeArrangementField } from "@/lib/layout/arrangement-gestures";
import { TAB_STRIP_PLACEMENT_OPTIONS } from "@/components/layout-editor/regions/region-grammar";
import { useArrangementValue } from "@/lib/layout-overrides";
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import type { HeaderTab } from "@/stores/tabs/types";
import { readTabStripLayout } from "@/stores/tabs/store";
import {
  tabsDrawnAfter,
  useCloseTabsAfter,
} from "@/components/layout/dialogs/use-close-tab-flow";
import { useTabStripPlacement } from "./use-tab-strip-placement";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { isPreservedOrphanEpic } from "./preserved-orphan-epic";
import {
  TAB_SPLIT_COMMANDS,
  resolveTabSplitCommandAvailability,
  type TabSplitCommandAvailability,
  type TabSplitCommandId,
} from "@/stores/tabs/tab-split-commands";

interface TabContextMenuContentProps {
  readonly tab: HeaderTab;
  readonly canClose: boolean;
  readonly canCloseOtherTabs: boolean;
  readonly canOpenInNewWindow: boolean;
  readonly canEditTitle: boolean;
  readonly taskPinnedState: TaskPinnedState | null;
  readonly isTaskPinPending: boolean;
  /** The strip's close flow for this tab, the same one its hover × runs. */
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  /** Switches the epic tab title into the inline editable input. */
  readonly onEditTitle: () => void;
  readonly onSetTaskPinned: (pinned: boolean) => void;
  readonly onSetAddressedTaskPinned?: AddressedTaskPin;
}

type AddressedTaskPin = (pinned: boolean, reading: TaskPinnedState) => void;

/**
 * Why the tab's History pin is unavailable, or `null` when it is not.
 *
 * The row reasons win over the session one: `local-home` / preserved-orphan are
 * facts about the epic, while a withdrawn cloud verdict is a condition the user
 * can recover from - and naming the recoverable one for a row that could never
 * be pinned would point them at the wrong problem. Same ordering, same
 * carve-out, and the same reasoning as `historyPinUnavailableReason`; the two
 * are the desktop-History and tab-strip halves of one rule and must not drift.
 */
function tabPinUnavailableReason(input: {
  readonly localOnly: boolean;
  readonly preservedOrphan: boolean;
  readonly cloudAuthorized: boolean;
  /** `epic.setPinned@1.1` negotiated - see `useEpicPinLocalHomeSupported`. */
  readonly localHomePinSupported: boolean;
  /**
   * A reading EXISTS but is not an answer (`pinnedKnown: false`): the batch
   * settled without resolving this epic. Distinct from no reading at all,
   * which is a question still in flight and keeps the spinner.
   */
  readonly pinReadingUnanswered: boolean;
}):
  | "local-home"
  | "pin-unknown"
  | "preserved-orphan"
  | "unverified-session"
  | null {
  // The two row reasons are SPLIT rather than one `"row"` verdict, and that is
  // no longer cosmetic. They were collapsed while both were permanent and both
  // wore the same label; `local-home` is now conditional on the host, so a
  // single verdict would have to pick one of two sentences for two states that
  // have stopped coinciding - and the surviving one, preserved-orphan, is the
  // one whose epic is NOT merely local ("its cloud copy was deleted").
  if (input.preservedOrphan) return "preserved-orphan";
  // A local-homed tab RETURNS from here either way and never reaches the
  // session check. The `@1.1` host serves this pin off its own disk - its
  // resolver admits on the local `epicHomeVerdict` and returns before any
  // cloud header is built - so no cloud capability is spent and a withdrawn
  // verdict is not a reason to refuse. `useEpicSetPinned` carries the same
  // exemption at dispatch.
  if (input.localOnly) {
    // Two different unavailabilities, and they used to share one verdict
    // because they shared one sentence ("stored on the connected device" was
    // true of both). Now that the `local-home` sentence names a remedy - a
    // newer host - a row whose pin reading simply never arrived must not wear
    // it: that host may already speak `@1.1`, and telling the person to update
    // it changes nothing. Checked first because it is the more specific fact.
    if (input.pinReadingUnanswered) return "pin-unknown";
    return input.localHomePinSupported ? null : "local-home";
  }
  if (!input.cloudAuthorized) return "unverified-session";
  // A cloud-homed row the host settled without resolving - a cloud leg past
  // its deadline, a 5xx, an errored chunk. Before this arm it had no entry at
  // all and spun forever, because "still loading" was the only state a
  // missing reading could render. Opening the menu re-asks
  // (`useRetryUnansweredTaskPinReading`), so the label resolves itself when
  // the host answers.
  if (input.pinReadingUnanswered) return "pin-unknown";
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
    | "pin-unknown"
    | "preserved-orphan"
    | "unverified-session"
    | null,
  taskPinned: boolean | null,
): string {
  // Three different unavailabilities, and one label cannot honestly cover any
  // two of them: each names its own remedy (a host update, nothing, a
  // sign-in), and stating one for a row in another state sends the person to
  // fix the wrong thing. None of them says WHERE the task lives - see
  // `history-pin-availability.ts` for that rule.
  if (unavailableReason === "local-home") {
    return "Pin Task in History \u2014 needs a newer host";
  }
  // No remedy named on purpose: the reading may still arrive (a live session
  // that has not resolved it yet) or never (a host that does not own the
  // epic), and neither is something the person can act on from this menu.
  if (unavailableReason === "pin-unknown") {
    return "Pin Task in History \u2014 pin state unknown";
  }
  if (unavailableReason === "preserved-orphan") {
    return "Pin Task in History \u2014 task deleted";
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
interface EpicTabMenuItemsProps {
  readonly tab: Extract<HeaderTab, { kind: "epic" }>;
  readonly canEditTitle: boolean;
  readonly isTaskPinPending: boolean;
  readonly preservedOrphan: boolean;
  readonly onEditTitle: () => void;
}

function EpicTabMenuItems(
  props: EpicTabMenuItemsProps & {
    readonly taskPinnedState: TaskPinnedState | null;
    readonly onSetTaskPinned: (pinned: boolean) => void;
  },
): React.ReactNode {
  const { id: tabId } = props.tab;
  const { taskPinnedState } = props;
  const taskPinned = taskPinnedState === null ? null : taskPinnedState.pinned;
  const localOnly = taskPinnedState?.home === "local";
  const pinReadingUnanswered =
    taskPinnedState !== null && !taskPinnedState.pinnedKnown;
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  // The computer that owns this local task supplies its pin capability.
  const localHomePinSupported = useEpicPinLocalHomeSupported(
    taskPinnedState?.hostId,
  );
  const pinUnavailableReason = tabPinUnavailableReason({
    localOnly,
    preservedOrphan: props.preservedOrphan,
    cloudAuthorized,
    localHomePinSupported,
    // Passed as its own fact rather than folded into `localHomePinSupported`:
    // a negotiated `@1.1` only enables the control where there is a real pin
    // reading to toggle, but a missing reading is a different unavailability
    // from an old host and wears a different sentence.
    pinReadingUnanswered,
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
            className="ml-auto"
            testId={`tab-pin-history-spinner-${tabId}`}
            variant={undefined}
            tone="muted"
          />
        ) : null}
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}

interface AddressedEpicTabMenuProps extends EpicTabMenuItemsProps {
  readonly existingReading: TaskPinnedState | null;
  readonly onSetAddressedTaskPinned: AddressedTaskPin | undefined;
}

function AddressedEpicTabMenuItems(
  props: AddressedEpicTabMenuProps,
): ReactNode {
  const sessionHostId = useEpicSessionHostIdForEpic(props.tab.epicId);
  const windowHostId = useServingPeerHostId();
  const poolAnswersList =
    accountWideAnswerer("epic.listTasks", null, useAppServingDecision()) ===
    "pool";
  if (
    poolAnswersList &&
    sessionHostId === POOL_HOST_ID &&
    props.existingReading?.home !== "local"
  ) {
    return <PoolEpicTabMenuItems {...props} />;
  }
  if (
    sessionHostId !== null &&
    sessionHostId !== POOL_HOST_ID &&
    windowHostId === POOL_HOST_ID
  ) {
    return (
      <ComputerEpicTabMenuItems
        key={sessionHostId}
        {...props}
        hostId={sessionHostId}
      />
    );
  }
  const reading = props.existingReading;
  return (
    <AddressedPinItems
      {...props}
      reading={
        sessionHostId !== null &&
        windowHostId !== null &&
        reading !== null &&
        (reading.home !== "local" || reading.hostId === sessionHostId)
          ? { ...reading, hostId: sessionHostId }
          : null
      }
    />
  );
}

function PoolEpicTabMenuItems(props: AddressedEpicTabMenuProps): ReactNode {
  const reading = usePoolTaskPinReading(props.tab.epicId);
  return <AddressedPinItems {...props} reading={reading} />;
}

function ComputerEpicTabMenuItems(
  props: AddressedEpicTabMenuProps & {
    readonly hostId: string;
  },
): ReactNode {
  const reading = useComputerTaskPinReading(
    props.tab.epicId,
    props.hostId,
    props.existingReading,
  );
  return <AddressedPinItems {...props} reading={reading} />;
}

function AddressedPinItems(
  props: AddressedEpicTabMenuProps & {
    readonly reading: TaskPinnedState | null;
  },
): ReactNode {
  const { reading, onSetAddressedTaskPinned, tab } = props;
  return (
    <EpicTabMenuItems
      {...props}
      taskPinnedState={onSetAddressedTaskPinned === undefined ? null : reading}
      onSetTaskPinned={(pinned) => {
        if (
          reading !== null &&
          getEpicSessionHostId(tab.epicId) === reading.hostId
        )
          onSetAddressedTaskPinned?.(pinned, reading);
      }}
    />
  );
}

export function TabContextMenuContent(
  props: TabContextMenuContentProps,
): React.ReactNode {
  const recovery = useTabRecovery();
  const reopenChord = useBindingForAction("tab.reopen");
  const duplicateChord = useBindingForAction("epic.duplicate-tab");
  // `epic.close` is the strip tab's chord. `tab.close` (⌘W) closes the active
  // tile INSIDE the task, so showing it here would promise the wrong close.
  const closeChord = useBindingForAction("epic.close");
  const {
    tab,
    canClose,
    canCloseOtherTabs,
    canOpenInNewWindow,
    canEditTitle,
    taskPinnedState: existingPinReading,
    isTaskPinPending,
    onClose,
    onCloseOtherTabs,
    onDuplicateTab,
    onOpenInNewWindow,
    onSplitCommand,
    onEditTitle,
    onSetTaskPinned,
    onSetAddressedTaskPinned,
  } = props;
  const preservedOrphan = usePreservedOrphanSession(tab);

  const showDuplicate = tab.canDuplicate;
  const showOpenInNewWindow = tab.canOpenInNewWindow;
  let epicMenu: ReactNode = null;
  if (tab.kind === "epic") {
    const epicMenuProps = {
      tab,
      canEditTitle,
      isTaskPinPending,
      preservedOrphan,
      onEditTitle,
    };
    epicMenu =
      readProcessHostRpcTierPlan().pool === null ? (
        <EpicTabMenuItems
          {...epicMenuProps}
          taskPinnedState={existingPinReading}
          onSetTaskPinned={onSetTaskPinned}
        />
      ) : (
        <AddressedEpicTabMenuItems
          {...epicMenuProps}
          existingReading={existingPinReading}
          onSetAddressedTaskPinned={onSetAddressedTaskPinned}
        />
      );
  }

  return (
    <ContextMenuContent
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        // An "Edit group…" the menu was closed for, now that it is gone.
        useGroupEditorStore.getState().openRequested();
      }}
    >
      <TabAppearanceMenu tab={tab} />
      {epicMenu}
      {showDuplicate ? (
        <ContextMenuItem
          onSelect={() => onDuplicateTab(tab)}
          data-testid={`tab-duplicate-${tab.kind}-${tab.id}`}
        >
          <CopyPlus />
          Duplicate Tab
          {duplicateChord === null ? null : (
            <ShortcutHint>
              <span className="ml-auto text-ui-xs text-muted-foreground">
                {formatChordForDisplay(duplicateChord)}
              </span>
            </ShortcutHint>
          )}
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
      <TabStripPlacementMenuItems />
      <ContextMenuSeparator />
      {/* The collapsed rail tile draws no hover ×, so for it this item is the
          only pointer close. Offered everywhere so the menu reads the same in
          every placement. */}
      <ContextMenuItem
        disabled={!canClose}
        onSelect={() => onClose(tab)}
        data-testid={`tab-close-${tab.kind}-${tab.id}-menu`}
      >
        <X />
        Close Tab
        {closeChord === null ? null : (
          <ShortcutHint>
            <span className="ml-auto text-ui-xs text-muted-foreground">
              {formatChordForDisplay(closeChord)}
            </span>
          </ShortcutHint>
        )}
      </ContextMenuItem>
      <ContextMenuItem
        disabled={!canCloseOtherTabs}
        onSelect={() => onCloseOtherTabs(tab)}
        data-testid={`tab-close-others-${tab.kind}-${tab.id}`}
      >
        <X />
        Close Other Tabs
      </ContextMenuItem>
      <CloseTabsAfterMenuItem tab={tab} />
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={!recovery.available}
        data-testid="tab-reopen-closed"
        onSelect={() => {
          void recovery.reopen();
        }}
      >
        Reopen Closed Tab
        {reopenChord === null ? null : (
          <ShortcutHint>
            <span className="ml-auto text-ui-xs text-muted-foreground">
              {formatChordForDisplay(reopenChord)}
            </span>
          </ShortcutHint>
        )}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/**
 * Closes the tabs drawn after this one. Named for the way the strip runs on
 * screen, so it reads "Below" wherever the tabs are a vertical list. Its own
 * component so the strip is only read while the menu is open: the content is
 * not mounted otherwise.
 */
function CloseTabsAfterMenuItem(props: { readonly tab: HeaderTab }): ReactNode {
  const { tab } = props;
  const closeTabsAfter = useCloseTabsAfter();
  const placement = useTabStripPlacement();
  const hasTabsAfter = tabsDrawnAfter(tab, readTabStripLayout()).length > 0;
  return (
    <ContextMenuItem
      disabled={!hasTabsAfter}
      onSelect={() => closeTabsAfter(tab)}
      data-testid={`tab-close-after-${tab.kind}-${tab.id}`}
    >
      <X />
      {placement === "top" ? "Close Tabs to the Right" : "Close Tabs Below"}
    </ContextMenuItem>
  );
}

/**
 * Where the task tabs sit - Top, Left or Right - as one radio group headed
 * "Tabs", shared by a task tab's menu and Home's.
 *
 * It reads the STORED placement, not the effective one, because it describes
 * the layout rather than this window. The write is a recorded gesture: a plain
 * layout write at rest, and one Undo step that Discard takes back while the
 * layout editor is open. In a session only Home's menu can open, because the
 * edit firewall swallows a right-click on a task tab, which is not a region.
 * The caller draws the separators around it.
 */
function TabStripPlacementMenuItems(): ReactNode {
  const placement = useArrangementValue("tabStripPlacement");
  const labelId = useId();
  return (
    <>
      <ContextMenuLabel id={labelId}>Tabs</ContextMenuLabel>
      <ContextMenuRadioGroup value={placement} aria-labelledby={labelId}>
        {TAB_STRIP_PLACEMENT_OPTIONS.map((option) => (
          <ContextMenuRadioItem
            key={option.value}
            value={option.value}
            data-testid={`tab-strip-placement-${option.value}`}
            onSelect={() => {
              writeArrangementField("tabStripPlacement", option.value);
            }}
          >
            {option.label}
          </ContextMenuRadioItem>
        ))}
      </ContextMenuRadioGroup>
    </>
  );
}

/**
 * Home's right-click menu: Home's own layout verbs, the tabs' placement, then
 * the way into the layout editor on Home - the region menu every other piece
 * of chrome has, with the placement group added.
 */
export function HomeTabContextMenu(props: {
  readonly children: ReactNode;
}): ReactNode {
  return (
    <LayoutRegionContextMenuWithItems
      regionId="homeTab"
      extraItems={
        <>
          <TabStripPlacementMenuItems />
          <ContextMenuSeparator />
        </>
      }
    >
      {props.children}
    </LayoutRegionContextMenuWithItems>
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
  const getSnapshot = useCallback(
    (): boolean => epicId !== null && isPreservedOrphanEpic(epicId),
    [epicId],
  );
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
