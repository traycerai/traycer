import { useStore } from "zustand";
import type { LucideIcon } from "lucide-react";
import { NotificationIndicatorIcon } from "@/components/notifications/notification-indicator-icon";
import { useSurfaceNotificationIndicatorState } from "@/components/notifications/notification-indicator-context";
import { useEpicActiveAgentIds } from "@/lib/epic-selectors";
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
}

export function ChatProgressIcon(props: ChatProgressIconProps) {
  // Sidebar-level awareness covers chats running host-side without a renderer
  // session handle. An opened session only adds run-status race smoothing;
  // notification rows own prompt and outcome presentation.
  const isActive = useEpicActiveAgentIds().has(props.chatId);
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
        subjectId={props.chatId}
        className={props.className}
        mutedClassName={props.mutedClassName}
        testId={props.testId}
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
}) {
  // `useStore(api, selector)` instead of `props.handle.store(...)`: the
  // bound-store call form isn't recognizable as a hook to the React Compiler,
  // which memoizes it away and corrupts the hook order.
  const runStatus = useStore(props.handle.store, (state) => state.runStatus);
  return (
    <ChatProgressPresentation
      indicatorState={props.indicatorState}
      isRunning={props.isActive || isChatRunInProgress(runStatus)}
      subjectId={props.subjectId}
      className={props.className}
      mutedClassName={props.mutedClassName}
      testId={props.testId}
    />
  );
}

function ChatProgressPresentation(props: {
  readonly indicatorState: NotificationIndicatorState;
  readonly isRunning: boolean;
  readonly subjectId: string;
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
}) {
  const icon = useChatIconDisplay(props.className, props.mutedClassName);
  const Icon: LucideIcon = EPIC_NODE_ICONS.chat;
  return (
    <NotificationIndicatorIcon
      state={props.indicatorState}
      running={props.isRunning}
      subjectId={props.subjectId}
      testIdPrefix={props.testId}
      className={icon.className}
      style={icon.style}
      runningTitle="Chat in progress"
      defaultIcon={<Icon className={icon.className} style={icon.style} />}
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
