import { type ReactNode } from "react";
import { useStore } from "zustand";
import { MessageSquareLock } from "lucide-react";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import {
  useEpicAgentActivityTiers,
  useEpicPermissionRole,
} from "@/lib/epic-selectors";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import { chatActivityIndicator } from "@/components/epic-canvas/renderers/chat-tile-session-state";
import type { IndicatorRunningKind } from "@/components/notifications/notification-indicator-icon";
import type { ChatSessionStoreHandle } from "@/stores/chats/chat-session-store";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";

import { TooltipWrapper } from "@/components/ui/tooltip-wrapper";
interface ChatProgressIconProps {
  readonly epicId: string;
  readonly chatId: string;
  readonly originHostId: string | null;
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
  /**
   * Optional idle-slot content (e.g. title-generation spinner). Shown only
   * when no notification status, running state, or read-only lock replaces it.
   */
  readonly defaultIcon: ReactNode | undefined;
}

export function ChatProgressIcon(props: ChatProgressIconProps) {
  // Sidebar-level awareness covers chats running host-side without a renderer
  // session handle. An opened session adds run-status race smoothing and
  // authoritative chat access; notification rows own prompt and outcome
  // presentation.
  //
  // Read as a TIER, not as membership of the active-id set. The two have
  // identical membership, but the set alone cannot say whether an unopened
  // chat is mid-turn or merely kept alive by background work, so it forced the
  // turn spinner on both. The tier is the same awareness data the descendant
  // rollup already reads, so a background-only chat now presents the same way
  // whether you look at its own row or at the collapsed parent standing in
  // for it. A host that has not classified its agents still reports `"turn"`.
  const awarenessRunning: IndicatorRunningKind =
    useEpicAgentActivityTiers().get(props.chatId) ?? false;
  const fallbackReadOnly = useEpicPermissionRole() === "viewer";
  const handle = useExistingChatSessionHandle(props.epicId, props.chatId);
  const indicatorState = useSurfaceNotificationIndicatorState(
    {
      epicId: props.epicId,
      chatId: props.chatId,
    },
    props.originHostId,
  );
  if (handle === null) {
    return (
      <ChatProgressPresentation
        indicatorState={indicatorState}
        running={awarenessRunning}
        isReadOnly={fallbackReadOnly}
        subjectId={props.chatId}
        className={props.className}
        mutedClassName={props.mutedClassName}
        testId={props.testId}
        defaultIcon={props.defaultIcon}
      />
    );
  }
  return (
    <ChatProgressIconWithHandle
      handle={handle}
      awarenessRunning={awarenessRunning}
      indicatorState={indicatorState}
      className={props.className}
      mutedClassName={props.mutedClassName}
      testId={props.testId}
      subjectId={props.chatId}
      defaultIcon={props.defaultIcon}
    />
  );
}

function ChatProgressIconWithHandle(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly awarenessRunning: IndicatorRunningKind;
  readonly indicatorState: NotificationIndicatorState;
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
  readonly subjectId: string;
  readonly defaultIcon: ReactNode | undefined;
}) {
  // `useStore(api, selector)` instead of `props.handle.store(...)`: the
  // bound-store call form isn't recognizable as a hook to the React Compiler,
  // which memoizes it away and corrupts the hook order.
  //
  // The selector collapses the session state to the tri-state activity kind
  // (a primitive), so array-identity churn on queue/backgroundItems can't
  // re-render this icon.
  const activity = useStore(props.handle.store, (state) =>
    chatActivityIndicator(state),
  );
  const access = useStore(props.handle.store, (state) => state.access);
  return (
    <ChatProgressPresentation
      indicatorState={props.indicatorState}
      // The session's own tri-state is authoritative when it reads any
      // activity: it sees the queue and background items directly, while
      // awareness reports what the HOST classified. Awareness only backfills
      // the brief subscription-gap window where the store still reads idle.
      running={activity ?? props.awarenessRunning}
      // A session's access snapshot is authoritative. Keep the icon neutral
      // while it is unknown so an owner never sees the unopened-chat fallback
      // lock flash before the snapshot arrives.
      isReadOnly={access !== null && access.role !== "owner"}
      subjectId={props.subjectId}
      className={props.className}
      mutedClassName={props.mutedClassName}
      testId={props.testId}
      defaultIcon={props.defaultIcon}
    />
  );
}

function ChatProgressPresentation(props: {
  readonly indicatorState: NotificationIndicatorState;
  readonly running: IndicatorRunningKind;
  readonly isReadOnly: boolean;
  readonly subjectId: string;
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
  readonly defaultIcon: ReactNode | undefined;
}) {
  const icon = useChatIconDisplay(props.className, props.mutedClassName);
  let idleIcon: ReactNode;
  if (props.isReadOnly) {
    idleIcon = (
      <TooltipWrapper
        label="Read-only agent"
        side="top"
        sideOffset={undefined}
        align={undefined}
      >
        <span
          role="status"
          aria-label="Read-only agent"
          className={icon.className}
          style={icon.style}
        >
          <MessageSquareLock aria-hidden className="size-3.5" />
        </span>
      </TooltipWrapper>
    );
  } else if (props.defaultIcon !== undefined) {
    idleIcon = props.defaultIcon;
  } else {
    idleIcon = (
      <EPIC_NODE_ICONS.chat className={icon.className} style={icon.style} />
    );
  }
  return (
    <NotificationIndicatorIcon
      state={props.indicatorState}
      running={props.running}
      subjectId={props.subjectId}
      testIdPrefix={props.testId}
      className={icon.className}
      style={icon.style}
      runningTitle="Agent in progress"
      defaultIcon={idleIcon}
      statusPresentation="message"
    />
  );
}

function useChatIconDisplay(
  className: string | undefined,
  mutedClassName: string,
): {
  readonly className: string;
  readonly style: { color: string | undefined } | undefined;
} {
  const colorMode = useSettingsStore((s) => s.artifactIconColorMode);
  const color = useSettingsStore((s) => s.artifactIconColors.chat);
  return {
    className: cn(
      "size-3.5 shrink-0",
      colorMode === "none" && mutedClassName,
      className,
    ),
    style: colorMode === "byType" ? { color } : undefined,
  };
}
