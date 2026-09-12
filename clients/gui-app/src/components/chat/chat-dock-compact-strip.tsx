import { useCallback, useRef, type ReactNode } from "react";
import { Bot, FileDiff, Layers, Terminal, type LucideIcon } from "lucide-react";
import { BACKGROUND_KIND_ICONS } from "@/lib/chat/background-kind-icon";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
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

/**
 * One sweep a second - slow enough to read as breathing rather than blinking on
 * a 14px mark, and the cadence the rest of the window's live indicators keep.
 */
const GLYPH_SHIMMER_CYCLE_MS = 1000;

/**
 * The dimmest the glyph gets. Far enough down to read as motion at this size,
 * far enough from zero that the icon never blinks OUT - it is the only thing
 * saying which section the chip stands for, so it stays legible at every point
 * of the sweep.
 */
const GLYPH_SHIMMER_TROUGH_OPACITY = 0.35;

/**
 * The sweep: brightest at the top of the cycle, dimmest at its midpoint, on a
 * cosine so neither end is a corner.
 */
function glyphShimmerOpacity(elapsedMs: number): number {
  const phase = (elapsedMs / GLYPH_SHIMMER_CYCLE_MS) % 1;
  const dip = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  return 1 - (1 - GLYPH_SHIMMER_TROUGH_OPACITY) * dip;
}

/**
 * The lit glyph itself, shimmering on the shared status clock.
 *
 * The animated element is the lucide `<svg>` itself, with no wrapper of its
 * own: the sweep is the only thing drawn on top of the icon now, so there is
 * nothing for a box around it to hold. `useStatusAnimation` takes an SVG ref
 * for exactly this.
 *
 * Reduced motion needs no rule here. The hook never subscribes under the
 * preference and clears the inline `opacity` the moment it turns on, so the
 * glyph holds at the full `text-primary` its class gives it - tone intact,
 * sweep gone - and the chip still says "running" in the tone it shares with
 * its count.
 */
function ShimmeringGlyph(props: { readonly icon: LucideIcon }) {
  const ref = useRef<SVGSVGElement | null>(null);
  const write = useCallback((element: SVGSVGElement, elapsedMs: number) => {
    element.style.opacity = glyphShimmerOpacity(elapsedMs).toFixed(3);
  }, []);
  const clear = useCallback((element: SVGSVGElement) => {
    element.style.opacity = "";
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_PULSE_CADENCE_MS);
  const Icon = props.icon;
  return (
    <Icon
      ref={ref}
      data-chip-glyph-shimmer
      className="size-3.5 shrink-0 text-primary"
      aria-hidden
    />
  );
}

/**
 * The section's icon, lit while its section is busy.
 *
 * Activity is carried BY the icon rather than by a glyph that replaces it: the
 * icon is the only thing saying which section a chip stands for, and swapping
 * it for a spinner made two busy chips read as one repeated thing.
 *
 * And it is carried by the icon ALONE, now that the chip prints no word for it:
 * a chip is `[icon] N` at every width. The glyph says it twice over -
 * `text-primary` displacing the chip's muted inherit, and a shimmer sweeping
 * that tone - and the count beside it turns `primary` too, in
 * `ChatDockCompactChip`, since it is text.
 *
 * It says it in those two channels and no more. A filled dot at the glyph's
 * top-right corner, throwing the app's ping ring, was the third; at this size
 * it landed ON the icon rather than beside it, so a terminal running under a
 * mark obscuring its own corner read as neither. One mark, one meaning: the
 * icon is the section AND the state, and nothing overlaps it.
 *
 * The shimmer is clock-driven rather than a CSS `animation` - the always-on
 * indicator rule `status-animation-clock.ts` and `index.css` both record. It
 * does not subscribe under reduced motion, where the glyph simply holds its
 * full tone; the tones are unconditional, so the reduced-motion chip still
 * says "running" with no media query of its own.
 *
 * `data-chip-glyph-shimmer` on the glyph is the hook for the suites that pin
 * this; a resting chip renders the bare icon without it.
 */
function ChipGlyph(props: {
  readonly glyph: ChatDockCompactChipGlyph;
  readonly working: boolean;
}) {
  const Icon = GLYPH_ICONS[props.glyph];
  if (!props.working) {
    return <Icon className="size-3.5 shrink-0" aria-hidden />;
  }
  return <ShimmeringGlyph icon={Icon} />;
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
          working={chip.working}
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
