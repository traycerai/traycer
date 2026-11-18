import { describe, expect, it } from "vitest";
import {
  EARLIER_HOST_LOG_RECORD_LIMIT,
  EARLIER_HOST_LOG_SECTION_END,
  EARLIER_HOST_LOG_SECTION_START,
  EARLIER_HOST_LOG_WINDOW_MS,
  earlierHostLogRecords,
  earlierHostLogSection,
} from "../support-host-log-evidence";

const NOW = new Date(2026, 5, 15, 12, 0, 0, 0).getTime();

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

/** A host.log header for `atMs`, written in local time as the host logger does. */
function header(atMs: number, level: string): string {
  const d = new Date(atMs);
  return (
    `[${String(d.getFullYear())}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}] ` +
    `[${level}] `
  );
}

function record(minutesBefore: number, level: string, message: string): string {
  return `${header(NOW - minutesBefore * 60_000, level)}${message}`;
}

function firstLines(lines: readonly string[]): string[] {
  return earlierHostLogRecords(lines, NOW).map((entry) => entry.lines[0] ?? "");
}

describe("earlierHostLogRecords", () => {
  it("keeps WARN, ERROR and FATAL records whatever they say, and drops routine INFO and DEBUG", () => {
    const lines = [
      record(5, "INFO", "routine request served"),
      record(5, "DEBUG", "routine debug"),
      record(4, "WARN", "something odd"),
      record(3, "ERROR", "something failed"),
      record(2, "FATAL", "something fatal"),
    ];
    expect(firstLines(lines)).toEqual([lines[2], lines[3], lines[4]]);
  });

  it("keeps an INFO record whose first line names a stall, suspension, warm, rescan or file sync", () => {
    const evidence = [
      record(9, "INFO", "host event loop stall detected"),
      record(8, "INFO", "process was suspended for 4000ms"),
      record(7, "INFO", "workspace warm finished"),
      record(6, "INFO", "index rescan queued"),
      record(5, "INFO", "starting file sync for 3 roots"),
    ];
    const lines = [...evidence, record(3, "INFO", "request served")];
    const kept = firstLines(lines);
    expect(kept).toEqual(expect.arrayContaining(evidence));
    expect(kept).not.toContain(lines[lines.length - 1]);
  });

  it("matches the message on the record's first line only, not its continuation lines", () => {
    const lines = [
      record(5, "INFO", "routine request served"),
      "  payload: event loop stall detected",
    ];
    expect(firstLines(lines)).toEqual([]);
  });

  it("keeps only records inside the window: older and future records are excluded", () => {
    const inside = record(14, "WARN", "inside the window");
    const lines = [
      record(EARLIER_HOST_LOG_WINDOW_MS / 60_000 + 1, "WARN", "too old"),
      inside,
      `${header(NOW + 60_000, "WARN")}from the future`,
    ];
    expect(firstLines(lines)).toEqual([inside]);
  });

  it("keeps the newest records when more than the limit qualify, in order", () => {
    const lines: string[] = [];
    for (let index = 0; index < EARLIER_HOST_LOG_RECORD_LIMIT + 5; index += 1) {
      lines.push(
        `${header(NOW - 600_000 + index * 1000, "WARN")}event ${String(index)}`,
      );
    }
    const kept = firstLines(lines);
    expect(kept).toEqual(lines.slice(-EARLIER_HOST_LOG_RECORD_LIMIT));
  });

  it("keeps a record's continuation lines with it and drops them with a dropped record", () => {
    const keptHeader = record(5, "WARN", "host event loop stall detected {");
    const droppedHeader = record(4, "INFO", "routine request served {");
    const lines = [
      droppedHeader,
      "  detail: dropped",
      keptHeader,
      "  maxDelayMs: 47043",
      "}",
    ];
    const records = earlierHostLogRecords(lines, NOW);
    expect(records.map((entry) => entry.lines)).toEqual([
      [keptHeader, "  maxDelayMs: 47043", "}"],
    ]);
  });

  it("ignores lines before the first header", () => {
    expect(earlierHostLogRecords(["  torn continuation"], NOW)).toEqual([]);
  });
});

describe("earlierHostLogSection", () => {
  const identity = (text: string): string => text;

  /** The section for the records among `lines`, as the caller builds it. */
  function sectionOf(
    lines: readonly string[],
    maxBytes: number,
    render: (text: string) => string,
  ): string {
    return earlierHostLogSection(
      earlierHostLogRecords(lines, NOW),
      maxBytes,
      render,
    );
  }

  it("returns an empty string when there are no records", () => {
    expect(earlierHostLogSection([], 10_000, identity)).toBe("");
  });

  it("wraps the records, oldest first, between the start and end markers", () => {
    const first = record(5, "WARN", "first");
    const second = record(4, "WARN", "second");
    expect(sectionOf([first, second], 10_000, identity)).toBe(
      `${EARLIER_HOST_LOG_SECTION_START}\n${first}\n${second}\n${EARLIER_HOST_LOG_SECTION_END}`,
    );
  });

  it("drops the oldest records first until the section fits the byte budget", () => {
    const oldest = record(5, "WARN", `oldest ${"x".repeat(200)}`);
    const middle = record(4, "WARN", `middle ${"x".repeat(200)}`);
    const newest = record(3, "WARN", "newest");
    const newestOnly = sectionOf([newest], 10_000, identity);
    const section = sectionOf(
      [oldest, middle, newest],
      Buffer.byteLength(newestOnly, "utf8"),
      identity,
    );
    expect(section).toBe(newestOnly);
  });

  it("returns an empty string when not even the newest record fits", () => {
    expect(
      sectionOf(
        [record(5, "WARN", "only")],
        EARLIER_HOST_LOG_SECTION_START.length,
        identity,
      ),
    ).toBe("");
  });

  it("measures the rendered section, so a scrubber that shortens the text lets more records in", () => {
    const lines = [
      record(5, "WARN", `ancient ${"x".repeat(600)}`),
      record(4, "WARN", "newer"),
    ];
    const render = (text: string): string => text.replace(/x+/g, "x");
    expect(sectionOf(lines, 600, render)).toContain("ancient x");
    expect(sectionOf(lines, 600, identity)).not.toContain("ancient");
  });

  it("passes the whole section, markers included, through the renderer", () => {
    const rendered = sectionOf(
      [record(5, "WARN", "plain")],
      10_000,
      (text) => `<${text}>`,
    );
    expect(rendered.startsWith(`<${EARLIER_HOST_LOG_SECTION_START}`)).toBe(
      true,
    );
    expect(rendered.endsWith(`${EARLIER_HOST_LOG_SECTION_END}>`)).toBe(true);
  });
});
