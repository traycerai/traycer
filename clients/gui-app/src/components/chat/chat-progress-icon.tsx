import type { LucideIcon } from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { useEpicActiveAgentIds } from "@/lib/epic-selectors";
import { useExistingChatSessionHandle } from "@/lib/registries/chat-session-registry";
import {
  isChatRunInProgress,
  type ChatSessionState,
  type ChatSessionStoreHandle,
} from "@/stores/chats/chat-session-store";
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
  // Sidebar-level authority: epic-wide active-agent awareness covers chats that
  // are running host-side without any renderer session handle (e.g. subagent-
  // created chats the user has never opened). The session handle, when present,
  // only enriches this with waiting-for-approval styling and `runStatus` race
  // smoothing.
  const isActive = useEpicActiveAgentIds().has(props.chatId);
  const handle = useExistingChatSessionHandle(props.epicId, props.chatId);
  if (handle === null) {
    if (!isActive) {
      return (
        <StaticChatIcon
          className={props.className}
          mutedClassName={props.mutedClassName}
        />
      );
    }
    return (
      <RunningChatSpinner
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
      className={props.className}
      mutedClassName={props.mutedClassName}
      testId={props.testId}
    />
  );
}

function ChatProgressIconWithHandle(props: {
  readonly handle: ChatSessionStoreHandle;
  readonly isActive: boolean;
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
}) {
  const runStatus = props.handle.store((state) => state.runStatus);
  const waitingForApproval = props.handle.store(chatWaitingForApproval);
  // Awareness is the primary signal; `runStatus` keeps the spinner alive when
  // awareness briefly lags behind an opened chat that is still running.
  const isWorking = props.isActive || isChatRunInProgress(runStatus);
  if (!isWorking) {
    return (
      <StaticChatIcon
        className={props.className}
        mutedClassName={props.mutedClassName}
      />
    );
  }
  if (waitingForApproval) {
    return (
      <WaitingChatSpinner
        className={props.className}
        mutedClassName={props.mutedClassName}
        testId={props.testId}
      />
    );
  }
  return (
    <RunningChatSpinner
      className={props.className}
      mutedClassName={props.mutedClassName}
      testId={props.testId}
    />
  );
}

function RunningChatSpinner(props: {
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
}) {
  const icon = useChatIconDisplay(props.className, props.mutedClassName);
  return (
    <span
      className={cn(icon.className, "inline-flex items-center justify-center")}
      style={icon.style}
      title="Chat in progress"
    >
      <AgentSpinningDots
        className="text-current"
        testId={props.testId}
        variant={undefined}
      />
    </span>
  );
}

function WaitingChatSpinner(props: {
  readonly className: string | undefined;
  readonly mutedClassName: string;
  readonly testId: string;
}) {
  const icon = useChatIconDisplay(props.className, props.mutedClassName);
  return (
    <span
      className={cn(icon.className, "inline-flex items-center justify-center")}
      title="Waiting for your approval"
    >
      <AgentSpinningDots
        className="text-red-500"
        testId={props.testId}
        variant="waiting"
      />
    </span>
  );
}

function StaticChatIcon(props: {
  readonly className: string | undefined;
  readonly mutedClassName: string;
}) {
  const icon = useChatIconDisplay(props.className, props.mutedClassName);
  const Icon: LucideIcon = EPIC_NODE_ICONS.chat;
  return <Icon className={icon.className} style={icon.style} />;
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

function chatWaitingForApproval(state: ChatSessionState): boolean {
  return (
    state.pendingApprovals.length > 0 ||
    state.pendingFileEditApprovals.length > 0 ||
    state.pendingInterviews.length > 0
  );
}
