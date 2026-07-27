/**
 * Pure parsers for the per-window state shapes in `window-types.ts`. They
 * live with the contracts (no electron imports) so the IPC boundary
 * (`electron-main/ipc/ipc-parsers.ts`) and the disk persistence layer
 * (`electron-main/windows/desktop-state-store.ts`) validate snapshots with
 * the same code instead of drifting copies.
 */
import type { JsonValue, PerWindowLandingDraft } from "./window-types";

const MAX_JSON_VALUE_DEPTH = 64;

/**
 * Separates the two reasons a value can fail to parse, because they call for
 * opposite handling inside an object.
 *
 * `undefined` means "not representable as JSON" (`undefined`, a function, a
 * non-finite number). `JSON.stringify` omits such a property, so dropping it
 * keeps a round-tripped snapshot equal to what the sender meant.
 *
 * `DEPTH_EXCEEDED` means the value was well-formed but too deep to walk. That
 * one must fail the WHOLE value: dropping the property instead would let a
 * silently truncated `tabStripLayout` be acknowledged and persisted as if it
 * were the layout the renderer sent. Callers store `null` on a parse failure,
 * which is recoverable; a partial layout is not.
 */
const DEPTH_EXCEEDED = Symbol("json-depth-exceeded");

type ParsedJsonValue = JsonValue | undefined | typeof DEPTH_EXCEEDED;

export function parseJsonValue(value: unknown): JsonValue | undefined {
  const parsed = parseJsonValueAtDepth(value, 0);
  return parsed === DEPTH_EXCEEDED ? undefined : parsed;
}

function parseJsonValueAtDepth(value: unknown, depth: number): ParsedJsonValue {
  if (depth > MAX_JSON_VALUE_DEPTH) return DEPTH_EXCEEDED;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (Array.isArray(value)) {
    const parsed = value.map((entry) =>
      parseJsonValueAtDepth(entry, depth + 1),
    );
    if (parsed.some((entry) => entry === DEPTH_EXCEEDED)) {
      return DEPTH_EXCEEDED;
    }
    // An array cannot drop a bad entry the way an object drops a key without
    // shifting every later index, so one unrepresentable entry fails it whole.
    if (parsed.some((entry) => entry === undefined)) {
      return undefined;
    }
    return parsed.filter(
      (entry): entry is JsonValue =>
        entry !== undefined && entry !== DEPTH_EXCEEDED,
    );
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const parsed = parseJsonValueAtDepth(entry, depth + 1);
      if (parsed === DEPTH_EXCEEDED) return DEPTH_EXCEEDED;
      if (parsed !== undefined) {
        out[key] = parsed;
      }
    }
    return out;
  }
  return undefined;
}

export function parseJsonRecord(
  value: unknown,
): Readonly<Record<string, JsonValue>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const parsed = parseJsonValue(entry);
    if (parsed !== undefined) {
      out[key] = parsed;
    }
  }
  return out;
}

export function parseLandingDraft(
  value: unknown,
): PerWindowLandingDraft | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.id !== "string") {
    return null;
  }
  // T6: a landing draft now carries rich `content` (the editor JSON). Require
  // a non-null object `content`; a legacy prompt-only entry has no `content`
  // and is dropped — intended (no back-compat; dev feature).
  const content = parseJsonValue(obj.content);
  if (
    content === undefined ||
    content === null ||
    typeof content !== "object" ||
    Array.isArray(content)
  ) {
    return null;
  }
  return {
    id: obj.id,
    content,
    selection: parseJsonValue(obj.selection) ?? null,
    lastTouchedAt:
      typeof obj.lastTouchedAt === "number" &&
      Number.isFinite(obj.lastTouchedAt)
        ? obj.lastTouchedAt
        : 0,
    settings: parseJsonValue(obj.settings) ?? null,
    composerMode:
      typeof obj.composerMode === "string" ? obj.composerMode : null,
    workspace: parseJsonValue(obj.workspace) ?? null,
  };
}

export function parseLandingDrafts(
  value: unknown,
): readonly PerWindowLandingDraft[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const parsed = parseLandingDraft(entry);
    return parsed === null ? [] : [parsed];
  });
}
