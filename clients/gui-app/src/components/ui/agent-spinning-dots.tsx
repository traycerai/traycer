import { useCallback, useLayoutEffect, useRef } from "react";
import { usePaneVisible } from "@/components/epic-tabs/pane-visibility-context";
import {
  STATUS_ANIMATION_PULSE_CADENCE_MS,
  STATUS_ANIMATION_SMOOTH_CADENCE_MS,
  subscribeStatusAnimation,
  useStatusAnimation,
} from "@/lib/animation/status-animation-clock";
import { cn } from "@/lib/utils";
import type { AgentSpinnerVariant } from "@/components/ui/agent-spinner-variant";

interface AgentSpinnerPreset {
  readonly frames: readonly string[];
  readonly intervalMs: number;
  readonly widthCh: number;
}

type AgentSpinnerPresets = {
  readonly [
    Variant in Exclude<AgentSpinnerVariant, "typing">
  ]: AgentSpinnerPreset;
};

const AGENT_SPINNER_PRESETS: AgentSpinnerPresets = {
  dots: {
    frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
    intervalMs: 80,
    widthCh: 1,
  },
  dots2: {
    frames: ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"],
    intervalMs: 80,
    widthCh: 1,
  },
  dots3: {
    frames: ["⠋", "⠙", "⠚", "⠞", "⠖", "⠦", "⠴", "⠲", "⠳", "⠓"],
    intervalMs: 80,
    widthCh: 1,
  },
  dots4: {
    frames: [
      "⠄",
      "⠆",
      "⠇",
      "⠋",
      "⠙",
      "⠸",
      "⠰",
      "⠠",
      "⠰",
      "⠸",
      "⠙",
      "⠋",
      "⠇",
      "⠆",
    ],
    intervalMs: 80,
    widthCh: 1,
  },
  dots5: {
    frames: [
      "⠋",
      "⠙",
      "⠚",
      "⠒",
      "⠂",
      "⠂",
      "⠒",
      "⠲",
      "⠴",
      "⠦",
      "⠖",
      "⠒",
      "⠐",
      "⠐",
      "⠒",
      "⠓",
      "⠋",
    ],
    intervalMs: 80,
    widthCh: 1,
  },
  dots6: {
    frames: [
      "⠁",
      "⠉",
      "⠙",
      "⠚",
      "⠒",
      "⠂",
      "⠂",
      "⠒",
      "⠲",
      "⠴",
      "⠤",
      "⠄",
      "⠄",
      "⠤",
      "⠴",
      "⠲",
      "⠒",
      "⠂",
      "⠂",
      "⠒",
      "⠚",
      "⠙",
      "⠉",
      "⠁",
    ],
    intervalMs: 80,
    widthCh: 1,
  },
  dots7: {
    frames: [
      "⠈",
      "⠉",
      "⠋",
      "⠓",
      "⠒",
      "⠐",
      "⠐",
      "⠒",
      "⠖",
      "⠦",
      "⠤",
      "⠠",
      "⠠",
      "⠤",
      "⠦",
      "⠖",
      "⠒",
      "⠐",
      "⠐",
      "⠒",
      "⠓",
      "⠋",
      "⠉",
      "⠈",
    ],
    intervalMs: 80,
    widthCh: 1,
  },
  dots8: {
    frames: [
      "⠁",
      "⠁",
      "⠉",
      "⠙",
      "⠚",
      "⠒",
      "⠂",
      "⠂",
      "⠒",
      "⠲",
      "⠴",
      "⠤",
      "⠄",
      "⠄",
      "⠤",
      "⠠",
      "⠠",
      "⠤",
      "⠦",
      "⠖",
      "⠒",
      "⠐",
      "⠐",
      "⠒",
      "⠓",
      "⠋",
      "⠉",
      "⠈",
      "⠈",
    ],
    intervalMs: 80,
    widthCh: 1,
  },
  dots9: {
    frames: ["⢹", "⢺", "⢼", "⣸", "⣇", "⡧", "⡗", "⡏"],
    intervalMs: 80,
    widthCh: 1,
  },
  dots10: {
    frames: ["⢄", "⢂", "⢁", "⡁", "⡈", "⡐", "⡠"],
    intervalMs: 80,
    widthCh: 1,
  },
  dots11: {
    frames: ["⠁", "⠂", "⠄", "⡀", "⢀", "⠠", "⠐", "⠈"],
    intervalMs: 100,
    widthCh: 1,
  },
  dots12: {
    frames: [
      "⢀⠀",
      "⡀⠀",
      "⠄⠀",
      "⢂⠀",
      "⡂⠀",
      "⠅⠀",
      "⢃⠀",
      "⡃⠀",
      "⠍⠀",
      "⢋⠀",
      "⡋⠀",
      "⠍⠁",
      "⢋⠁",
      "⡋⠁",
      "⠍⠉",
      "⠋⠉",
      "⠋⠉",
      "⠉⠙",
      "⠉⠙",
      "⠉⠩",
      "⠈⢙",
      "⠈⡙",
      "⢈⠩",
      "⡀⢙",
      "⠄⡙",
      "⢂⠩",
      "⡂⢘",
      "⠅⡘",
      "⢃⠨",
      "⡃⢐",
      "⠍⡐",
      "⢋⠠",
      "⡋⢀",
      "⠍⡁",
      "⢋⠁",
      "⡋⠁",
      "⠍⠉",
      "⠋⠉",
      "⠋⠉",
      "⠉⠙",
      "⠉⠙",
      "⠉⠩",
      "⠈⢙",
      "⠈⡙",
      "⠈⠩",
      "⠀⢙",
      "⠀⡙",
      "⠀⠩",
      "⠀⢘",
      "⠀⡘",
      "⠀⠨",
      "⠀⢐",
      "⠀⡐",
      "⠀⠠",
      "⠀⢀",
      "⠀⡀",
    ],
    intervalMs: 80,
    widthCh: 2,
  },
  dots13: {
    frames: ["⣼", "⣹", "⢻", "⠿", "⡟", "⣏", "⣧", "⣶"],
    intervalMs: 80,
    widthCh: 1,
  },
  dots14: {
    frames: [
      "⠉⠉",
      "⠈⠙",
      "⠀⠹",
      "⠀⢸",
      "⠀⣰",
      "⢀⣠",
      "⣀⣀",
      "⣄⡀",
      "⣆⠀",
      "⡇⠀",
      "⠏⠀",
      "⠋⠁",
    ],
    intervalMs: 80,
    widthCh: 2,
  },
  sand: {
    frames: [
      "⠁",
      "⠂",
      "⠄",
      "⡀",
      "⡈",
      "⡐",
      "⡠",
      "⣀",
      "⣁",
      "⣂",
      "⣄",
      "⣌",
      "⣔",
      "⣤",
      "⣥",
      "⣦",
      "⣮",
      "⣶",
      "⣷",
      "⣿",
      "⡿",
      "⠿",
      "⢟",
      "⠟",
      "⡛",
      "⠛",
      "⠫",
      "⢋",
      "⠋",
      "⠍",
      "⡉",
      "⠉",
      "⠑",
      "⠡",
      "⢁",
    ],
    intervalMs: 80,
    widthCh: 1,
  },
  dots_circle: {
    frames: ["⢎ ", "⠎⠁", "⠊⠑", "⠈⠱", " ⡱", "⢀⡰", "⢄⡠", "⢆⡀"],
    intervalMs: 80,
    widthCh: 2,
  },
  wave: {
    frames: ["⠁⠂⠄⡀", "⠂⠄⡀⢀", "⠄⡀⢀⠠", "⡀⢀⠠⠐", "⢀⠠⠐⠈", "⠠⠐⠈⠁", "⠐⠈⠁⠂", "⠈⠁⠂⠄"],
    intervalMs: 100,
    widthCh: 4,
  },
  scan: {
    frames: [
      "⠀⠀⠀⠀",
      "⡇⠀⠀⠀",
      "⣿⠀⠀⠀",
      "⢸⡇⠀⠀",
      "⠀⣿⠀⠀",
      "⠀⢸⡇⠀",
      "⠀⠀⣿⠀",
      "⠀⠀⢸⡇",
      "⠀⠀⠀⣿",
      "⠀⠀⠀⢸",
    ],
    intervalMs: 70,
    widthCh: 4,
  },
  rain: {
    frames: [
      "⢁⠂⠔⠈",
      "⠂⠌⡠⠐",
      "⠄⡐⢀⠡",
      "⡈⠠⠀⢂",
      "⠐⢀⠁⠄",
      "⠠⠁⠊⡀",
      "⢁⠂⠔⠈",
      "⠂⠌⡠⠐",
      "⠄⡐⢀⠡",
      "⡈⠠⠀⢂",
      "⠐⢀⠁⠄",
      "⠠⠁⠊⡀",
    ],
    intervalMs: 100,
    widthCh: 4,
  },
  pulse: {
    frames: ["⠀⠶⠀", "⠰⣿⠆", "⢾⣉⡷", "⣏⠀⣹", "⡁⠀⢈"],
    intervalMs: 180,
    widthCh: 3,
  },
  snake: {
    frames: [
      "⣁⡀",
      "⣉⠀",
      "⡉⠁",
      "⠉⠉",
      "⠈⠙",
      "⠀⠛",
      "⠐⠚",
      "⠒⠒",
      "⠖⠂",
      "⠶⠀",
      "⠦⠄",
      "⠤⠤",
      "⠠⢤",
      "⠀⣤",
      "⢀⣠",
      "⣀⣀",
    ],
    intervalMs: 80,
    widthCh: 2,
  },
  sparkle: {
    frames: ["⡡⠊⢔⠡", "⠊⡰⡡⡘", "⢔⢅⠈⢢", "⡁⢂⠆⡍", "⢔⠨⢑⢐", "⠨⡑⡠⠊"],
    intervalMs: 150,
    widthCh: 4,
  },
  cascade: {
    frames: [
      "⠀⠀⠀⠀",
      "⠀⠀⠀⠀",
      "⠁⠀⠀⠀",
      "⠋⠀⠀⠀",
      "⠞⠁⠀⠀",
      "⡴⠋⠀⠀",
      "⣠⠞⠁⠀",
      "⢀⡴⠋⠀",
      "⠀⣠⠞⠁",
      "⠀⢀⡴⠋",
      "⠀⠀⣠⠞",
      "⠀⠀⢀⡴",
      "⠀⠀⠀⣠",
      "⠀⠀⠀⢀",
    ],
    intervalMs: 60,
    widthCh: 4,
  },
  columns: {
    frames: [
      "⡀⠀⠀",
      "⡄⠀⠀",
      "⡆⠀⠀",
      "⡇⠀⠀",
      "⣇⠀⠀",
      "⣧⠀⠀",
      "⣷⠀⠀",
      "⣿⠀⠀",
      "⣿⡀⠀",
      "⣿⡄⠀",
      "⣿⡆⠀",
      "⣿⡇⠀",
      "⣿⣇⠀",
      "⣿⣧⠀",
      "⣿⣷⠀",
      "⣿⣿⠀",
      "⣿⣿⡀",
      "⣿⣿⡄",
      "⣿⣿⡆",
      "⣿⣿⡇",
      "⣿⣿⣇",
      "⣿⣿⣧",
      "⣿⣿⣷",
      "⣿⣿⣿",
      "⣿⣿⣿",
      "⠀⠀⠀",
    ],
    intervalMs: 60,
    widthCh: 3,
  },
  orbit: {
    frames: ["⠃", "⠉", "⠘", "⠰", "⢠", "⣀", "⡄", "⠆"],
    intervalMs: 100,
    widthCh: 1,
  },
  breathe: {
    frames: [
      "⠀",
      "⠂",
      "⠌",
      "⡑",
      "⢕",
      "⢝",
      "⣫",
      "⣟",
      "⣿",
      "⣟",
      "⣫",
      "⢝",
      "⢕",
      "⡑",
      "⠌",
      "⠂",
      "⠀",
    ],
    intervalMs: 100,
    widthCh: 1,
  },
  waverows: {
    frames: [
      "⠖⠉⠉⠑",
      "⡠⠖⠉⠉",
      "⣠⡠⠖⠉",
      "⣄⣠⡠⠖",
      "⠢⣄⣠⡠",
      "⠙⠢⣄⣠",
      "⠉⠙⠢⣄",
      "⠊⠉⠙⠢",
      "⠜⠊⠉⠙",
      "⡤⠜⠊⠉",
      "⣀⡤⠜⠊",
      "⢤⣀⡤⠜",
      "⠣⢤⣀⡤",
      "⠑⠣⢤⣀",
      "⠉⠑⠣⢤",
      "⠋⠉⠑⠣",
    ],
    intervalMs: 90,
    widthCh: 4,
  },
  checkerboard: {
    frames: ["⢕⢕⢕", "⡪⡪⡪", "⢊⠔⡡", "⡡⢊⠔"],
    intervalMs: 250,
    widthCh: 3,
  },
  helix: {
    frames: [
      "⢌⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
      "⢎⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
      "⢎⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
      "⢎⣉⢎⣉",
      "⣉⡱⣉⡱",
      "⣉⢎⣉⢎",
      "⡱⣉⡱⣉",
    ],
    intervalMs: 80,
    widthCh: 4,
  },
  fillsweep: {
    frames: ["⣀⣀", "⣤⣤", "⣶⣶", "⣿⣿", "⣿⣿", "⣿⣿", "⣶⣶", "⣤⣤", "⣀⣀", "⠀⠀", "⠀⠀"],
    intervalMs: 100,
    widthCh: 2,
  },
  diagswipe: {
    frames: [
      "⠁⠀",
      "⠋⠀",
      "⠟⠁",
      "⡿⠋",
      "⣿⠟",
      "⣿⡿",
      "⣿⣿",
      "⣿⣿",
      "⣾⣿",
      "⣴⣿",
      "⣠⣾",
      "⢀⣴",
      "⠀⣠",
      "⠀⢀",
      "⠀⠀",
      "⠀⠀",
    ],
    intervalMs: 60,
    widthCh: 2,
  },
  infinity: {
    frames: [
      "⢎⡱⣉⠆",
      "⢎⡱⣈⠆",
      "⢎⡱⣀⠆",
      "⢎⡱⣀⠄",
      "⢎⡱⣀ ",
      "⢎⡱⡀ ",
      "⢎⡱ ",
      "⢎⡱ ",
      "⢎⡡ ",
      "⢎⡠ ",
      "⢆⡠ ",
      "⢄⡠ ",
      "⢀⡠ ",
      " ⡠ ",
      " ⠠ ",
      " ⠰ ",
      " ⠐ ",
      " ⠐⠁ ",
      " ⠐⠉ ",
      " ⠐⠉⠂",
      " ⠐⠉⠆",
      " ⠐⢉⠆",
      " ⠐⣉⠆",
      " ⠰⣉⠆",
      " ⠰⣉⠆",
      " ⠱⣉⠆",
      "⠈⠱⣉⠆",
      "⠊⠱⣉⠆",
      "⠎⠱⣉⠆",
      "⢎⠱⣉⠆",
      "⢎⡱⣉⠆",
      "⢎⡱⣉⠆",
    ],
    intervalMs: 60,
    widthCh: 4,
  },
  // Not a spinner: a cursor-style blink for the "blocked, awaiting your approval" state. Motion absence (vs the
  // busy braille spin) + the terminal cursor idiom reads as "your move" rather than "working".
  waiting: {
    frames: ["⠶"],
    intervalMs: 530,
    widthCh: 1,
  },
  // Fixed six-dot braille cell: exactly the same 3 × 2 glyph geometry as the
  // animated spinner, but with no frame cycling. Used for notification state.
  static: {
    frames: ["⠿"],
    intervalMs: 0,
    widthCh: 1,
  },
};

export interface AgentSpinningDotsProps {
  readonly className: string | undefined;
  readonly testId: string | undefined;
  readonly variant: AgentSpinnerVariant | undefined;
}

const WORKING_DOTS_CYCLE_MS = 1400;
const WORKING_DOTS_STAGGER_MS = 200;
const WORKING_DOTS_ACTIVE_FRACTION = 0.8;
const WORKING_DOTS_REST_OPACITY = 0.3;

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) * (-2 * t + 2)) / 2;
}

function dotLift(elapsedMs: number, index: number): number {
  const shifted = elapsedMs - index * WORKING_DOTS_STAGGER_MS;
  const phase = (((shifted / WORKING_DOTS_CYCLE_MS) % 1) + 1) % 1;
  if (phase >= WORKING_DOTS_ACTIVE_FRACTION) return 0;
  const half = WORKING_DOTS_ACTIVE_FRACTION / 2;
  const linear = phase < half ? phase / half : 1 - (phase - half) / half;
  return easeInOut(linear);
}

/** Private to this module - `AgentSpinningDots` is the only spinner seam, so cadence, reduced-motion and
 * pane-visibility behaviour cannot diverge between spinner APIs. */
function WorkingDots(props: {
  readonly className: string | undefined;
  readonly testId: string | undefined;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const write = useCallback((element: HTMLSpanElement, elapsedMs: number) => {
    const dots = element.children;
    for (let index = 0; index < dots.length; index++) {
      const dot = dots[index];
      if (!(dot instanceof HTMLElement)) continue;
      const lift = dotLift(elapsedMs, index);
      dot.style.opacity = String(
        WORKING_DOTS_REST_OPACITY + (1 - WORKING_DOTS_REST_OPACITY) * lift,
      );
      dot.style.transform = `translateY(${(-lift).toFixed(3)}px)`;
    }
  }, []);
  const clear = useCallback((element: HTMLSpanElement) => {
    for (const dot of element.children) {
      if (!(dot instanceof HTMLElement)) continue;
      dot.style.opacity = "";
      dot.style.transform = "";
    }
  }, []);
  useStatusAnimation(ref, write, clear, STATUS_ANIMATION_PULSE_CADENCE_MS);
  return (
    <span
      ref={ref}
      className={cn("working-dots text-current", props.className)}
      aria-hidden="true"
      data-testid={props.testId}
    >
      <span />
      <span />
      <span />
    </span>
  );
}

export function AgentSpinningDots(props: AgentSpinningDotsProps) {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const variant = props.variant ?? "dots";
  const preset = variant === "typing" ? null : AGENT_SPINNER_PRESETS[variant];
  const presetFrames = preset?.frames ?? null;
  const presetIntervalMs = preset?.intervalMs ?? null;

  // The span renders NO JSX children, so a parent re-render never resets the glyph; the layout effect (runs
  // pre-paint, so the first frame shows immediately) is the sole owner of the text.
  const paneVisible = usePaneVisible();
  useLayoutEffect(() => {
    // The `typing` variant renders `WorkingDots` below, which has no frames.
    if (presetFrames === null || presetIntervalMs === null) return;
    const node = frameRef.current;
    if (node === null) return;
    const text = document.createTextNode(presetFrames[0] ?? "");
    node.replaceChildren(text);
    // A hidden keep-alive pane cannot paint: hold the first frame, no ticks.
    if (presetFrames.length === 1 || !paneVisible) return;
    let shownIndex = 0;
    return subscribeStatusAnimation((elapsedMs) => {
      const frameIndex =
        Math.floor(elapsedMs / presetIntervalMs) % presetFrames.length;
      if (frameIndex === shownIndex) return;
      shownIndex = frameIndex;
      text.data = presetFrames[frameIndex] ?? "";
    }, STATUS_ANIMATION_SMOOTH_CADENCE_MS);
  }, [presetFrames, presetIntervalMs, paneVisible]);

  if (preset === null) {
    return <WorkingDots className={props.className} testId={props.testId} />;
  }

  return (
    <span
      ref={frameRef}
      data-testid={props.testId}
      aria-hidden="true"
      className={cn(
        // `font-normal` is load-bearing on macOS: the mono stack has no braille coverage.
        "inline-flex h-3.5 min-w-3.5 shrink-0 items-center justify-center whitespace-pre font-mono text-code font-normal leading-none tabular-nums",
        props.className,
      )}
      style={{ width: `${preset.widthCh}ch` }}
    />
  );
}

export function MutedAgentSpinner() {
  return (
    <AgentSpinningDots
      className="text-muted-foreground"
      testId={undefined}
      variant={undefined}
    />
  );
}
