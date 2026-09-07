/**
 * The deep walker every Sentry scrubber in both repos runs over an attacker-influenced or user-private payload (`extra`, `logentry.params`, breadcrumb `data`, request `data`).
 * What is shared is the structural walk and its bounds, so a bound one side tightens cannot silently be looser on the other.
 */

import { SENSITIVE_KEY_PATTERN } from "./redaction";

export const MAX_SCRUB_DEPTH = 6;
export const MAX_SCRUB_ARRAY_ITEMS = 100;
export const MAX_SCRUB_OBJECT_KEYS = 100;

export const TRUNCATED_SENTINEL = "<truncated>";

export function isPlainRecord(
  value: unknown,
): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Recursively scrubs an arbitrary value, applying `scrubText` to every string. */
export function deepScrubSentryValue(
  value: unknown,
  scrubText: (value: string) => string,
): unknown {
  return scrubValueAtDepth(value, 0, scrubText);
}

/**
 * The record-typed entry point, so the callers that must hand a
 * `{ [key: string]: unknown }` back to the SDK do not need a cast.
 */
export function deepScrubSentryRecord(
  record: { [key: string]: unknown },
  scrubText: (value: string) => string,
): { [key: string]: unknown } {
  return scrubRecordAtDepth(record, 0, scrubText);
}

function scrubValueAtDepth(
  value: unknown,
  depth: number,
  scrubText: (value: string) => string,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (depth >= MAX_SCRUB_DEPTH) return "<depth-limit>";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubText(value.message),
      stack: typeof value.stack === "string" ? scrubText(value.stack) : null,
    };
  }
  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_SCRUB_ARRAY_ITEMS)
      .map((entry) => scrubValueAtDepth(entry, depth + 1, scrubText));
    return value.length > MAX_SCRUB_ARRAY_ITEMS
      ? [...kept, TRUNCATED_SENTINEL]
      : kept;
  }
  if (isPlainRecord(value)) {
    return scrubRecordAtDepth(value, depth, scrubText);
  }
  // Everything the branches above did not claim: bigints, functions, symbols.
  return scrubText(String(value));
}

function scrubRecordAtDepth(
  record: { [key: string]: unknown },
  depth: number,
  scrubText: (value: string) => string,
): { [key: string]: unknown } {
  const scrubbed: { [key: string]: unknown } = {};
  const entries = Object.entries(record);
  for (const [key, entry] of entries.slice(0, MAX_SCRUB_OBJECT_KEYS)) {
    scrubbed[key] = SENSITIVE_KEY_PATTERN.test(key)
      ? "<redacted>"
      : scrubValueAtDepth(entry, depth + 1, scrubText);
  }
  if (entries.length > MAX_SCRUB_OBJECT_KEYS) {
    scrubbed[TRUNCATED_SENTINEL] = TRUNCATED_SENTINEL;
  }
  return scrubbed;
}
