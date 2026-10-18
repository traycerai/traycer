/** Data-only answers from a canvas document; no DOM references cross the frame. */
export interface CanvasBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface CanvasElement {
  readonly marker: number | null;
  readonly tid: string | null;
  readonly tagName: string;
  readonly selector: string;
  readonly elementId: string | null;
  readonly classNames: readonly string[];
  readonly textPreview: string;
  readonly inlineStyle: string;
  readonly ariaRole: string | null;
  readonly accessibleName: string | null;
  readonly box: CanvasBox;
  readonly computedStyles: readonly {
    readonly property: string;
    readonly value: string;
  }[];
  readonly generated: boolean;
}
export interface CanvasTextSelection {
  readonly element: CanvasElement;
  readonly start: number;
  readonly end: number;
  readonly quote: string;
  readonly rects: readonly CanvasBox[];
}
export interface CanvasPageError {
  readonly message: string;
  readonly stack: string | null;
}
export type CanvasElementLocator =
  | { readonly marker: number }
  | { readonly tid: string };
export type CanvasMode = "edit" | "play";

/** The browser annotation's curated set plus border, padding and margin shorthand (cap 48). */
export const CANVAS_STYLE_PROPERTIES = [
  "display",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "width",
  "height",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "box-sizing",
  "color",
  "background-color",
  "background-image",
  "font-size",
  "font-family",
  "font-weight",
  "line-height",
  "text-align",
  "flex-direction",
  "justify-content",
  "align-items",
  "gap",
  "grid-template-columns",
  "grid-template-rows",
  "z-index",
  "opacity",
  "visibility",
  "overflow-x",
  "overflow-y",
  "border-top-width",
  "border-width",
  "border-color",
  "padding",
  "margin",
  "border-style",
  "border-radius",
  "box-shadow",
  "transform",
  "cursor",
] as const;

export function canvasRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function text(value: unknown, limit: number): value is string {
  return typeof value === "string" && value.length <= limit;
}
function nullableText(value: unknown, limit: number): value is string | null {
  return value === null || text(value, limit);
}
function offset(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function coordinate(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Math.abs(value) <= 10_000_000
  );
}
export function parseCanvasBox(value: unknown): CanvasBox | null {
  if (!canvasRecord(value)) return null;
  const { x, y, width, height } = value;
  return coordinate(x) &&
    coordinate(y) &&
    coordinate(width) &&
    coordinate(height) &&
    width >= 0 &&
    height >= 0
    ? { x, y, width, height }
    : null;
}
function classList(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 30 &&
    value.every((name: unknown) => text(name, 120))
  );
}
function parseStyles(value: unknown): CanvasElement["computedStyles"] | null {
  if (!Array.isArray(value) || value.length > 48) return null;
  const styles: { property: string; value: string }[] = [];
  for (const style of value) {
    if (
      !canvasRecord(style) ||
      !text(style.property, 64) ||
      !text(style.value, 300) ||
      !CANVAS_STYLE_PROPERTIES.some((property) => property === style.property)
    )
      return null;
    styles.push({ property: style.property, value: style.value });
  }
  return styles;
}
export function parseCanvasElement(value: unknown): CanvasElement | null {
  if (!canvasRecord(value)) return null;
  const {
    marker,
    tid,
    tagName,
    selector,
    elementId,
    classNames,
    textPreview,
    inlineStyle,
    ariaRole,
    accessibleName,
    computedStyles,
    generated,
  } = value;
  const box = parseCanvasBox(value.box);
  const styles = parseStyles(computedStyles);
  if (
    (marker !== null && !offset(marker)) ||
    !nullableText(tid, 300) ||
    !text(tagName, 40) ||
    !text(selector, 1000) ||
    !nullableText(elementId, 300) ||
    !classList(classNames) ||
    !text(inlineStyle, 16_000) ||
    !text(textPreview, 200) ||
    !nullableText(ariaRole, 64) ||
    !nullableText(accessibleName, 300) ||
    box === null ||
    generated !== (marker === null) ||
    styles === null
  )
    return null;
  return {
    marker,
    tid,
    tagName,
    selector,
    elementId,
    classNames,
    textPreview,
    inlineStyle,
    ariaRole,
    accessibleName,
    box,
    computedStyles: styles,
    generated,
  };
}
export function parseCanvasTextSelection(
  value: unknown,
): CanvasTextSelection | null {
  if (!canvasRecord(value)) return null;
  const element = parseCanvasElement(value.element);
  const { start, end, quote, rects } = value;
  if (
    element === null ||
    !offset(start) ||
    !offset(end) ||
    end < start ||
    !text(quote, 16_000) ||
    !Array.isArray(rects) ||
    rects.length > 256
  )
    return null;
  const boxes: CanvasBox[] = [];
  for (const rect of rects) {
    const box = parseCanvasBox(rect);
    if (box === null) return null;
    boxes.push(box);
  }
  return { element, start, end, quote, rects: boxes };
}
export function parseCanvasPageError(value: unknown): CanvasPageError | null {
  if (
    !canvasRecord(value) ||
    !text(value.message, 2000) ||
    !nullableText(value.stack, 8000)
  )
    return null;
  return { message: value.message, stack: value.stack };
}
export function parseCanvasRelativeLink(value: unknown): string | null {
  return canvasRecord(value) && text(value.href, 8192) ? value.href : null;
}
