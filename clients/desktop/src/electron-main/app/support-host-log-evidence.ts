/**
 * The records of `host.log` a report keeps from BEFORE its line tail.
 *
 * A report attaches the last 500 lines of `host.log`. On a busy host those
 * lines can cover seconds: two reports' tails ended before the stall they
 * were filed about, because a burst of routine lines pushed the stall's
 * WARN out. So, after the tail, the attachment carries a marked section of
 * the last {@link EARLIER_HOST_LOG_RECORD_LIMIT} records from the
 * {@link EARLIER_HOST_LOG_WINDOW_MS} before the report that fall before the
 * tail and that are the evidence a stall needs: WARN and above, stall and
 * suspension lines, warms, rescans and file-sync starts.
 *
 * A host.log record starts with `[YYYY-MM-DD HH:MM:SS.mmm] [LEVEL] ` (the
 * host logger's header, in the host's local time) and runs until the next
 * line that starts with `[`: the logger indents a payload's continuation
 * lines and escapes every `[` a raw lane writes, so a column-0 `[` is always
 * a new record.
 */

export const EARLIER_HOST_LOG_RECORD_LIMIT = 20;
export const EARLIER_HOST_LOG_WINDOW_MS = 15 * 60_000;

export const EARLIER_HOST_LOG_SECTION_START =
  "--- earlier host.log records, not continuous: WARN and above, stalls, warms, rescans and file-sync starts from the 15 minutes before this report, older than the tail above ---";
export const EARLIER_HOST_LOG_SECTION_END =
  "--- end of earlier host.log records ---";

const RECORD_HEADER =
  /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\] \[([A-Z]+)\] /;

const LOUD_LEVELS = new Set(["WARN", "ERROR", "FATAL"]);

/**
 * What a record that is not WARN or above must say to be kept, read on its
 * first line: a stall or suspension line from the stall watchdog, a warm, a
 * rescan, or a file sync starting.
 */
const EVIDENCE_MESSAGE =
  /event loop stall|process was suspended|\bwarm|rescan|starting file sync/i;

type HostLogRecord = {
  readonly atMs: number;
  readonly lines: readonly string[];
};

function recordStart(line: string): { atMs: number; level: string } | null {
  const match = RECORD_HEADER.exec(line);
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, ms, level] = match;
  const atMs = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(ms),
  ).getTime();
  return Number.isFinite(atMs) && level !== undefined ? { atMs, level } : null;
}

/**
 * The evidence records among `lines` (every line before the tail), newest
 * last, at most {@link EARLIER_HOST_LOG_RECORD_LIMIT}, from the
 * {@link EARLIER_HOST_LOG_WINDOW_MS} up to `nowMs`.
 */
export function earlierHostLogRecords(
  lines: readonly string[],
  nowMs: number,
): readonly HostLogRecord[] {
  const kept: HostLogRecord[] = [];
  let current: { atMs: number; lines: string[]; keep: boolean } | null =
    null;
  const close = (): void => {
    if (current?.keep === true) {
      kept.push({ atMs: current.atMs, lines: current.lines });
    }
  };
  for (const line of lines) {
    const start = recordStart(line);
    if (start !== null) {
      close();
      current = {
        atMs: start.atMs,
        lines: [line],
        keep:
          start.atMs >= nowMs - EARLIER_HOST_LOG_WINDOW_MS &&
          start.atMs <= nowMs &&
          (LOUD_LEVELS.has(start.level) || EVIDENCE_MESSAGE.test(line)),
      };
    } else if (current !== null) {
      // A continuation line of the record above; a line before the first
      // header belongs to a record that started before the read.
      current.lines.push(line);
    }
  }
  close();
  return kept.slice(-EARLIER_HOST_LOG_RECORD_LIMIT);
}

/**
 * The marked section for `records`, made by `render` (the caller's scrubber)
 * and held to `maxBytes` by dropping the oldest records; `""` when no record
 * fits or there is none.
 */
export function earlierHostLogSection(
  records: readonly HostLogRecord[],
  maxBytes: number,
  render: (text: string) => string,
): string {
  for (let first = 0; first < records.length; first += 1) {
    const body = records
      .slice(first)
      .map((record) => record.lines.join("\n"))
      .join("\n");
    const section = render(
      `${EARLIER_HOST_LOG_SECTION_START}\n${body}\n${EARLIER_HOST_LOG_SECTION_END}`,
    );
    if (Buffer.byteLength(section, "utf8") <= maxBytes) return section;
  }
  return "";
}
