import { useCallback, useRef, type ReactNode } from "react";
import { Bot, FileDiff, Layers, Terminal, type LucideIcon } from "lucide-react";
import { BACKGROUND_KIND_ICONS } from "@/lib/chat/background-kind-icon";
import { ChatDockCompactChip } from "@/components/chat/chat-dock-compact-chip";
import { PingRing } from "@/components/ui/ping-ring";
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

/** Strong enough to read against the composer's own chrome, short of a solid fill. */
const ACTIVITY_RING_PEAK_OPACITY = 0.75;

/**
 * One sweep per ring cycle, so the glyph and the ring at its corner are one
 * rhythm rather than two beating against each other on a 14px mark.
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
 * The sweep: brightest at the top of the cycle - the instant the ring launches
 * - dimmest at its midpoint, on a cosine so neither end is a corner.
 */
function glyphShimmerOpacity(elapsedMs: number): number {
  const phase = (elapsedMs / GLYPH_SHIMMER_CYCLE_MS) % 1;
  const dip = (1 - Math.cos(phase * 2 * Math.PI)) / 2;
  return 1 - (1 - GLYPH_SHIMMER_TROUGH_OPACITY) * dip;
}

/**
 * The lit glyph itself, shimmering on the shared status clock.
 *
 * The animated element is the lucide `<svg>`, not a wrapper around it: the
 * wrapper also holds the corner dot, and dimming that with the glyph would take
 * the ring's anchor down with it. `useStatusAnimation` takes an SVG ref for
 * exactly this.
 *
 * Reduced motion needs no rule here. The hook never subscribes under the
 * preference and clears the inline `opacity` the moment it turns on, so the
 * glyph holds at the full `text-primary` its class gives it - tone and dot
 * intact, sweep gone - which is the fallback the ring makes for itself too.
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
 * a chip is `[icon] N` at every width. So the glyph says it three ways at once
 * - `text-primary` displacing the chip's muted inherit, a shimmer sweeping that
 * tone, and a filled dot at its top-right corner throwing the app's `PingRing`.
 * The count beside it turns `primary` too, in `ChatDockCompactChip`, since it
 * is text.
 *
 * Two motions, one rhythm: the shimmer and the ring share a cycle and a clock
 * tick, so they peak together and read as one pulse. What was rejected before
 * was an icon blinking on its OWN beat under an expanding ring - two rhythms
 * fighting on a glyph the size of a word - not motion on the glyph as such,
 * and one ring in the corner turned out to be too quiet on its own.
 *
 * Both are clock-driven rather than CSS `animation`s - the always-on indicator
 * rule `status-animation-clock.ts` and `index.css` both record. Neither
 * subscribes under reduced motion, where the ring collapses to a static span
 * exactly the size of the dot it sits behind and the glyph holds its full tone.
 * The dot and the tones are unconditional, so the reduced-motion chip still
 * says "running" in two channels with no media query of its own.
 *
 * `data-chip-activity` on the wrapper, `data-chip-glyph-shimmer` on the glyph
 * and `data-chip-activity-dot` on the corner mark are the hooks for the suites
 * that pin all of this; a resting chip renders the bare icon with none of them.
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
      <ShimmeringGlyph icon={Icon} />
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
