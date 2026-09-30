import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomically } from "../host/lifecycle-probe";
import { cliHomeDir } from "../store/paths";
import type { Environment } from "./environment";
import { isErrnoException } from "./errors";

// Per-machine repeat gate for the runner's Sentry reports.
//
// Every CLI invocation is a fresh process, so nothing in memory can tell a
// repeat from a first occurrence. A command that an agent or the update path
// re-runs on one broken machine therefore reported on every run: on 1.4.x four
// machines sent about 560 events a day between them, each one failure.
//
// The first failure of a kind is reported in full. Repeats inside the window
// are counted in a small file under the CLI home, and the count rides on the
// next report of that kind once the window has passed.
//
// Fail-open by construction: a ledger that cannot be read reports, exactly as
// the runner did before the gate existed. One that can be read but not written
// (a full disk, a home made read-only) turns the gate off on that machine: no
// window is ever recorded, so every run reports, again as before the gate, and
// the count on those reports is stale. Concurrent invocations race on the
// file; the race costs at most an extra report or a lost count, never a missed
// first report.

export const CLI_SENTRY_REPEAT_WINDOW_MS = 60 * 60 * 1000;
// Dropped on write whatever their count, so a failure that stopped leaves no
// state behind for long.
const LEDGER_RETENTION_MS = 24 * 60 * 60 * 1000;
// Bounds the file on a machine that fails in many different ways.
const LEDGER_MAX_ENTRIES = 100;
const LEDGER_FILE_NAME = "sentry-repeats.json";
const LEDGER_VERSION = 1;
const MAX_TEMPLATE_LENGTH = 240;
// Enough frames to reach past the shared constructors and mappers (`cliError`,
// the host-RPC mapper chain) to the code that failed.
const SITE_FRAMES = 8;

export interface RepeatLedgerEntry {
  readonly windowStartMs: number;
  readonly suppressed: number;
}

export type RepeatDecision =
  | { readonly kind: "report"; readonly repeatsSinceLastReport: number }
  | { readonly kind: "suppress"; readonly repeatsInWindow: number };

export interface RepeatGateIo {
  readonly now: () => number;
  // `null` when the ledger does not exist yet.
  readonly read: (path: string) => Promise<string | null>;
  readonly write: (path: string, value: object) => Promise<void>;
}

export const defaultRepeatGateIo: RepeatGateIo = {
  now: () => Date.now(),
  read: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") return null;
      throw error;
    }
  },
  write: writeJsonAtomically,
};

export function cliSentryRepeatLedgerPath(environment: Environment): string {
  return join(cliHomeDir(environment), LEDGER_FILE_NAME);
}

// What makes two failures "the same": the CLI code, the thrown value's name,
// where it was thrown, and the message with its per-event values replaced.
//
// The code alone is too coarse: every wrapped failure is UNEXPECTED, and one
// service code covers launchctl, systemd and schtasks. The raw message is too
// fine: it carries ids, paths and exit codes, so every event would be its own
// key and nothing would ever repeat. The template keeps the text a code path
// wrote and replaces each value, so it changes only when the failure does. The
// throw site keeps apart two different failures whose templates happen to
// match (`Cannot read properties of undefined (reading '<q>')` from two
// places), so one looping failure cannot hide another.
export function cliSentryRepeatKey(
  code: string,
  error: unknown,
  message: string,
): string {
  const name = error instanceof Error ? error.name : typeof error;
  return `${code}|${name}|${stackSite(error)}|${messageTemplate(message)}`;
}

// The first stack positions of a thrown Error, `line:col` without their paths.
// Stable for one build on one machine, which is all a per-machine gate needs; a
// new CLI build is a new key and one fresh report. Frames with no position
// (`native`, `<anonymous>`) are skipped. "-" when there is no stack to read.
export function stackSite(error: unknown): string {
  if (!(error instanceof Error) || typeof error.stack !== "string") return "-";
  const positions: string[] = [];
  for (const line of error.stack.split("\n")) {
    if (!/^\s+at\s/.test(line)) continue;
    const position = /:(\d+):(\d+)\)?\s*$/.exec(line);
    if (position === null) continue;
    positions.push(`${position[1]}:${position[2]}`);
    if (positions.length === SITE_FRAMES) break;
  }
  return positions.length === 0 ? "-" : positions.join(",");
}

// Order matters: quoted values first, so a quoted path or id is one
// placeholder; UUIDs before the hex run that would split them; e-mail
// addresses and paths before the digit pass that would leave their shape. A
// single quote opens a value only after a non-word character, so the
// apostrophes in "host's" and "Desktop's" are text, not a quoted span.
export function messageTemplate(message: string): string {
  return message
    .replace(/"[^"]*"/g, '"<q>"')
    .replace(/(^|\W)'[^']*'/g, "$1'<q>'")
    .replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      "<id>",
    )
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "<email>")
    .replace(/[A-Za-z]:\\[^\s'"]*/g, "<path>")
    .replace(/(?:\/[^\s/'":]+)+\/?/g, "<path>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .slice(0, MAX_TEMPLATE_LENGTH);
}

// The decision, and the ledger to write back. Pure, so the window arithmetic
// is testable without a clock or a file.
export function decideRepeat(
  ledger: ReadonlyMap<string, RepeatLedgerEntry>,
  key: string,
  nowMs: number,
): {
  readonly decision: RepeatDecision;
  readonly next: Map<string, RepeatLedgerEntry>;
} {
  const next = pruneLedger(ledger, nowMs, key);
  const entry = next.get(key);
  // A start in the future is a clock that went backwards: treat the window as
  // over rather than suppress until the clock catches up.
  if (
    entry !== undefined &&
    nowMs >= entry.windowStartMs &&
    nowMs - entry.windowStartMs < CLI_SENTRY_REPEAT_WINDOW_MS
  ) {
    const suppressed = entry.suppressed + 1;
    next.set(key, { windowStartMs: entry.windowStartMs, suppressed });
    return {
      decision: { kind: "suppress", repeatsInWindow: suppressed },
      next,
    };
  }
  next.set(key, { windowStartMs: nowMs, suppressed: 0 });
  return {
    decision: {
      kind: "report",
      repeatsSinceLastReport: entry === undefined ? 0 : entry.suppressed,
    },
    next,
  };
}

// Keeps the key being decided (its window must survive a busy ledger) and the
// most recent others, so the ledger written back holds at most
// LEDGER_MAX_ENTRIES entries.
function pruneLedger(
  ledger: ReadonlyMap<string, RepeatLedgerEntry>,
  nowMs: number,
  currentKey: string,
): Map<string, RepeatLedgerEntry> {
  const live = [...ledger].filter(
    ([, entry]) => Math.abs(nowMs - entry.windowStartMs) < LEDGER_RETENTION_MS,
  );
  const current = live.find(([key]) => key === currentKey);
  const others = live
    .filter(([key]) => key !== currentKey)
    .sort(([, a], [, b]) => b.windowStartMs - a.windowStartMs)
    .slice(0, LEDGER_MAX_ENTRIES - 1);
  return new Map(current === undefined ? others : [current, ...others]);
}

export function parseLedger(text: string): Map<string, RepeatLedgerEntry> {
  const ledger = new Map<string, RepeatLedgerEntry>();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return ledger;
  }
  if (!isRecord(value) || value.version !== LEDGER_VERSION) return ledger;
  const entries = value.entries;
  if (!isRecord(entries)) return ledger;
  for (const [key, raw] of Object.entries(entries)) {
    if (
      isRecord(raw) &&
      isCount(raw.windowStartMs) &&
      isCount(raw.suppressed)
    ) {
      ledger.set(key, {
        windowStartMs: raw.windowStartMs,
        suppressed: raw.suppressed,
      });
    }
  }
  return ledger;
}

// Reads the ledger, decides, and writes it back. Never throws.
export async function recordCliFailureForSentry(
  environment: Environment,
  key: string,
  io: RepeatGateIo,
): Promise<RepeatDecision> {
  const path = cliSentryRepeatLedgerPath(environment);
  let ledger: Map<string, RepeatLedgerEntry>;
  try {
    const text = await io.read(path);
    ledger = text === null ? new Map() : parseLedger(text);
  } catch {
    return { kind: "report", repeatsSinceLastReport: 0 };
  }
  const { decision, next } = decideRepeat(ledger, key, io.now());
  try {
    await io.write(path, {
      version: LEDGER_VERSION,
      entries: Object.fromEntries(next),
    });
  } catch {
    // The decision still stands: a report goes out, and a suppression is
    // inside a window the file already recorded. Only this count is lost.
  }
  return decision;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
