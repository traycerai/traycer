import { type ReactNode } from "react";
import { Bot, FileDiff, Layers, Terminal, type LucideIcon } from "lucide-react";
import { BACKGROUND_KIND_ICONS } from "@/lib/chat/background-kind-icon";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { PingRing } from "@/components/ui/ping-ring";
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

const GLYPH_ICONS: Readonly<Record<ChatDockCompactChipGlyph, LucideIcon>> = {
  filesChanged: FileDiff,
  activeAgents: Bot,
  mixed: Layers,
  // A host-supervised shell is a terminal, whatever it is doing. It is
  // deliberately NOT the panel's pause glyph: that glyph earns its meaning from
  // the word "Held" printed beside it on the row, and a chip has no such word,
  // so `PauseCircle` over a shell following a PR simply said the shell was
  // paused. Held is stated in this chip's sentence instead.
  managedShell: Terminal,
  ...BACKGROUND_KIND_ICONS,
};

/** Strong enough to read against the composer's own chrome, short of a solid fill. */
const ACTIVITY_RING_PEAK_OPACITY = 0.75;

/**
 * The section's icon, lit while its section is busy.
 *
 * Activity is carried BY the icon rather than by a glyph that replaces it: the
 * icon is the only thing saying which section a chip stands for, and swapping
 * it for a spinner made two busy chips read as one repeated thing.
 *
 * Busy is stated three times over, because at 14px in the corner of a composer
 * one statement is not enough - this chip blinked for a whole round of testing
 * and read as idle. The icon takes `text-primary` (displacing the chip's muted
 * inherit), a filled dot sits at its top-right corner, and that dot throws the
 * app's `PingRing`. The count beside it turns `primary` too, and the chip adds
 * the word for what is happening wherever the composer row has room; both of
 * those live in `ChatDockCompactChip`, since they are text.
 *
 * One motion, not two: the ring is the whole of it, and the icon holds still.
 * An icon that blinked UNDER an expanding ring was two rhythms fighting on a
 * glyph the size of a word.
 *
 * `PingRing` is clock-driven rather than a CSS `animation` - the always-on
 * indicator rule `status-animation-clock.ts` and `index.css` both record - and
 * it never subscribes under reduced motion, where it collapses to a static span
 * exactly the size of the dot it sits behind. The dot and the tones are
 * unconditional, so the reduced-motion chip still says "running" in two
 * channels with no media query of its own.
 *
 * `data-chip-activity` on the wrapper (and `data-chip-activity-dot` on the
 * corner mark) is the hook for the suites that pin all of this; a resting chip
 * renders the bare icon with neither.
 */
function ChipGlyph(props: {
  readonly glyph: ChatDockCompactChipGlyph;
  readonly working: boolean;
}) {
  const Icon = GLYPH_ICONS[props.glyph];
  if (!props.working) {
    return <Icon className="size-3.5 shrink-0" aria-hidden />;
  }
  return (
    <span data-chip-activity className="relative inline-flex">
      <Icon className="size-3.5 shrink-0 text-primary" aria-hidden />
      {/* `absolute` is itself a containing block, so this IS the "relative
          inline-flex box the size of the dot" the ring asks to sit inside. */}
      <span
        aria-hidden
        data-chip-activity-dot
        className="pointer-events-none absolute -top-0.5 -right-0.5 inline-flex size-1.5"
      >
        <PingRing
          toneClass="bg-primary"
          peakOpacity={ACTIVITY_RING_PEAK_OPACITY}
        />
        <span className="relative inline-flex h-full w-full rounded-full bg-primary ring-1 ring-background" />
      </span>
    </span>
  );
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
          icon={
            <ChipGlyph glyph={chip.glyph} working={chip.workingWord !== null} />
          }
          text={chip.text}
          workingWord={chip.workingWord}
          lineDeltas={chip.lineDeltas}
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
