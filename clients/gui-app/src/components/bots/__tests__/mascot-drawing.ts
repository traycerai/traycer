import {
  DEFAULT_MASCOT_RAMP,
  MASCOT_AT_REST,
  botMascot,
  drawMascotMark,
  type MascotMarkSize,
} from "@/lib/bots/mascot-mark";

/** The `d` of each path of the mascot drawn inside `root`, in draw order. */
export function renderedMascotPaths(root: Element): string[] {
  return [...root.querySelectorAll('[data-slot="bot-mascot"] path')].map(
    (path) => path.getAttribute("d") ?? "",
  );
}

/** The paths a bot's mascot at rest draws at `size`, from the real drawing. */
export function mascotPathsAt(
  botId: string,
  main: boolean,
  size: MascotMarkSize,
): string[] {
  return drawMascotMark(
    botMascot(botId, null, main),
    size,
    MASCOT_AT_REST,
  ).layers.map((layer) => layer.path);
}

/** A mascot's drawing: each layer's path and its fill, in draw order. */
export interface MascotDrawing {
  readonly paths: string[];
  readonly fills: string[];
}

/** The path and fill of each layer of the mascot drawn inside `root`. */
export function renderedMascotDrawing(root: Element): MascotDrawing {
  const layers = [...root.querySelectorAll('[data-slot="bot-mascot"] path')];
  return {
    paths: layers.map((layer) => layer.getAttribute("d") ?? ""),
    fills: layers.map((layer) => layer.getAttribute("fill") ?? ""),
  };
}

/**
 * The default mascot at rest at `size`, built from its parts (a blob wearing
 * nothing, in the fixed ramp) and not from the constant the components draw.
 */
export function defaultMascotDrawing(size: MascotMarkSize): MascotDrawing {
  const { layers } = drawMascotMark(
    {
      shape: "blob",
      ramp: DEFAULT_MASCOT_RAMP,
      eyewear: "none",
      accessory: "none",
    },
    size,
    MASCOT_AT_REST,
  );
  return {
    paths: layers.map((layer) => layer.path),
    fills: layers.map((layer) => layer.fill),
  };
}

/** Whether `root` draws the lucide robot glyph the mascot replaces. */
export function drawsRobotGlyph(root: Element): boolean {
  return root.querySelector("svg.lucide-bot") !== null;
}
