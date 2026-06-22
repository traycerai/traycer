/**
 * Pure parsers for the per-window state shapes in `window-types.ts`. They
 * live with the contracts (no electron imports) so the IPC boundary
 * (`electron-main/ipc/ipc-parsers.ts`) and the disk persistence layer
 * (`electron-main/windows/desktop-state-store.ts`) validate snapshots with
 * the same code instead of drifting copies.
 */
import type { JsonValue, PerWindowLandingDraft } from "./window-types";

export function parseJsonValue(value: unknown): JsonValue | undefined {
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
    const parsed = value.map(parseJsonValue);
    if (parsed.some((entry) => entry === undefined)) {
      return undefined;
    }
    return parsed.filter((entry) => entry !== undefined);
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const parsed = parseJsonValue(entry);
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
