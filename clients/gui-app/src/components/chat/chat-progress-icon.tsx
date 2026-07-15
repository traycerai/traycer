import { type ReactNode } from "react";
import { useStore } from "zustand";
import { MessageSquareLock } from "lucide-react";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import {
  useEpicActiveAgentIds,
  useEpicPermissionRole,
} from "@/lib/epic-selectors";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import {
  isChatRunInProgress,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
import type { NotificationIndicatorState } from "@/stores/notifications/notification-indicator-state";
import { EPIC_NODE_ICONS } from "@/lib/artifacts/node-display";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settings/settings-store";

interface ChatProgressIconProps {
  readonly epicId: string;
  readonly chatId: string;
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
  const isActive = useEpicActiveAgentIds().has(props.chatId);
  const fallbackReadOnly = useEpicPermissionRole() === "viewer";
  const handle = useExistingChatSessionHandle(props.epicId, props.chatId);
  const indicatorState = useSurfaceNotificationIndicatorState({
    epicId: props.epicId,
    chatId: props.chatId,
  });
  if (handle === null) {
    return (
      <ChatProgressPresentation
        indicatorState={indicatorState}
        isRunning={isActive}
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
      isActive={isActive}
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
  readonly isActive: boolean;
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
  const runStatus = useStore(props.handle.store, (state) => state.runStatus);
  const access = useStore(props.handle.store, (state) => state.access);
  return (
    <ChatProgressPresentation
      indicatorState={props.indicatorState}
      isRunning={props.isActive || isChatRunInProgress(runStatus)}
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
  readonly isRunning: boolean;
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
      <span
        role="status"
        aria-label="Read-only chat"
        className={icon.className}
        style={icon.style}
        title="Read-only chat"
      >
        <MessageSquareLock aria-hidden className="size-3.5" />
      </span>
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
      running={props.isRunning}
      subjectId={props.subjectId}
      testIdPrefix={props.testId}
      className={icon.className}
      style={icon.style}
      runningTitle="Chat in progress"
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
