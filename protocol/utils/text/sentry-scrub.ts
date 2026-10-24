/**
 * The deep walker every Sentry scrubber in both repos runs over an
 * attacker-influenced or user-private payload (`extra`, `logentry.params`,
 * breadcrumb `data`, request `data`), and the stack-path walk.
 *
 * Detection is `./redaction`; the Sentry *policy* - which event fields get
 * walked, whether a breadcrumb is scrubbed at record time - stays with each
 * consumer. What is shared is the structural walk and its bounds, so a bound
 * one side tightens cannot silently be looser on the other.
 *
 * The per-string treatment is the caller's: the services cap length on top of
 * redacting (`extra.args` is whatever someone passed `logger.error`), the
 * desktop only redacts. That is the `scrubText` parameter.
 */

import { SENSITIVE_KEY_PATTERN } from "./redaction";

/**
 * Fails closed at the depth bound: past it the container is replaced outright
 * rather than passed through, because returning it would ship every
 * unscrubbed string below it. The array/key bounds are what stop one
 * caller-supplied payload of a whole dataset from riding out.
 */
export const MAX_SCRUB_DEPTH = 6;
export const MAX_SCRUB_ARRAY_ITEMS = 100;
export const MAX_SCRUB_OBJECT_KEYS = 100;

/**
 * What a container that hit the array/object bound carries in place of the
 * entries it dropped, so a reader can tell a bounded payload from a complete
 * one instead of reading a truncated list as the whole story.
 */
export const TRUNCATED_SENTINEL = "<truncated>";

export function isPlainRecord(
  value: unknown,
): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The slice of an exception entry whose stack frames carry paths. */
export interface SentryStacktraceHolder {
  stacktrace?:
    | {
        frames?:
          | {
              filename?: string | undefined;
              abs_path?: string | undefined;
              module?: string | undefined;
            }[]
          | undefined;
      }
    | undefined;
}

/**
 * An event's debug images. `type` and `debug_id` are read by Sentry's
 * symbolication and pass through unchanged; the two file fields are paths.
 */
export interface SentryDebugMeta {
  images?:
    | {
        type?: string | undefined;
        debug_id?: string | undefined;
        code_file?: string | undefined;
        /** `null` on a wasm image with no separate debug file. */
        debug_file?: string | null | undefined;
      }[]
    | undefined;
}

/** The slice of an event whose stack-derived fields carry paths. */
export interface SentryStackPaths {
  exception?: { values?: SentryStacktraceHolder[] | undefined } | undefined;
  debug_meta?: SentryDebugMeta | undefined;
}

/**
 * Rewrites, in place (the SDK takes back the event it handed to
 * `beforeSend`), every path the SDK builds from the stack: each frame's
 * `filename`, `abs_path` and `module`, and each debug image's `code_file`
 * and `debug_file`. No string walk reaches them, and an installed app's
 * frames name its absolute install folder, home folder included. `module` is
 * derived from the path, and keeps the whole path when the SDK cannot place
 * the file under its base folder.
 *
 * Frames and images go through the one `scrubPath`: the SDK copies a debug-id
 * frame's original path into its sourcemap image's `code_file` before
 * `beforeSend` runs, and the image is matched to its frames by that path, so
 * the two have to stay equal.
 */
export function scrubStackPathsInPlace(
  event: SentryStackPaths,
  scrubPath: (value: string) => string,
): void {
  for (const exception of event.exception?.values ?? []) {
    for (const frame of exception.stacktrace?.frames ?? []) {
      if (frame.filename !== undefined) {
        frame.filename = scrubPath(frame.filename);
      }
      if (frame.abs_path !== undefined) {
        frame.abs_path = scrubPath(frame.abs_path);
      }
      if (frame.module !== undefined) {
        frame.module = scrubPath(frame.module);
      }
    }
  }
  for (const image of event.debug_meta?.images ?? []) {
    if (image.code_file !== undefined) {
      image.code_file = scrubPath(image.code_file);
    }
    if (typeof image.debug_file === "string") {
      image.debug_file = scrubPath(image.debug_file);
    }
  }
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
  // One fallback for all of them - hand the SDK's own normalizer a bounded,
  // scrubbed string instead of the live value.
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
