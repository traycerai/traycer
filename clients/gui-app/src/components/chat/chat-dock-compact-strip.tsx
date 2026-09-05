import type { ReactNode } from "react";
import { Activity, Bot, FileDiff } from "lucide-react";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import {
  ChatDockCompactStripContext,
  useChatDockCompactStrip,
  type ChatDockSection,
  type ChatDockCompactStripValue,
} from "@/components/chat/chat-dock-compact-context";

export type {
  ChatDockCompactChipModel,
  ChatDockCompactStripValue,
  ChatDockSection,
} from "@/components/chat/chat-dock-compact-context";

export function ChatDockCompactStripProvider(props: {
  readonly value: ChatDockCompactStripValue;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <ChatDockCompactStripContext.Provider value={props.value}>
      {props.children}
    </ChatDockCompactStripContext.Provider>
  );
}

const CHIP_ICONS: Record<ChatDockSection, ReactNode> = {
  filesChanged: <FileDiff className="size-3.5 shrink-0" aria-hidden />,
  activeAgents: <Bot className="size-3.5 shrink-0" aria-hidden />,
  background: <Activity className="size-3.5 shrink-0" aria-hidden />,
};

/**
 * The compact chips, at the head of the composer's bottom strip - ahead of the
 * host and workspace chips, because they describe this chat's own activity and
 * those describe where it runs.
 *
 * Renders nothing outside a chat tile, and nothing inside one whose every row
 * is either on screen or empty.
 */
export function ChatDockCompactStrip(): ReactNode {
  const value = useChatDockCompactStrip();
  if (value === null || value.chips.length === 0) return null;
  return (
    <div
      data-testid="chat-dock-compact-strip"
      className="flex min-w-0 shrink-0 items-center gap-1"
    >
      {value.chips.map((chip) => (
        <ChatDockCompactChip
          key={chip.section}
          icon={CHIP_ICONS[chip.section]}
          text={chip.text}
          label={chip.label}
          pulseToken={chip.pulseToken}
          expanded={value.expanded.has(chip.section)}
          testId={`chat-dock-chip-${chip.section}`}
          onClick={() => {
            value.onToggle(chip.section);
          }}
        />
      ))}
    </div>
  );
}
