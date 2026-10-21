import type { CanvasSelection } from "./canvas-selection-store";

export function canvasTextEditorStyle(selection: CanvasSelection) {
  const { box, computedStyles } = selection.element;
  const styles = new Map(
    computedStyles.map(({ property, value }) => [property, value]),
  );
  const background = styles.get("background-color");
  const opaque =
    background !== undefined &&
    background !== "transparent" &&
    !background.startsWith("rgba(") &&
    !background.includes("/");
  return {
    "--text-x": `${box.x}px`,
    "--text-y": `${box.y}px`,
    "--text-width": `${Math.max(12, box.width)}px`,
    "--text-height": `${Math.max(24, box.height)}px`,
    "--text-font": styles.get("font-family") ?? "inherit",
    "--text-size": styles.get("font-size") ?? "16px",
    "--text-weight": styles.get("font-weight") ?? "normal",
    "--text-leading": styles.get("line-height") ?? "normal",
    "--text-align": styles.get("text-align") ?? "left",
    "--text-color": opaque
      ? (styles.get("color") ?? "var(--foreground)")
      : "var(--foreground)",
    "--text-background": opaque ? background : "var(--background)",
    "--text-padding-top": styles.get("padding-top") ?? "0px",
    "--text-padding-right": styles.get("padding-right") ?? "0px",
    "--text-padding-bottom": styles.get("padding-bottom") ?? "0px",
    "--text-padding-left": styles.get("padding-left") ?? "0px",
  };
}
