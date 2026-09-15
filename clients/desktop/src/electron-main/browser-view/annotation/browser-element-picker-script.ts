import type {
  BrowserViewElementBoundingBox,
  BrowserViewElementCapture,
  BrowserViewElementStyle,
} from "@traycer-clients/shared/platform/browser-view";
import type { BrowserElementComponentHint } from "./browser-element-component-hint";
import {
  boundedString,
  boundedStringOrNull,
  clamp,
  finiteNumber,
  isRecord,
} from "../guards";

/**
 * Bounded per-element capture sanitizer shared by the annotation overlay.
 * Guest-supplied lengths and types are re-bounded in the main process.
 */

export const ELEMENT_PICKER_LIMITS = {
  textPreview: 200,
  attributeValue: 300,
  styleCount: 48,
  styleValue: 300,
  classCount: 30,
  className: 120,
  selector: 1000,
  frameLabel: 300,
  ariaRole: 64,
  accessibleName: 300,
  tagName: 40,
  componentName: 120,
  sourceFile: 400,
} as const;

export const ELEMENT_PICKER_STYLE_PROPS: readonly string[] = [
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
  "border-style",
  "border-radius",
  "box-shadow",
  "transform",
  "cursor",
];

/**
 * A sanitized element capture PLUS this desktop's component hint.
 *
 * The hint is deliberately not part of `BrowserViewElementCapture`, which is a
 * released wire and persistence contract: `chat.subscribe` has shipped at 1.7
 * and 1.8, and the compatibility guard classifies a new property on a
 * host->client slot at a released version as breaking, because a peer running
 * the shipped line never sends the key while a consumer that assumes it is
 * populated reads `undefined`. Adding it there would require a new protocol
 * major and downgrade bridges.
 *
 * So it rides beside the contract instead, on this process's own IPC type. Zod
 * strips unmodeled keys, so a capture that reaches a host frame arrives as the
 * exact released shape with the hint dropped - the wire is unchanged by
 * construction rather than by remembering to strip it. Surfacing the hint to an
 * agent is therefore a separate question from capturing it, and belongs either
 * in the message body (free-form content, no schema change) or in the next
 * protocol major.
 */
export type BrowserAnnotationElementCapture = BrowserViewElementCapture &
  BrowserElementComponentHint;

export function sanitizeElementCapture(
  value: unknown,
): BrowserAnnotationElementCapture | null {
  if (!isRecord(value)) return null;
  return {
    selector: boundedString(value.selector, ELEMENT_PICKER_LIMITS.selector, ""),
    tagName: boundedString(
      value.tagName,
      ELEMENT_PICKER_LIMITS.tagName,
      "",
    ).toLowerCase(),
    elementId: boundedStringOrNull(
      value.elementId,
      ELEMENT_PICKER_LIMITS.attributeValue,
    ),
    classNames: sanitizeStringList(
      value.classNames,
      ELEMENT_PICKER_LIMITS.classCount,
      ELEMENT_PICKER_LIMITS.className,
    ),
    textPreview: boundedStringOrNull(
      value.textPreview,
      ELEMENT_PICKER_LIMITS.textPreview,
    ),
    ariaRole: boundedStringOrNull(
      value.ariaRole,
      ELEMENT_PICKER_LIMITS.ariaRole,
    ),
    accessibleName: boundedStringOrNull(
      value.accessibleName,
      ELEMENT_PICKER_LIMITS.accessibleName,
    ),
    componentName: boundedStringOrNull(
      value.componentName,
      ELEMENT_PICKER_LIMITS.componentName,
    ),
    sourceFile: boundedStringOrNull(
      value.sourceFile,
      ELEMENT_PICKER_LIMITS.sourceFile,
    ),
    sourceLine: sanitizeSourceLine(value.sourceLine),
    boundingBox: sanitizeBoundingBox(value.boundingBox),
    computedStyles: sanitizeStyles(value.computedStyles),
  };
}

/**
 * A source line is a positive integer or nothing. It reaches a prompt, so a
 * float or a negative from a page-defined getter must not travel as one.
 */
function sanitizeSourceLine(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value) || value < 1) return null;
  return Math.floor(value);
}

const ELEMENT_PICKER_STYLE_PROP_SET = new Set<string>(
  ELEMENT_PICKER_STYLE_PROPS,
);

function sanitizeStyles(value: unknown): BrowserViewElementStyle[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, ELEMENT_PICKER_LIMITS.styleCount)
    .flatMap((entry): BrowserViewElementStyle[] => {
      if (!isRecord(entry)) return [];
      // Trust boundary: only the curated property names are allowed through,
      // regardless of what the (untrusted) page returned.
      if (
        typeof entry.property !== "string" ||
        !ELEMENT_PICKER_STYLE_PROP_SET.has(entry.property)
      ) {
        return [];
      }
      return [
        {
          property: entry.property,
          value: boundedString(
            entry.value,
            ELEMENT_PICKER_LIMITS.styleValue,
            "",
          ),
        },
      ];
    });
}

function sanitizeStringList(
  value: unknown,
  maxCount: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maxCount)
    .flatMap((entry): string[] =>
      typeof entry === "string" && entry.length > 0
        ? [entry.length > maxLength ? entry.slice(0, maxLength) : entry]
        : [],
    );
}

const ELEMENT_PICKER_BBOX_MAX = 1_000_000;

function sanitizeBoundingBox(value: unknown): BrowserViewElementBoundingBox {
  const record = isRecord(value) ? value : {};
  return {
    x: clampCoordinate(record.x),
    y: clampCoordinate(record.y),
    width: clampSize(record.width),
    height: clampSize(record.height),
    top: clampCoordinate(record.top),
    right: clampCoordinate(record.right),
    bottom: clampCoordinate(record.bottom),
    left: clampCoordinate(record.left),
  };
}

function clampCoordinate(value: unknown): number {
  return clamp(
    finiteNumber(value),
    -ELEMENT_PICKER_BBOX_MAX,
    ELEMENT_PICKER_BBOX_MAX,
  );
}

function clampSize(value: unknown): number {
  return clamp(finiteNumber(value), 0, ELEMENT_PICKER_BBOX_MAX);
}
