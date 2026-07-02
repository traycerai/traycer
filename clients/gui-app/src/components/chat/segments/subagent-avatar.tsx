import { useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";

// A deterministic, identicon-style pixel avatar keyed on the subagent's stable
// block id. The id is the canonical per-subagent key (it also drives
// subagent open state), so the same subagent always renders the same icon -
// available from the first frame, before Codex's async nickname/role resolve.
// While the subagent works its pixels drift upward (rising one row at a time
// and wrapping back to the bottom, like Codex); idle freezes them into the
// stable symmetric identicon.

const GRID = 5;
// Generate the left half (incl. center column) and mirror it for a face-like,
// vertically-symmetric layout - the classic identicon trick.
const GENERATED_COLS = Math.ceil(GRID / 2);
const LIGHTNESS = 58;
// One rise step every STEP_MS so motion reads as discrete pixel hops rather
// than a smooth slide - keeps the blocky, pixel-art feel.
const STEP_MS = 120;
// Per lit pixel, chance to rise one row on each step. Below 1 so pixels rise at
// staggered times, giving a textured upward flow instead of a rigid scroll.
const RISE_PROBABILITY = 0.55;

interface SubagentAvatarProps {
  readonly seed: string;
  readonly active: boolean;
  readonly size: number;
  readonly className: string | null;
}

interface AvatarModel {
  readonly cells: ReadonlyArray<boolean>;
  readonly hue: number;
}

function xfnv1a(input: string): number {
  let hash = 2166136261 >>> 0;
  for (const char of input) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildModel(seed: string): AvatarModel {
  const rng = mulberry32(xfnv1a(seed));
  const hue = Math.floor(rng() * 360);
  const cells = new Array<boolean>(GRID * GRID).fill(false);
  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GENERATED_COLS; col++) {
      const lit = rng() > 0.5;
      const mirror = GRID - 1 - col;
      cells[row * GRID + col] = lit;
      cells[row * GRID + mirror] = lit;
    }
  }
  return { cells, hue };
}

function get2dContext(
  canvas: HTMLCanvasElement,
): CanvasRenderingContext2D | null {
  // jsdom throws "Not implemented" rather than returning null, so this capability
  // probe is the one boundary where catching is the cleanest option.
  try {
    return canvas.getContext("2d");
  } catch {
    return null;
  }
}

export function SubagentAvatar(props: SubagentAvatarProps) {
  const { seed, active, size, className } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const model = useMemo(() => buildModel(seed), [seed]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = get2dContext(canvas);
    // No 2d context (e.g. jsdom); bail so tests render the element undrawn.
    if (ctx === null) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    ctx.scale(dpr, dpr);
    ctx.imageSmoothingEnabled = false;

    const { cells, hue } = model;
    const cell = size / GRID;
    const gap = cell * 0.08;
    const fill = `hsl(${hue} 68% ${LIGHTNESS}%)`;

    // Lit pixel positions as cell indices; occupancy mirrors them for O(1) hops.
    const positions = cells.flatMap((lit, index) => (lit ? [index] : []));
    const occupied = new Set(positions);

    const paint = () => {
      ctx.clearRect(0, 0, size, size);
      ctx.fillStyle = fill;
      for (const index of positions) {
        const row = Math.floor(index / GRID);
        const col = index % GRID;
        ctx.fillRect(
          col * cell + gap / 2,
          row * cell + gap / 2,
          cell - gap,
          cell - gap,
        );
      }
    };

    const rise = (): boolean => {
      let moved = false;
      for (let i = 0; i < positions.length; i++) {
        if (Math.random() > RISE_PROBABILITY) continue;
        const index = positions[i];
        const col = index % GRID;
        const row = Math.floor(index / GRID);
        // Rise one row, wrapping the top row back to the bottom so density holds.
        const nextRow = row === 0 ? GRID - 1 : row - 1;
        const target = nextRow * GRID + col;
        if (occupied.has(target)) continue;
        occupied.delete(index);
        occupied.add(target);
        positions[i] = target;
        moved = true;
      }
      return moved;
    };

    const prefersReduced = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    paint();
    if (!active || prefersReduced) return;

    // Motion is discrete (pixels snap to cells every STEP_MS), so only repaint
    // on a step that actually moved a pixel - not every animation frame. rAF
    // (vs setInterval) auto-pauses when the tab is hidden, saving battery.
    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const tick = (now: number) => {
      acc += now - last;
      last = now;
      let moved = false;
      while (acc >= STEP_MS) {
        if (rise()) moved = true;
        acc -= STEP_MS;
      }
      if (moved) paint();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [model, active, size]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className={cn("shrink-0 rounded-[2px]", className)}
      style={{ width: size, height: size }}
    />
  );
}
