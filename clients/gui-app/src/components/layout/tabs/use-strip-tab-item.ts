import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type KeyboardEvent,
  type TouchEvent,
} from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  useDraggable,
  useDroppable,
  type DraggableSyntheticListeners,
} from "@dnd-kit/core";
import {
  HEADER_TAB_DND_TYPE,
  HEADER_TAB_SLOT_DND_TYPE,
  getHeaderTabDragId,
  getHeaderTabSlotDropId,
  type HeaderTabDragData,
  type HeaderTabSlotDropData,
} from "@/components/layout/tabs/header-tab-dnd";
import { useDragSourceDisabled } from "@/components/epic-canvas/dnd/use-drag-source-disabled";
import {
  useRegisteredEpicLocalHome,
  useRegisteredEpicPermissionRole,
} from "@/lib/epic-selectors";
import {
  authorizesCloudCapability,
  useAuthStore,
} from "@/stores/auth/auth-store";
import type { TaskPinnedState } from "@/hooks/epic/use-epic-task-pinned-states-query";
import { useEpicWaitingReason } from "@/hooks/epic/use-epic-activity-status";
import { isEditableRole } from "@/lib/epic-permissions";
import { getOpenEpicRegistry } from "@/lib/registries/epic-session-registry";
import { getAppHostClientSnapshot } from "@/lib/host/runtime";
import { buildDialableHostClient } from "@/hooks/host/use-host-client-for";
import { HostRpcError } from "@traycer-clients/shared/host-transport/host-messenger";
import { toastFromHostError } from "@/lib/host-error-toast";
import {
  useInlineRename,
  type InlineRename,
} from "@/hooks/ui/use-inline-rename";
import { reconcileAuthoritativeEpicTitleInCloudTaskCaches } from "@/lib/cloud-epic-tasks-query/cache";
import {
  settleDetachedEpicTitleCommit,
  settleEpicTitleWrite,
} from "@/lib/epic-title-write-settlement";
import { useTabLeaderModifierForIndex } from "@/providers/keybinding-context";
import {
  leaderDigitFor,
  leaderHint,
} from "@/components/ui/leader-digit-shortcuts";
import type { HeaderTabDragGhost } from "@/components/epic-canvas/dnd/dnd-store";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { useHeaderTabTitle } from "./header-tab-presentation";
import { withWaitingIndicator } from "./tab-waiting";
import { mergeRefs } from "@/lib/merge-refs";
import type { PermissionRole } from "@traycer/protocol/host/epic/unary-schemas";
import type { TabSplitCommandId } from "@/stores/tabs/tab-split-commands";
import { tabResolveIntent } from "@/stores/tabs/registry";
import type { HeaderTabKind } from "@/stores/tabs/registry";
import {
  tabAppearance,
  type HeaderTab,
  type HeaderTabAppearance,
} from "@/stores/tabs/types";
import type { HostClient } from "@traycer-clients/shared/host-client/host-client";
import type { HostRpcRegistry } from "@/lib/host";
import { navigateToTabIntent } from "@/lib/tab-navigation";
import { tabRefKey } from "@/stores/tabs/layout";
import { reportableErrorToast } from "@/lib/reportable-error-toast";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";

const LONG_PRESS_CONTEXT_MENU_MS = 500;

export interface HeaderTabDndConfig {
  readonly stripItemId: string;
  readonly index: number;
  readonly isDropSlot: boolean;
}

export interface StripTabItemInput {
  readonly tab: HeaderTab;
  /** Member index; drives the Alt-digit leader badge. */
  readonly index: number;
  /** `null` makes this a member control inside a group-level reorder frame. */
  readonly dnd: HeaderTabDndConfig | null;
  readonly isActive: boolean;
  readonly onClose: (tab: HeaderTab) => void;
  readonly onCloseOtherTabs: (tab: HeaderTab) => void;
  readonly canCloseOtherTabs: boolean;
  readonly onDuplicateTab: (tab: HeaderTab) => void;
  readonly onOpenInNewWindow: (tab: HeaderTab) => void;
  readonly canOpenInNewWindow: boolean;
  readonly onSplitCommand: (id: TabSplitCommandId, tab: HeaderTab) => void;
  readonly taskPinnedState: TaskPinnedState | null;
  readonly isTaskPinPending: boolean;
  readonly onTaskPinMenuOpen: (epicId: string) => void;
  readonly onSetTaskPinned: (
    epicId: string,
    pinned: boolean,
    displayName: string,
  ) => void;
}

/** Attributes and handlers for the element that IS the tab. */
export interface StripTabRootProps {
  readonly role: "tab";
  readonly tabIndex: 0;
  readonly "aria-selected": boolean;
  readonly "data-testid": string;
  readonly "data-header-tab-key": string;
  readonly "data-tab-kind": HeaderTabKind;
  readonly "data-tab-index": number;
  readonly onClick: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  readonly onTouchStart: (event: TouchEvent<HTMLDivElement>) => void;
  readonly onTouchMove: () => void;
  readonly onTouchEnd: () => void;
  readonly onTouchCancel: () => void;
}

export interface StripTabLeaderBadge {
  readonly modifier: "alt";
  readonly index: number;
  readonly hint: string;
}

export interface StripTabItem {
  readonly rootRef: (node: HTMLDivElement | null) => void;
  /** Spread AFTER `dragListeners`, so the tab's own key handler wins. */
  readonly rootProps: StripTabRootProps;
  readonly dragListeners: DraggableSyntheticListeners;
  readonly isDragging: boolean;
  readonly appearance: HeaderTabAppearance | null;
  /** The notification indicator with the waiting reason merged in. */
  readonly indicatorState: NotificationIndicatorState;
  readonly displayName: string;
  readonly displayTab: HeaderTab;
  readonly canClose: boolean;
  readonly canEditTitle: boolean;
  readonly rename: InlineRename;
  readonly leaderBadge: StripTabLeaderBadge | null;
  readonly close: () => void;
  readonly setTaskPinned: (pinned: boolean) => void;
}

/**
 * The client an epic rename should be sent on.
 *
 * `null` host - no live session for that epic - keeps the app-wide client,
 * which is what this surface used before tabs carried a host at all. A NAMED
 * host resolves that host's own requester, and returning `null` when it cannot
 * be built is deliberate: the caller reports a failure rather than falling
 * back, because "rename the epic on the machine that holds it" and "rename it
 * on whichever machine this window happens to be pointed at" are different
 * requests, and silently substituting the second is how a rename lands against
 * a host that never had the epic.
 *
 * Built through `buildDialableHostClient` - the same builder every other
 * explicit-host consumer uses - rather than a second construction path.
 */
function epicRenameClient(
  hostId: string | null,
): HostClient<HostRpcRegistry> | null {
  const appClient = getAppHostClientSnapshot();
  if (appClient === null) return null;
  if (hostId === null || hostId === appClient.getActiveHostId()) {
    return appClient;
  }
  const entry = appClient.resolveHostById(hostId);
  if (entry === null) return null;
  return buildDialableHostClient(appClient, entry);
}

/**
 * A cloud-homed epic's rename is a CLOUD write sent over the local-host
 * connection, which does not carry the renderer's verdict - so the role
 * alone is not admission once the session is `unverified`. A local-homed
 * epic renames on this machine's own disk and stays editable. Same rule and
 * exemption as the History rows and the mobile header.
 */
function canEditEpicTabTitle(input: {
  readonly isEpicTab: boolean;
  readonly permissionRole: PermissionRole | null;
  readonly localHome: boolean;
  readonly cloudAuthorized: boolean;
}): boolean {
  return (
    input.isEpicTab &&
    isEditableRole(input.permissionRole) &&
    (input.localHome || input.cloudAuthorized)
  );
}

/**
 * Every per-tab behaviour of a strip tab - activation, drag, rename, long-press
 * menu, pin, leader badge and the merged indicator - independent of how the
 * tab is painted.
 */
export function useStripTabItem(input: StripTabItemInput): StripTabItem {
  const { tab, index, dnd, isActive, onClose, onSetTaskPinned } = input;
  const tabEpicId = tab.kind === "epic" ? tab.epicId : null;
  const appearance = tabAppearance(tab);
  // Read once here rather than inside `TabLeadingIcon`, so the SAME resolved
  // value can also ride the drag payload below - the strip item is the drag
  // source, and at the moment a drag starts it already holds everything the
  // ghost needs.
  const notificationState = useSurfaceNotificationIndicatorState(
    { epicId: tabEpicId ?? tab.id },
    null,
  );
  const sessionWaitingReason = useEpicWaitingReason(tabEpicId);
  const indicatorState = withWaitingIndicator(
    notificationState,
    sessionWaitingReason,
  );
  // `selectNotificationIndicatorState` returns a fresh object on every render
  // once any field is set, so a memo that closed over `indicatorState` itself
  // would recompute - and cascade into the draggable's `data` - on every
  // unrelated re-render. Destructured to locals here so the memo below closes
  // over the primitives it actually depends on, which is the same thing
  // `exhaustive-deps` then verifies rather than something it has to be told.
  const {
    unreadFailure,
    unreadNonTerminalFailure,
    unreadTerminalFailure,
    pendingFork,
    pendingApproval,
    pendingInterview,
    unreadDone,
  } = indicatorState;
  const dragGhost = useMemo<HeaderTabDragGhost>(
    () => ({
      appearance,
      indicatorState: {
        unreadFailure,
        unreadNonTerminalFailure,
        unreadTerminalFailure,
        pendingFork,
        pendingApproval,
        pendingInterview,
        unreadDone,
      },
    }),
    [
      appearance,
      unreadFailure,
      unreadNonTerminalFailure,
      unreadTerminalFailure,
      pendingFork,
      pendingApproval,
      pendingInterview,
      unreadDone,
    ],
  );
  const {
    ref: dndRef,
    listeners,
    isDragging,
  } = useHeaderTabDnd(tab.kind, tab.id, dnd, dragGhost);
  const tabRef = useRef<HTMLDivElement | null>(null);
  // No reveal of its own: the STRIP owns it (L-146). A per-item
  // `scrollIntoView` had no drag gate, revealed one half of a split group
  // rather than the member, and scrolled every scrollable ancestor with it.
  const rootRef = useCallback(
    (node: HTMLDivElement | null) => {
      dndRef(node);
      tabRef.current = node;
    },
    [dndRef],
  );
  const longPressTimerRef = useRef<number | null>(null);
  const modifier = useTabLeaderModifierForIndex(index);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { resolvedTabName, displayName } = useHeaderTabTitle(tab);
  const permissionRole = useRegisteredEpicPermissionRole(tabEpicId);
  const localHome = useRegisteredEpicLocalHome(tabEpicId);
  const cloudAuthorized = useAuthStore((state) =>
    authorizesCloudCapability(state.status),
  );
  const canEditTitle = canEditEpicTabTitle({
    isEpicTab: tab.kind === "epic",
    permissionRole,
    localHome,
    cloudAuthorized,
  });
  const canClose = tab.kind !== "epic" || tab.canClose;
  const displayTab = useMemo(
    () =>
      resolvedTabName === tab.name
        ? tab
        : {
            ...tab,
            name: resolvedTabName,
          },
    [resolvedTabName, tab],
  );
  const commitEpicTitle = useCallback(
    async (next: string) => {
      if (tab.kind !== "epic") return;
      // Re-checked at COMMIT: an edit opened before a demotion must not land
      // on the retained credential afterwards.
      if (
        !localHome &&
        !authorizesCloudCapability(useAuthStore.getState().status)
      ) {
        return;
      }
      const epicId = tab.epicId;
      const tabHostId = tab.hostId;
      const handle = getOpenEpicRegistry().peek(epicId);
      // The header strip is app-global and not guaranteed to sit inside a
      // HostRuntimeProvider, so reach the host client through the snapshot
      // rather than a render-time hook. It is the app-wide client, already
      // pinned to the effective host: this rename used to be issued on the
      // SPINE, which answered from the active slot, so the call landed on
      // whichever host was bound at the instant it was dispatched. Post-P4.2
      // the client addresses the host it resolved, and `hostId` below is that
      // same resolution rather than a second, independently-timed read.
      //
      // HOST-SCOPED where the tab knows its host. An epic served by a session
      // on host B was renamed through the app-wide client - host A - purely
      // because the strip had no way to know about B. `tab.hostId` is that
      // session's own answer projected onto the tab, so the rename now goes
      // where the epic actually lives. `null` (no live session) keeps the
      // app-wide client, which is all this surface ever had.
      const client = epicRenameClient(tabHostId);
      if (handle !== null) {
        const hostId = client?.getActiveHostId() ?? null;
        const userId = client?.getRequestContextUserId() ?? null;
        const state = handle.store.getState();
        const commandId = await state.enqueueWriteCommand({
          kind: "update-epic-title",
          title: next,
          updatedAt: Date.now(),
        });
        if (commandId === null) return;
        settleEpicTitleWrite(state.waitForWriteCommand(commandId), {
          onCommitted: () => {
            if (userId === null) return;
            reconcileAuthoritativeEpicTitleInCloudTaskCaches(
              queryClient,
              { hostId, userId },
              epicId,
              next,
            );
          },
          source: "Epic tabs",
        });
        return;
      }
      if (client === null) {
        reportableErrorToast(
          "Couldn't reach the host to rename the epic.",
          undefined,
          {
            title: "Could not rename Epic",
            message: "The host was unavailable.",
            code: null,
            source: "Epic tabs",
          },
        );
        return;
      }
      const hostId = client.getActiveHostId();
      const userId = client.getRequestContextUserId();
      // RETURNED, not voided: a two-arm `.then` does not catch what its own
      // handlers throw, so the cache update below - and the toast helper in the
      // other arm - had no terminal handler at all. Returning the chain routes
      // that into this callback's own promise, which the commit site now
      // settles.
      return client
        .request("epic.updateTitle", {
          epicDelta: { id: epicId, title: next, updatedAt: Date.now() },
        })
        .then(
          () => {
            if (userId === null) return;
            reconcileAuthoritativeEpicTitleInCloudTaskCaches(
              queryClient,
              { hostId, userId },
              epicId,
              next,
            );
          },
          (error: unknown) => {
            if (error instanceof HostRpcError) {
              toastFromHostError(error, "Couldn't rename epic.");
            } else {
              reportableErrorToast("Couldn't rename epic.", undefined, {
                title: "Could not rename Epic",
                message: null,
                code: null,
                source: "Epic tabs",
              });
            }
          },
        );
    },
    // The overlay reveals the authoritative title on failure rather than
    // restoring a captured one, so this callback does not depend on
    // `resolvedTabName`.
    [localHome, queryClient, tab],
  );
  const rename = useInlineRename({
    // Bind to the RAW title, not `displayName` - editing must never seed the
    // "Untitled task" fallback into the input and persist it as a real title.
    value: resolvedTabName,
    canEdit: canEditTitle,
    // Wrapped: the property is declared void-returning and the commit is a
    // round trip now. Fire-and-forget, but SETTLED - the enqueue inside can
    // reject on a real bridge fault, and unhandled that is a rename which
    // silently did nothing.
    onCommit: (next: string) => {
      settleDetachedEpicTitleCommit(commitEpicTitle(next), "Epic tabs");
    },
  });

  const activateTab = useCallback(() => {
    if (rename.isEditing) return;
    navigateToTabIntent(navigate, tabResolveIntent(tab), undefined);
  }, [navigate, rename.isEditing, tab]);
  // Chrome selects a tab the moment a drag picks it up, not on release - the
  // tab travelling under the pointer must be the active one. Click activation
  // cannot cover this: a completed drag suppresses the click. Runs only on the
  // false→true edge (isActive flips right after, ending the effect's work).
  useEffect(() => {
    if (!isDragging || isActive) return;
    activateTab();
  }, [activateTab, isActive, isDragging]);
  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (rename.isEditing) return;
      // A key on a button inside the tab (close, chevron) is that button's.
      if (event.target !== event.currentTarget) return;
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      activateTab();
    },
    [activateTab, rename.isEditing],
  );
  const cancelLongPress = useCallback(() => {
    if (longPressTimerRef.current === null) return;
    window.clearTimeout(longPressTimerRef.current);
    longPressTimerRef.current = null;
  }, []);
  const handleTouchStart = useCallback(
    (event: TouchEvent<HTMLDivElement>) => {
      cancelLongPress();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null;
        tabRef.current?.dispatchEvent(
          new MouseEvent("contextmenu", {
            bubbles: true,
            cancelable: true,
            clientX: touch.clientX,
            clientY: touch.clientY,
          }),
        );
      }, LONG_PRESS_CONTEXT_MENU_MS);
    },
    [cancelLongPress],
  );
  const setTaskPinned = useCallback(
    (pinned: boolean) => {
      if (tab.kind !== "epic") return;
      onSetTaskPinned(tab.epicId, pinned, displayName);
    },
    [displayName, onSetTaskPinned, tab],
  );
  const close = useCallback(() => onClose(displayTab), [displayTab, onClose]);

  const leaderBadge: StripTabLeaderBadge | null =
    modifier === null
      ? null
      : {
          modifier,
          index,
          hint: leaderHint(
            leaderDigitFor(index),
            modifier,
            "to switch to",
            displayName,
          ),
        };
  return {
    rootRef,
    rootProps: {
      role: "tab",
      tabIndex: 0,
      "aria-selected": isActive,
      "data-testid": `tab-${tab.kind}-${tab.id}`,
      "data-header-tab-key": tabRefKey(tab),
      "data-tab-kind": tab.kind,
      "data-tab-index": index,
      onClick: activateTab,
      onKeyDown: handleKeyDown,
      onTouchStart: handleTouchStart,
      onTouchMove: cancelLongPress,
      onTouchEnd: cancelLongPress,
      onTouchCancel: cancelLongPress,
    },
    dragListeners: listeners,
    isDragging,
    appearance,
    indicatorState,
    displayName,
    displayTab,
    canClose,
    canEditTitle,
    rename,
    leaderBadge,
    close,
    setTaskPinned,
  };
}

interface UseHeaderTabDndReturn {
  readonly ref: (element: HTMLElement | null) => void;
  readonly listeners: DraggableSyntheticListeners;
  readonly isDragging: boolean;
}

function useHeaderTabDnd(
  tabKind: HeaderTabKind,
  tabId: string,
  config: HeaderTabDndConfig | null,
  ghost: HeaderTabDragGhost,
): UseHeaderTabDndReturn {
  const dragData = useMemo<
    HeaderTabDragData & { readonly ghost: HeaderTabDragGhost }
  >(
    () => ({
      kind: HEADER_TAB_DND_TYPE,
      stripItemId: config?.stripItemId ?? `member:${tabKind}:${tabId}`,
      tabKind,
      tabId,
      index: config?.index ?? 0,
      // Render-ready enrichment for the drag ghost - read once, right here,
      // where the strip already holds it resolved. `root-dnd-provider.tsx`
      // reads it back via `readHeaderTabDragGhost` at drag start, so the
      // overlay never re-derives it with a host RPC / notifications query.
      ghost,
    }),
    [config, tabId, tabKind, ghost],
  );
  // A `tab:` strip item is already unique per tab, so it keys on the tab id
  // alone. A split member shares its tab id with nothing but must stay distinct
  // per half, so it keys on `<splitId>:<tabId>`; an unconfigured (undraggable)
  // item falls back to the same shape under `member`.
  const stripItemId = config?.stripItemId ?? "member";
  const dragKey = stripItemId.startsWith("tab:")
    ? tabId
    : `${stripItemId}:${tabId}`;
  const dragDisabled = useDragSourceDisabled();
  const {
    listeners,
    setNodeRef: dragRef,
    isDragging,
  } = useDraggable({
    id: getHeaderTabDragId(tabKind, dragKey),
    data: dragData,
    disabled: config === null || dragDisabled,
  });
  const dropData = useMemo<HeaderTabSlotDropData>(
    () => ({
      kind: HEADER_TAB_SLOT_DND_TYPE,
      index: config?.index ?? 0,
      isTrailing: false,
    }),
    [config],
  );
  const { setNodeRef: dropRef } = useDroppable({
    id: getHeaderTabSlotDropId(
      tabKind,
      `${config?.stripItemId ?? "member"}:${tabId}`,
    ),
    data: dropData,
    // The source stays mounted as a full-width layout placeholder while the
    // overlay follows the pointer. It must not remain a collision target: once
    // provisional order moves that placeholder under the pointer it would
    // steal `over` from the neighbour whose center actually opened the slot.
    disabled: config === null || !config.isDropSlot || isDragging,
  });
  const ref = useMemo(
    () => mergeRefs<HTMLElement>(dragRef, dropRef),
    [dragRef, dropRef],
  );
  return { ref, listeners, isDragging };
}
