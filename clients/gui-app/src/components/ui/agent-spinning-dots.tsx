import { useLayoutEffect, useRef } from "react";
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
  // Not a spinner: a cursor-style blink for the "blocked, awaiting your
  // approval" state. Motion absence (vs the busy braille spin) + the terminal
  // cursor idiom reads as "your move" rather than "working".
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

export function AgentSpinningDots(props: AgentSpinningDotsProps) {
  const frameRef = useRef<HTMLSpanElement | null>(null);
  const variant = props.variant ?? "dots";
  const preset = variant === "typing" ? null : AGENT_SPINNER_PRESETS[variant];
  const presetFrames = preset?.frames ?? null;
  const presetIntervalMs = preset?.intervalMs ?? null;

  // Advance the frames imperatively instead of via React state. The old
  // `useState(frameIndex)` re-rendered this component every `intervalMs` (up to
  // 12.5Hz per spinner); on a busy loading surface like the providers settings
  // panel - which mounts several spinners at once - that flickered the whole
  // subtree on every frame. Writing `textContent` straight to the node is a
  // pure DOM mutation: zero React re-render, zero reconciliation, byte-for-byte
  // the same glyphs/cadence/width as before. The span renders NO JSX children,
  // so a parent re-render never resets the glyph; the layout effect (runs
  // pre-paint, so the first frame shows immediately like the old version) is the
  // sole owner of `textContent`.
  useLayoutEffect(() => {
    if (presetFrames === null || presetIntervalMs === null) return;
    const node = frameRef.current;
    if (node === null) return;
    let frameIndex = 0;
    node.textContent = presetFrames[0];
    if (presetFrames.length === 1) return;
    const intervalId = window.setInterval(() => {
      frameIndex = (frameIndex + 1) % presetFrames.length;
      node.textContent = presetFrames[frameIndex];
    }, presetIntervalMs);

    return () => window.clearInterval(intervalId);
  }, [presetFrames, presetIntervalMs]);

  if (preset === null) {
    return (
      <span
        data-testid={props.testId}
        aria-hidden="true"
        className={cn("working-dots text-current", props.className)}
      >
        <span />
        <span />
        <span />
      </span>
    );
  }

  return (
    <span
      ref={frameRef}
      data-testid={props.testId}
      aria-hidden="true"
      className={cn(
        // `font-normal` is load-bearing on macOS: the mono stack has no braille
        // coverage, and an inherited 500 (active tab / Button `font-medium`)
        // makes Chromium's fallback pick the hollow-grid "Apple Braille
        // Outline" faces instead of the filled-dot regular face.
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
