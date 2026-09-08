import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Environment } from "./runner/environment";
import { CliError } from "./runner/errors";
import { cliLogPath } from "./store/paths";
import { logLevelAllows } from "@traycer/protocol/config/log-level";
import { readLogLevelsSync } from "@traycer/protocol/config/store";

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogValue =
  | string
  | number
  | boolean
  | null
  | readonly LogValue[]
  | { readonly [key: string]: LogValue };

export type LogFields = { readonly [key: string]: LogValue };

export interface ILogger {
  debug(message: string, fields: LogFields): void;
  info(message: string, fields: LogFields): void;
  warn(message: string, fields: LogFields): void;
  error(message: string, fields: LogFields, error: Error | null): void;
}

const MAX_LOG_STRING_LENGTH = 1_000;
// Stacks get their own, much larger ceiling. A stack is the one log value
// whose usefulness is proportional to its length - the 1,000-char field cap
// lands inside the first two or three frames, which is exactly the part a
// reader could have guessed - while still needing SOME bound, because an error
// thrown out of deep async recursion can carry a stack in the megabytes and
// the log file is appended to on every run.
const MAX_LOG_STACK_LENGTH = 8 * 1_024;
// The stderr line is read in a terminal and pasted into support threads, so it
// gets one short frame, not a stack.
const MAX_ERROR_ORIGIN_LENGTH = 240;
const MAX_LOG_DEPTH = 4;
const SENSITIVE_FIELD_PATTERN =
  /token|secret|password|authorization|bearer|credential|refresh|cookie|verifier|api[_-]?key/i;
const SENSITIVE_TEXT_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly replacement: string;
}> = [
  {
    // `Basic` beside `Bearer`: a base64 `user:password` is a credential as
    // much as a token is, and the second pattern below stops at the scheme
    // word, leaving the credential after it in place. Newly reachable once
    // error messages and stacks are written rather than counted.
    pattern: /(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*/gi,
    replacement: "$1 [redacted]",
  },
  {
    pattern:
      /((?:access[_-]?token|accessToken|refresh[_-]?token|refreshToken|token|authorization|password|secret|cookie|code[_-]?verifier|codeVerifier|api[_-]?key|apiKey)\s*[:=]\s*)("[^"]*"|'[^']*'|[^&\s,}]+)/gi,
    replacement: "$1[redacted]",
  },
];

export const noopLogger: ILogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createCliLogger(environment: Environment): ILogger {
  const path = cliLogPath(environment);
  // Resolve the client threshold once at construction — config.json is shared
  // and rarely changes mid-process, and a fresh CLI invocation picks up the
  // latest level. Defaults to `info`, so debug output is dropped unless raised.
  const threshold = readLogLevelsSync().cliLogLevel;
  const write = (
    level: LogLevel,
    message: string,
    fields: LogFields,
    error: Error | null,
  ): void => {
    if (!logLevelAllows(threshold, level)) return;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(
        path,
        `${JSON.stringify({
          timestamp: new Date().toISOString(),
          level,
          message: sanitizeText(message),
          fields: sanitizeLogValue(fields, null),
          error: error === null ? null : serializeError(error),
        })}\n`,
        { mode: 0o600 },
      );
      chmodSync(path, 0o600);
    } catch {
      // Logging must never change CLI behavior.
    }
  };

  return {
    debug: (message, fields) => write("debug", message, fields, null),
    info: (message, fields) => write("info", message, fields, null),
    warn: (message, fields) => write("warn", message, fields, null),
    error: (message, fields, error) => write("error", message, fields, error),
  };
}

export function errorFromUnknown(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

/**
 * Render a thrown error into the log record.
 *
 * The message and the stack are the point. This used to record only whether
 * they EXISTED (`hasMessage` / `hasStack`), on the reasoning that error text is
 * the likeliest place for a credential to hide - but the module already has a
 * redactor for exactly that, applied to every other string it writes, so the
 * text was being thrown away rather than protected. What that cost is not
 * hypothetical: an `AssertionError` raised from inside Node/undici during a
 * host archive download took down a Mac CLI and left `{"name":"AssertionError",
 * "hasMessage":true,"hasStack":true}` as the entire trace. There was nothing to
 * diagnose from - not the assertion, not the frame, not the module it came out
 * of.
 *
 * `hasMessage` / `hasStack` stay: they are cheap, older log files carry them,
 * and they remain the honest answer for an error whose message redacts away to
 * nothing.
 */
function serializeError(error: Error): {
  readonly name: string;
  readonly code: string | null;
  readonly hasMessage: boolean;
  readonly hasStack: boolean;
  readonly message: string;
  readonly stack: string | null;
} {
  const stack = typeof error.stack === "string" ? error.stack : null;
  return {
    name: error.name,
    code: error instanceof CliError ? error.code : null,
    hasMessage: error.message.length > 0,
    hasStack: stack !== null && stack.length > 0,
    message: sanitizeText(error.message),
    stack:
      stack === null ? null : redactAndTruncate(stack, MAX_LOG_STACK_LENGTH),
  };
}

/**
 * A single sanitized line naming an error and the frame it was thrown from.
 *
 * For the human stderr line on the process-fatal path, which carried nothing
 * but a fixed `[code=...]` token: the user's terminal - and every support
 * report pasted out of it - said only that "something unexpected" happened.
 * One frame is enough to tell a disk error from an assertion inside the HTTP
 * client, and it is the half of the trace that survives being read aloud.
 *
 * The full message and stack go to the log file; this stays short, and it stays
 * ONE line. Newlines are collapsed rather than trimmed to a prefix - a stack
 * pasted verbatim into stderr would otherwise let a message's own `\n` forge a
 * second `error:` line that the CLI never wrote.
 */
export function describeErrorOrigin(error: Error): string {
  const frame = firstStackFrame(error.stack);
  const origin = frame === null ? error.name : `${error.name} at ${frame}`;
  // Every control character, not only CR/LF: the line goes to a terminal, and
  // an escape sequence in an attacker-set `error.name` would otherwise be
  // interpreted by it rather than displayed.
  return redactAndTruncate(
    origin.replace(/\p{Cc}+/gu, " "),
    MAX_ERROR_ORIGIN_LENGTH,
  );
}

/**
 * The first stack frame, without its indent or its `at ` prefix.
 *
 * Deliberately not `stack.split("\n")[0]`: V8 opens a stack with
 * `Name: message`, so the first LINE is a restatement of what the caller
 * already has, and the first FRAME is the part it does not. The prefix comes
 * off because the caller supplies its own `at`.
 */
function firstStackFrame(stack: string | undefined): string | null {
  if (typeof stack !== "string") return null;
  for (const line of stack.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("at ")) return trimmed.slice("at ".length);
  }
  return null;
}

function sanitizeLogValue(value: LogValue, key: string | null): LogValue {
  return sanitizeLogValueInner(value, key, 0, new WeakSet<object>());
}

function sanitizeLogValueInner(
  value: LogValue,
  key: string | null,
  depth: number,
  seen: WeakSet<object>,
): LogValue {
  if (
    key !== null &&
    SENSITIVE_FIELD_PATTERN.test(key) &&
    (typeof value === "string" ||
      Array.isArray(value) ||
      typeof value === "object")
  ) {
    return "[redacted]";
  }
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  if (depth >= MAX_LOG_DEPTH) {
    return "[max-depth]";
  }
  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) =>
      sanitizeLogValueInner(entry, null, depth + 1, seen),
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      sanitizeLogValueInner(entryValue, entryKey, depth + 1, seen),
    ]),
  );
}

/**
 * Redact first, then bound the length.
 *
 * The order is not interchangeable. Truncating first can cut a `Bearer <jwt>`
 * in half, and the half that survives no longer matches the pattern that would
 * have removed it - so the redactor runs over the WHOLE value and the cap is
 * applied to what comes back. Every caller differs only in the ceiling it
 * wants: an ordinary field is capped short, a stack long, the stderr origin
 * shorter still.
 */
function redactAndTruncate(value: string, maxLength: number): string {
  const redacted = SENSITIVE_TEXT_PATTERNS.reduce(
    (current, entry) => current.replace(entry.pattern, entry.replacement),
    value,
  );
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}...<truncated>`;
}

function sanitizeText(value: string): string {
  return redactAndTruncate(value, MAX_LOG_STRING_LENGTH);
}
