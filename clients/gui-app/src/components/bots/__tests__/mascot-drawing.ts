import {
  MASCOT_AT_REST,
  botMascot,
  drawMascotMark,
  type MascotMarkSize,
} from "@/lib/bots/mascot-mark";

/** The id of the generic bot a surface draws when no bot is named. */
export const PLAIN_BOT_ID = "bot";

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

/** Whether `root` draws the lucide robot glyph the mascot replaces. */
export function drawsRobotGlyph(root: Element): boolean {
  return root.querySelector("svg.lucide-bot") !== null;
}
