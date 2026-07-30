import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutput, type ProgressInfo } from "../output";
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
  return { stage: "download", message, percent, bytes, totalBytes };
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

let capture: StderrCapture | null = null;

afterEach(() => {
  capture?.restore();
  capture = null;
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
    expect(writes[1]).toContain("[");
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
