import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createOutput,
  type Output,
  type ProgressEvent,
  type ProgressInfo,
} from "../output";
import type { RuntimeContext } from "../runtime";
import { noopLogger } from "../../logger";

// Human-mode progress rendering. The regression pinned here: during a host
// download the registry client interleaves percent-less liveness heartbeats
// (`registry-archive-<phase>`, message "fetching host archive (attempt N)")
// between the percent-bearing byte ticks of the SAME transfer
// (registry/fetch-resource.ts emits the heartbeat at the top of every
// attempt, immediately before publishing the resume offset). A renderer that
// treats those heartbeats as discrete stage lines finalizes the live TTY bar
// with a newline and the next byte tick starts a NEW bar - one frozen,
// stacked bar per attempt. The contract: one bar per download, redrawn in
// place; a heartbeat is a status update on that bar, never its finalizer.

/**
 * The rail's cell count, mirrored from `../output`. Not exported from there:
 * the module's public surface is `createOutput`, and a test that reached in
 * for the constant would be asserting the renderer's arithmetic against
 * itself. Stated here so a width change reddens these cases rather than
 * silently re-deriving with them.
 */
const PROGRESS_BAR_WIDTH = 24;

function makeRuntime(): RuntimeContext {
  return {
    json: false,
    quiet: false,
    noProgress: false,
    noBootstrap: false,
    nonInteractive: false,
    environment: "production",
    logger: noopLogger,
  };
}

function downloadTick(
  message: string,
  percent: number,
  bytes: number,
  totalBytes: number,
): ProgressInfo {
  return {
    stage: "download",
    message,
    percent,
    bytes,
    totalBytes,
    workUnits: null,
  };
}

// Mirrors `emitRegistryHeartbeat` in ../../registry/client.ts: stage
// `registry-archive-<phase>`, human message in `message`, all numeric
// fields null (a heartbeat is a liveness tick, not a transfer measurement).
function archiveHeartbeatTick(
  phase: "attempt" | "watchdog" | "backoff",
  message: string,
): ProgressInfo {
  return {
    stage: `registry-archive-${phase}`,
    message,
    percent: null,
    bytes: null,
    totalBytes: null,
    workUnits: null,
  };
}

interface StderrCapture {
  readonly writes: () => string[];
  readonly restore: () => void;
}

function captureStderr(isTty: boolean): StderrCapture {
  const originalIsTty = Object.getOwnPropertyDescriptor(
    process.stderr,
    "isTTY",
  );
  Object.defineProperty(process.stderr, "isTTY", {
    value: isTty,
    configurable: true,
  });
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  return {
    writes: () =>
      spy.mock.calls.map((call) => {
        const chunk = call[0];
        return typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf8");
      }),
    restore: () => {
      spy.mockRestore();
      Object.defineProperty(
        process.stderr,
        "isTTY",
        originalIsTty ?? { value: undefined, configurable: true },
      );
    },
  };
}

interface StdoutCapture {
  readonly lines: () => string[];
  readonly restore: () => void;
}

/** JSON-mode events go to STDOUT; this is the seam for reading them back. */
function captureJsonStdout(): StdoutCapture {
  const spy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  return {
    lines: () =>
      spy.mock.calls
        .map((call) => {
          const chunk = call[0];
          return typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk).toString("utf8");
        })
        .join("")
        .split("\n")
        .filter((line) => line.length > 0),
    restore: () => {
      spy.mockRestore();
    },
  };
}

let capture: StderrCapture | null = null;

// COLOUR IS ENV-DEPENDENT, so it is pinned rather than inherited. The rail's
// unfilled half is dimmed on a colour-capable TTY, and a developer (or a CI
// runner) with `NO_COLOR` set would otherwise be reading a different string
// from these assertions than the next person. Every case below states which
// of the two it is exercising; `NO_COLOR` is the default because the plain
// rail is the one whose GEOMETRY these tests are about.
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  process.env.NO_COLOR = "1";
});

afterEach(() => {
  capture?.restore();
  capture = null;
  if (originalNoColor === undefined) {
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

describe("createOutput human-mode TTY progress bar", () => {
  it("redraws one bar in place when an archive heartbeat arrives between two download ticks", () => {
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    // install.ts seeds the bar at 0% ...
    output.progress(downloadTick("downloading host 1.5.0", 0, 0, 1000));
    // ... fetch-resource.ts opens attempt 1 with a percent-less heartbeat ...
    output.progress(
      archiveHeartbeatTick("attempt", "fetching host archive (attempt 1)"),
    );
    // ... then publishes the resume offset (61% of a partial download).
    output.progress(downloadTick("downloading host 1.5.0", 61, 610, 1000));

    const writes = capture.writes();
    // One bar per download: every frame is an in-place rewrite; nothing
    // may emit the newline that would freeze the current bar on screen.
    expect(writes.filter((w) => w.includes("\n"))).toEqual([]);
    expect(writes.every((w) => w.startsWith("\r\x1b[2K"))).toBe(true);
    // The heartbeat renders as a status update ON the bar - its text plus
    // the last real transfer numbers - not as a bare stage line.
    expect(writes[1]).toContain("fetching host archive (attempt 1)");
    expect(writes[1]).toContain("0%");
    // The RAIL, not `[`: that used to be this line and it never tested
    // anything - every frame starts with the `\x1b[2K` clear, so a bar drawn
    // with no brackets at all satisfied it.
    expect(writes[1]).toContain("─".repeat(PROGRESS_BAR_WIDTH));
    expect(writes[2]).toContain("downloading host 1.5.0");
    expect(writes[2]).toContain("61%");
  });

  it("keeps redrawing the same live bar across watchdog/backoff/attempt retries instead of stacking frozen bars", () => {
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    output.progress(downloadTick("downloading host 1.5.0", 0, 0, 1000));
    output.progress(downloadTick("downloading host 1.5.0", 61, 610, 1000));
    output.progress(
      archiveHeartbeatTick(
        "watchdog",
        "fetching host archive stalled; retrying",
      ),
    );
    output.progress(
      archiveHeartbeatTick("backoff", "retrying host archive shortly"),
    );
    output.progress(
      archiveHeartbeatTick("attempt", "fetching host archive (attempt 2)"),
    );
    output.progress(downloadTick("downloading host 1.5.0", 61, 610, 1000));
    output.progress(downloadTick("downloading host 1.5.0", 70, 700, 1000));

    const writes = capture.writes();
    expect(writes.filter((w) => w.includes("\n"))).toEqual([]);
    expect(writes.every((w) => w.startsWith("\r\x1b[2K"))).toBe(true);
    // Heartbeat frames hold the bar at its last real percent - a retry
    // must not rewind the rendered number.
    expect(writes[2]).toContain("fetching host archive stalled; retrying");
    expect(writes[2]).toContain("61%");
    expect(writes[4]).toContain("fetching host archive (attempt 2)");
    expect(writes[4]).toContain("61%");
    expect(writes[6]).toContain("70%");
  });

  it("still finalizes the bar with a newline when a percent-less stage transition follows the download", () => {
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    output.progress(downloadTick("downloading host 1.5.0", 100, 1000, 1000));
    output.progress({
      stage: "extract",
      message: "extracting host 1.5.0",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });

    const writes = capture.writes();
    // The completed bar is finalized (newline) and the stage transition
    // gets its own discrete line - unchanged behavior for real stages.
    expect(writes[1]).toBe("\n");
    expect(writes[2]).toBe("extracting host 1.5.0\n");
  });

  it("prints an archive heartbeat as a discrete line when no bar is on screen yet", () => {
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    // download-stage.ts announces the download with a percent-less line;
    // attempt 1's heartbeat fires before any byte progress exists.
    output.progress({
      stage: "download",
      message: "downloading host 1.5.0",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits: null,
    });
    output.progress(
      archiveHeartbeatTick("attempt", "fetching host archive (attempt 1)"),
    );

    const writes = capture.writes();
    expect(writes).toEqual([
      "downloading host 1.5.0\n",
      "fetching host archive (attempt 1)\n",
    ]);
  });
});

describe("createOutput progress bar rendering", () => {
  /** The rail's cells, with the frame's clear/label/percent stripped off. */
  function railOf(frame: string): string {
    const match = /([━╸─]+)/.exec(frame);
    return match === null ? "" : match[1];
  }

  it("never prints a byte count, however many bytes the tick carries", () => {
    // THE RULE, and the reason for it: this bar is on screen while someone
    // waits for Traycer to start, and "(5.2 MB / 10.0 MB)" there reads as
    // "it started downloading something because I ran a command" - reported
    // as alarming on the GUI's equivalent card, and fixed the same way in
    // both. The tick still CARRIES the figures (asserted below), so this is
    // the renderer withholding them, not a fixture that never supplied them.
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    const tick = downloadTick(
      "downloading host 1.5.0",
      52,
      5_452_595,
      10_485_760,
    );
    expect(tick.bytes).toBe(5_452_595);
    expect(tick.totalBytes).toBe(10_485_760);
    output.progress(tick);

    const frame = capture.writes()[0] ?? "";
    expect(frame).toContain("52%");
    expect(frame).not.toContain("MB");
    expect(frame).not.toContain("KB");
    expect(frame).not.toContain("GB");
    expect(frame).not.toMatch(/\d+(\.\d+)?\s*[KMGT]?B/);
    // And the bytes are still on the wire for Desktop, which reads the JSON
    // stream rather than this rail.
    const jsonCapture = captureJsonStdout();
    try {
      createOutput({ ...makeRuntime(), json: true }).progress(tick);
      const event = JSON.parse(jsonCapture.lines()[0] ?? "{}") as ProgressEvent;
      expect(event.bytes).toBe(5_452_595);
      expect(event.totalBytes).toBe(10_485_760);
    } finally {
      jsonCapture.restore();
    }
  });

  it("holds the rail at a fixed cell count so the percentage column never moves", () => {
    // A bar whose width tracked its fill would shuffle the number sideways on
    // every frame - the terminal equivalent of the card that changed height
    // mid-wait. Checked across the whole range, including the two ends.
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    // FRACTIONS INCLUDED. `ProgressInfo.percent` is a `number`, and every
    // producer in this repo happening to `Math.round` its byte ratio is each
    // caller remembering rather than a property of this sink - "2.5%" is five
    // characters and would move the column the rail exists to hold still.
    for (const percent of [0, 1, 2, 2.5, 17, 42, 61, 99.6, 100]) {
      output.progress(
        downloadTick("downloading host 1.5.0", percent, percent, 100),
      );
    }

    const rails = capture.writes().map(railOf);
    expect(rails).toHaveLength(9);
    for (const rail of rails) {
      expect([...rail]).toHaveLength(PROGRESS_BAR_WIDTH);
    }
    // The percentage sits at the same column in every frame.
    const columns = new Set(capture.writes().map((w) => w.indexOf("%")));
    expect(columns.size).toBe(1);
    // Floored, not rounded: 99.6 reads as 99 beside a rail that is
    // deliberately not full, rather than as a 100% that disagrees with it.
    expect(capture.writes()[3]).toContain("  2%");
    expect(capture.writes()[7]).toContain(" 99%");
    expect(capture.writes()[7]).not.toContain("100%");
    expect(rails[7]).not.toBe("━".repeat(PROGRESS_BAR_WIDTH));
  });

  it("floors the percentage on the non-TTY line too, where there is no rail to hold a column", () => {
    // The other half of the same defect: a CI log reading
    // "downloading host 1.5.0 52.34000000000001%".
    capture = captureStderr(false);
    const output = createOutput(makeRuntime());
    output.progress(downloadTick("downloading host 1.5.0", 52.34, 52, 100));

    expect(capture.writes()).toEqual(["downloading host 1.5.0 52%\n"]);
  });

  it("fills by FLOOR with a half-cell leading edge, so it neither overstates a start nor completes early", () => {
    // `Math.round` on whole cells drew a full cell from 2.1% and a full rail
    // from ~98%; the half-cell edge is what buys the resolution back without
    // either lie. One cell is 100/24 = 4.1666…%, so 61% is 14.6 cells.
    capture = captureStderr(true);
    const output = createOutput(makeRuntime());
    for (const percent of [0, 2, 3, 61, 99, 100]) {
      output.progress(
        downloadTick("downloading host 1.5.0", percent, percent, 100),
      );
    }
    const rails = capture.writes().map(railOf);

    // 0% and 2% (0.48 cells) are empty; 3% (0.72) shows the half edge. So the
    // smallest visible advance is ~2.1%, not ~4.2%.
    expect(rails[0]).toBe("─".repeat(PROGRESS_BAR_WIDTH));
    expect(rails[1]).toBe("─".repeat(PROGRESS_BAR_WIDTH));
    expect(rails[2]).toBe(`╸${"─".repeat(PROGRESS_BAR_WIDTH - 1)}`);
    // 61% -> 14.6 cells: 14 full, one half, 9 empty.
    expect(rails[3]).toBe(`${"━".repeat(14)}╸${"─".repeat(9)}`);
    // 99% -> 23.76 cells: NOT a full rail. Only 100% is.
    expect(rails[4]).toBe(`${"━".repeat(23)}╸`);
    expect(rails[5]).toBe("━".repeat(PROGRESS_BAR_WIDTH));
  });

  it("dims the unfilled rail on a colour-capable TTY and prints it bare under NO_COLOR", () => {
    // The two halves differ by line WEIGHT first, so the bar still reads
    // without colour - which is the whole point of dimming only the empty
    // run. A completed rail closes no sequence it never opened.
    delete process.env.NO_COLOR;
    capture = captureStderr(true);
    const coloured = createOutput(makeRuntime());
    coloured.progress(downloadTick("downloading host 1.5.0", 52, 52, 100));
    coloured.progress(downloadTick("downloading host 1.5.0", 100, 100, 100));
    const colouredWrites = capture.writes();
    expect(colouredWrites[0]).toContain(`\x1b[2m${"─".repeat(12)}\x1b[0m`);
    // Nothing dimmed once the rail is full - no stray empty escape pair.
    expect(colouredWrites[1]).not.toContain("\x1b[2m");
    capture.restore();

    process.env.NO_COLOR = "1";
    capture = captureStderr(true);
    const plain = createOutput(makeRuntime());
    plain.progress(downloadTick("downloading host 1.5.0", 52, 52, 100));
    const plainFrame = capture.writes()[0] ?? "";
    expect(plainFrame).not.toContain("\x1b[2m");
    expect(plainFrame).toContain(`${"━".repeat(12)}${"─".repeat(12)}`);
  });
});

describe("createOutput human-mode non-TTY progress", () => {
  it("keeps line-based output with heartbeat lines between decile ticks on a non-TTY stream", () => {
    capture = captureStderr(false);
    const output = createOutput(makeRuntime());
    output.progress(downloadTick("downloading host 1.5.0", 0, 0, 1000));
    output.progress(
      archiveHeartbeatTick("attempt", "fetching host archive (attempt 1)"),
    );
    output.progress(downloadTick("downloading host 1.5.0", 61, 610, 1000));

    const writes = capture.writes();
    expect(writes).toEqual([
      "downloading host 1.5.0 0%\n",
      "fetching host archive (attempt 1)\n",
      "downloading host 1.5.0 61%\n",
    ]);
  });
});

// JSON mode is the DESKTOP path - `traycer-cli.ts` spawns with `--json` and
// parses one NDJSON event per line - so anything this serializer drops is
// invisible to the host controller no matter what the producer emits.
//
// The regression pinned here: `workUnits` was hardcoded `null` on this branch
// while `extract-heartbeat.ts` was emitting a rising archive-entry count. That
// count is the ONLY moving field an extract has (no percent, no byte
// position), so nulling it made every heartbeat of a multi-minute extract
// serialize identically, the controller's progress-advance key never changed,
// and a healthy first install was promoted to the Retry surface.
describe("createOutput JSON-mode progress", () => {
  function jsonRuntime(): RuntimeContext {
    return { ...makeRuntime(), json: true };
  }

  function extractHeartbeat(workUnits: number | null): ProgressInfo {
    return {
      stage: "extract",
      message: "extracting host 1.5.0",
      percent: null,
      bytes: null,
      totalBytes: null,
      workUnits,
    };
  }

  function captureEvents(run: (output: Output) => void): ProgressEvent[] {
    const spy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      run(createOutput(jsonRuntime()));
      return spy.mock.calls.map(
        (call) => JSON.parse(String(call[0])) as ProgressEvent,
      );
    } finally {
      spy.mockRestore();
    }
  }

  it("carries the producer's rising work-unit count onto the wire", () => {
    const events = captureEvents((output) => {
      output.progress(extractHeartbeat(1));
      output.progress(extractHeartbeat(47));
    });

    expect(events.map((event) => event.workUnits)).toEqual([1, 47]);
    // The point of the field, asserted as the EFFECT rather than as one
    // value: every other field a consumer can key on is byte-identical
    // between these two heartbeats, so `workUnits` is the only thing that can
    // tell them apart. Re-null it and this arm reddens on the equality below
    // as well as on the values above.
    expect(events[0].stage).toEqual(events[1].stage);
    expect(events[0].percent).toEqual(events[1].percent);
    expect(events[0].bytes).toEqual(events[1].bytes);
    expect(events[0].workUnits).not.toEqual(events[1].workUnits);
  });

  it("still reports null for a stage with no discrete unit to count", () => {
    const events = captureEvents((output) => {
      output.progress(downloadTick("downloading host 1.5.0", 61, 610, 1000));
    });

    // The control. Forwarding must not become inventing: a producer that
    // counts nothing keeps saying so, or the advance key would go moving for
    // every stage and stop meaning "this one is advancing".
    expect(events[0].workUnits).toBeNull();
  });
});
