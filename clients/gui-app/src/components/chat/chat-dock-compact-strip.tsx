import type { ReactNode } from "react";
import {
  Bot,
  FileDiff,
  Layers,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import { AgentSpinningDots } from "@/components/ui/agent-spinning-dots";
import { BACKGROUND_KIND_ICONS } from "@/lib/chat/background-kind-icon";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import {
  ChatDockCompactStripContext,
  useChatDockCompactStrip,
  type ChatDockCompactChipGlyph,
  type ChatDockCompactStripValue,
} from "@/components/chat/chat-dock-compact-context";

export type {
  ChatDockCompactChipGlyph,
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

const GLYPH_ICONS: Readonly<
  Record<Exclude<ChatDockCompactChipGlyph, "working">, LucideIcon>
> = {
  filesChanged: FileDiff,
  activeAgents: Bot,
  mixed: Layers,
  // A shell only rests once it is held, so this is the panel's held glyph -
  // the one that row shows beside the word "Held" - and never the radar its
  // running sibling draws.
  managedShell: PauseCircle,
  ...BACKGROUND_KIND_ICONS,
};

/** Test id of the spinner a working chip draws in place of its icon. */
export const CHAT_DOCK_CHIP_WORKING_TEST_ID = "chat-dock-chip-working";

function ChipGlyph(props: { readonly glyph: ChatDockCompactChipGlyph }) {
  if (props.glyph === "working") {
    return (
      <AgentSpinningDots
        className="text-current"
        testId={CHAT_DOCK_CHIP_WORKING_TEST_ID}
        variant={undefined}
      />
    );
  }
  const Icon = GLYPH_ICONS[props.glyph];
  return <Icon className="size-3.5 shrink-0" aria-hidden />;
}

/**
 * The compact chips, at the tail of the composer's bottom strip - after the
 * host and workspace chips, hard against the context-usage cluster. They come
 * and go with what the chat is doing, and the tail is where that can happen
 * without the pickers on the left shifting under the pointer.
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
      className="ml-auto flex min-w-0 shrink-0 items-center gap-1"
    >
      {value.chips.map((chip) => (
        <ChatDockCompactChip
          key={chip.section}
          icon={<ChipGlyph glyph={chip.glyph} />}
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
