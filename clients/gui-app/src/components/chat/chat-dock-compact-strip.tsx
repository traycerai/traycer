import { useCallback, useRef, type ReactNode } from "react";
import {
  Bot,
  FileDiff,
  Layers,
  PauseCircle,
  type LucideIcon,
} from "lucide-react";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
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

const GLYPH_ICONS: Readonly<Record<ChatDockCompactChipGlyph, LucideIcon>> = {
  filesChanged: FileDiff,
  activeAgents: Bot,
  mixed: Layers,
  // A shell only rests once it is held, so this is the panel's held glyph -
  // the one that row shows beside the word "Held" - and never the radar its
  // running sibling draws.
  managedShell: PauseCircle,
  ...BACKGROUND_KIND_ICONS,
};

/**
 * One blink: full opacity for the first half, dimmed for the second. A
 * multiple of the clock's 12.5 Hz pulse cadence, so both edges land exactly on
 * a tick rather than one tick late.
 */
const BLINK_CYCLE_MS = 1280;
const BLINK_DIM_OPACITY = "0.4";

/**
 * The icon of a section with something in flight, blinking on the app's shared
 * status clock.
 *
 * Two opacities with no transition between them - it BLINKS rather than
 * breathing, which is what tells a glance "still going" on a 14px glyph - and
 * every working chip in the window is driven from the one clock, so N chips
 * cost one tick, not N.
 *
 * Deliberately not a CSS `animation` (nor `animate-pulse`): Blink samples
 * every running animation once per display frame and recalcs the element's
 * style against this stylesheet, which is the always-on-indicator regression
 * `status-animation-clock.ts` and `index.css` both record. An inline-style
 * write is also invisible to selector matching, so a `:has()` subject above
 * the composer cannot be invalidated by the blink the way a class swap could.
 *
 * `useStatusAnimation` never subscribes under reduced motion and clears what
 * it wrote the moment the preference turns on, so the icon rests at its
 * stylesheet opacity and the corner mark below carries the state instead.
 */
function BlinkingChipIcon(props: { readonly glyph: ChatDockCompactChipGlyph }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const write = useCallback((element: SVGSVGElement, elapsedMs: number) => {
    const dim = elapsedMs % BLINK_CYCLE_MS >= BLINK_CYCLE_MS / 2;
    element.style.opacity = dim ? BLINK_DIM_OPACITY : "1";
  }, []);
  const clear = useCallback((element: SVGSVGElement) => {
    element.style.opacity = "";
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_PULSE_CADENCE_MS);
  const Icon = GLYPH_ICONS[props.glyph];
  return (
    <Icon ref={ref} className="size-3.5 shrink-0 text-foreground" aria-hidden />
  );
}

/**
 * The section's icon, blinking while its section is busy.
 *
 * Activity is carried BY the icon rather than by a glyph that replaces it: the
 * icon is the only thing saying which section a chip stands for, and swapping
 * it for a spinner made two busy chips read as one repeated thing.
 *
 * Reduced motion gets a small filled dot at the icon's corner instead - the
 * same fact stated as presence rather than as movement, since an icon that
 * simply stopped blinking would read as idle. The two are exclusive: the clock
 * does not tick under the preference, and the dot is shown by the media query
 * alone, so the chip never carries both.
 *
 * A working icon also takes `text-foreground`, displacing the chip's muted
 * inherit: the blink's dim half is 40% opacity, so it needs a base strong
 * enough for that step to register at 14px. The chip already reads
 * `text-foreground` while expanded or hovered, so the tone is a second
 * statement of the blink rather than a channel of its own.
 *
 * `data-chip-activity` on the wrapper (and `data-chip-activity-dot` on the
 * corner mark) is the hook for the suites that pin all of this; a resting chip
 * renders the bare icon with neither.
 */
function ChipGlyph(props: {
  readonly glyph: ChatDockCompactChipGlyph;
  readonly working: boolean;
}) {
  if (!props.working) {
    const Icon = GLYPH_ICONS[props.glyph];
    return <Icon className="size-3.5 shrink-0" aria-hidden />;
  }
  return (
    <span data-chip-activity className="relative inline-flex">
      <BlinkingChipIcon glyph={props.glyph} />
      <span
        aria-hidden
        data-chip-activity-dot
        className="pointer-events-none absolute -top-0.5 -right-0.5 hidden size-1.5 rounded-full bg-primary ring-1 ring-background motion-reduce:block"
      />
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
          icon={<ChipGlyph glyph={chip.glyph} working={chip.working} />}
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
