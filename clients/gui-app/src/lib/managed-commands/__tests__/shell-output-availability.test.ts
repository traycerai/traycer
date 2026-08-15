import { describe, expect, it } from "vitest";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { HostReachability } from "@/hooks/agent/use-host-reachability";
import {
  shellOutputHostAvailability,
  shellOutputStreamAvailability,
  type ShellOutputStreamSignals,
} from "@/lib/managed-commands/shell-output-availability";

/**
 * Pure priority-table tests for the mapping every output-window state comes
 * from - `UI.md` §4's "one word for what happened" replacing four call sites
 * that used to drift (every fatal close reading as "deleted", an old host
 * blamed for a deletion, an empty log indistinguishable from a dead one).
 */

function signals(
  over: Partial<ShellOutputStreamSignals>,
): ShellOutputStreamSignals {
  return {
    streamSupport: "supported",
    connectionStatus: "open",
    snapshotArrived: true,
    hasLines: true,
    deleted: false,
    fatalClose: null,
    ...over,
  };
}

function fatal(code: string): FatalErrorDetails {
  return {
    code,
    reason: `${code}: test reason`,
    incompatibleMethods: null,
    upgradeGuidance: null,
  };
}

describe("shellOutputStreamAvailability", () => {
  it("reads a fully open, non-empty stream as available", () => {
    expect(shellOutputStreamAvailability(signals({}))).toEqual({
      kind: "available",
    });
  });

  it("puts an unsupported host ahead of every other signal", () => {
    // A host too old to serve the method says so before anything else gets a
    // say - deleted, a fatal close and a missing snapshot are all still true
    // here, but none of them is the reason the window has nothing to show.
    expect(
      shellOutputStreamAvailability(
        signals({
          streamSupport: "unsupported",
          deleted: true,
          fatalClose: fatal("MANAGED_COMMAND_NOT_FOUND"),
          snapshotArrived: false,
        }),
      ),
    ).toEqual({ kind: "unsupported-host" });
  });

  it("lets a deletion outrank the NOT_FOUND close that follows it", () => {
    // The host telling this window it just destroyed the shell is the
    // stronger claim; a NOT_FOUND close after it is only the reconnect
    // discovering the same thing a second time.
    expect(
      shellOutputStreamAvailability(
        signals({
          deleted: true,
          fatalClose: fatal("MANAGED_COMMAND_NOT_FOUND"),
        }),
      ),
    ).toEqual({ kind: "gone", cause: "deleted" });
  });

  it("routes each fatal code to its own reading, by the code alone", () => {
    expect(
      shellOutputStreamAvailability(
        signals({ fatalClose: fatal("MANAGED_COMMAND_NOT_FOUND") }),
      ),
    ).toEqual({ kind: "gone", cause: "not-found" });

    expect(
      shellOutputStreamAvailability(
        signals({ fatalClose: fatal("UNAUTHORIZED") }),
      ),
    ).toEqual({ kind: "unauthorized" });

    const outputFailed = fatal("MANAGED_COMMAND_OUTPUT_FAILED");
    expect(
      shellOutputStreamAvailability(signals({ fatalClose: outputFailed })),
    ).toEqual({ kind: "stream-error", message: outputFailed.reason });

    // A remote host too old for the method never resolves to `"unsupported"`
    // client-side - its support stays `"unknown"` and the subscription is
    // closed with this code instead. So it must read as the same permanent
    // capability state the local case does, not as a failure with a Retry
    // button that can only fetch the same refusal.
    expect(
      shellOutputStreamAvailability(
        signals({ fatalClose: fatal("INCOMPATIBLE") }),
      ),
    ).toEqual({ kind: "unsupported-host" });
  });

  it("stays connecting until the opening snapshot lands, whatever the transport or line count say", () => {
    // The socket declares itself open the moment the subscribe is
    // acknowledged, but the host serves the snapshot only after its first log
    // read - "open" and "has lines" are both true here and neither wins.
    expect(
      shellOutputStreamAvailability(
        signals({
          snapshotArrived: false,
          connectionStatus: "open",
          hasLines: true,
        }),
      ),
    ).toEqual({ kind: "bootstrapping", phase: "connecting" });
  });

  it("only reads as reconnecting once a snapshot has actually landed", () => {
    // Without a snapshot the transport dropping is still "connecting" - the
    // window never had anything to reconnect FROM, so it stays a centred
    // bootstrapping panel rather than a banner over nothing.
    expect(
      shellOutputStreamAvailability(
        signals({ snapshotArrived: false, connectionStatus: "reconnecting" }),
      ),
    ).toEqual({ kind: "bootstrapping", phase: "connecting" });

    expect(
      shellOutputStreamAvailability(
        signals({ snapshotArrived: true, connectionStatus: "reconnecting" }),
      ),
    ).toEqual({ kind: "stale" });
  });

  it("tells an opened-empty log apart from one with lines to read", () => {
    expect(shellOutputStreamAvailability(signals({ hasLines: false }))).toEqual(
      { kind: "empty" },
    );
    expect(shellOutputStreamAvailability(signals({ hasLines: true }))).toEqual({
      kind: "available",
    });
  });
});

describe("shellOutputHostAvailability", () => {
  function reachability(over: Partial<HostReachability>): HostReachability {
    return {
      status: over.status ?? "reachable",
      hostLabel: over.hostLabel ?? "Work laptop",
      unavailability: over.unavailability ?? null,
    };
  }

  it("maps each directory status to its own bootstrapping phase or unreachable-host", () => {
    expect(
      shellOutputHostAvailability(reachability({ status: "checking" })),
    ).toEqual({ kind: "bootstrapping", phase: "checking-host" });

    expect(
      shellOutputHostAvailability(reachability({ status: "host-starting" })),
    ).toEqual({ kind: "bootstrapping", phase: "starting-host" });

    expect(
      shellOutputHostAvailability(
        reachability({ status: "unreachable", hostLabel: "Work laptop" }),
      ),
    ).toEqual({ kind: "unreachable-host", hostLabel: "Work laptop" });
  });

  it("passes a reachable host through as null - the window should open a stream", () => {
    expect(
      shellOutputHostAvailability(reachability({ status: "reachable" })),
    ).toBeNull();
  });
});
