import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SendTimings,
  type SendTimingBatch,
  type SendTimingEntry,
} from "@traycer/protocol/host/agent/gui/send-timing";

/**
 * `SendTimings` is a local-only, opt-in, BATCHED diagnostic: `mark()`/
 * `begin()` only ever append to an in-memory buffer - the `emit` callback the
 * constructor takes is called with a whole `SendTimingBatch`
 * (`{entries, droppedEntries}`), never per-mark, either from an explicit
 * `flush()` or automatically ~1s after the first buffered entry. Its contract
 * also covers: a disabled recorder is a total no-op, a retried `begin()`
 * adopts the new attempt's identity while preserving the ORIGINAL elapsed
 * origin, most phases can recur (only `provider_activity` and
 * `transcript_received` dedupe, each once per attempt - a retry's reset
 * occurrences map re-arms both),
 * `markForObserver` only fires for the trace's CURRENT observer (never a
 * faster bystander), and the pending-reconciliation gate fires at most once
 * per attempt.
 */

const CONTEXT = { side: "host" as const, epicId: "epic-1", chatId: "chat-1" };

function recordingTimings(enabled: boolean): {
  readonly timings: SendTimings;
  readonly batches: SendTimingBatch[];
} {
  const batches: SendTimingBatch[] = [];
  const timings = new SendTimings(
    CONTEXT,
    (batch) => batches.push(batch),
    enabled,
  );
  return { timings, batches };
}

/** Every entry across every emitted batch so far, in emission order. */
function allEntries(batches: readonly SendTimingBatch[]): SendTimingEntry[] {
  return batches.flatMap((batch) => batch.entries);
}

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const UUID_C = "33333333-3333-3333-3333-333333333333";

describe("SendTimings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("disabled: begin()/mark()/markForObserver()/reconcilePending() are total no-ops - nothing is ever emitted, even after an explicit flush()", () => {
    const { timings, batches } = recordingTimings(false);
    timings.begin(UUID_A, UUID_B, "observer-1");
    timings.mark(UUID_A, "validated");
    timings.markForObserver(UUID_A, "observer-1", "acceptance_held");
    expect(timings.pendingIsUnreconciled(UUID_A)).toBe(false);
    timings.reconcilePending(UUID_A, "pending_removed");
    timings.flush();
    expect(batches).toHaveLength(0);
  });

  it("buffers entries privately: mark() never calls emit synchronously, only flush() (explicit or the ~1s auto-flush) does", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    timings.mark(UUID_A, "validated");
    expect(batches).toHaveLength(0);

    timings.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]?.entries.map((entry) => entry.phase)).toEqual([
      "received",
      "validated",
    ]);
  });

  it("auto-flushes ~1s after the first buffered entry, with no further explicit flush() call", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    expect(batches).toHaveLength(0);

    vi.advanceTimersByTime(999);
    expect(batches).toHaveLength(0);
    vi.advanceTimersByTime(2);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.entries.map((entry) => entry.phase)).toEqual([
      "received",
    ]);
  });

  it("flush() cancels a pending auto-flush timer: no double emission of the same entries", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    timings.flush();
    expect(batches).toHaveLength(1);

    // The auto-flush timer that `begin()` armed must have been cancelled by
    // the explicit flush() above - advancing past its original 1s deadline
    // must not produce a second, empty or duplicate batch.
    vi.advanceTimersByTime(1_500);
    expect(batches).toHaveLength(1);
  });

  it("flush() with nothing buffered does not call emit at all (not even an empty batch)", () => {
    const { timings, batches } = recordingTimings(true);
    timings.flush();
    expect(batches).toHaveLength(0);
  });

  it("keeps elapsedMs/monotonicMs monotonic across a Date.now() jump, while wallTimeMs reflects the jump", () => {
    vi.setSystemTime(new Date(2010, 0, 1));
    const perfNow = vi.spyOn(performance, "now");
    let clock = 0;
    perfNow.mockImplementation(() => clock);

    const { timings, batches } = recordingTimings(true);
    const wallAtBegin = Date.now();
    timings.begin(UUID_A, UUID_B, null);
    clock += 50;

    // A wall clock that jumps BACKWARD (NTP correction, DST, a system clock
    // reset) must not perturb the monotonic fields at all.
    vi.setSystemTime(new Date(2000, 0, 1));
    const wallBefore = Date.now();
    timings.mark(UUID_A, "validated");
    clock += 25;
    vi.setSystemTime(new Date(1990, 0, 1));
    const wallAfter = Date.now();
    timings.mark(UUID_A, "queued");
    timings.flush();

    const [begin, validated, queued] = allEntries(batches);
    expect(begin?.wallTimeMs).toBe(wallAtBegin);
    expect(validated?.elapsedMs).toBe(50);
    expect(validated?.monotonicMs).toBe(50);
    expect(queued?.elapsedMs).toBe(75);
    expect(queued?.monotonicMs).toBe(75);
    expect(queued?.sincePreviousMs).toBe(25);
    expect(queued?.elapsedMs).toBeGreaterThan(validated?.elapsedMs ?? -1);
    expect(validated?.wallTimeMs).toBe(wallBefore);
    expect(queued?.wallTimeMs).toBe(wallAfter);
    expect(queued?.wallTimeMs).toBeLessThan(validated?.wallTimeMs ?? Infinity);
    expect(wallBefore).toBeLessThan(wallAtBegin);
  });

  it("most phases can recur, each producing its own entry with an incrementing occurrence - only provider_activity and transcript_received dedupe", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    timings.mark(UUID_A, "queued");
    timings.mark(UUID_A, "queued");
    timings.mark(UUID_A, "queued");
    timings.mark(UUID_A, "provider_activity");
    timings.mark(UUID_A, "provider_activity");
    timings.mark(UUID_A, "provider_activity");
    timings.mark(UUID_A, "transcript_received");
    timings.mark(UUID_A, "transcript_received");
    timings.mark(UUID_A, "transcript_received");
    timings.flush();

    const entries = allEntries(batches);
    const queuedOccurrences = entries
      .filter((entry) => entry.phase === "queued")
      .map((entry) => entry.occurrence);
    expect(queuedOccurrences).toEqual([1, 2, 3]);
    expect(
      entries.filter((entry) => entry.phase === "provider_activity"),
    ).toHaveLength(1);
    const transcriptReceivedEntries = entries.filter(
      (entry) => entry.phase === "transcript_received",
    );
    expect(transcriptReceivedEntries).toHaveLength(1);
    expect(transcriptReceivedEntries[0]?.occurrence).toBe(1);
  });

  it("transcript_received keeps its FIRST recorded timestamp across repeated snapshots within one attempt, but a retransmitted attempt (begin() again) permits a fresh receipt", () => {
    const perfNow = vi.spyOn(performance, "now");
    let clock = 0;
    perfNow.mockImplementation(() => clock);

    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    clock += 50;
    // First snapshot fold: the message lands in the transcript.
    timings.mark(UUID_A, "transcript_received");
    clock += 500;
    // A LATER snapshot re-delivers the same row (a resnapshot, a backfill) -
    // repeated marks must not push the recorded timestamp out to whenever
    // the last one happened to arrive.
    timings.mark(UUID_A, "transcript_received");
    timings.mark(UUID_A, "transcript_received");
    timings.flush();

    const firstAttemptEntries = allEntries(batches).filter(
      (entry) => entry.phase === "transcript_received",
    );
    expect(firstAttemptEntries).toHaveLength(1);
    expect(firstAttemptEntries[0]?.attempt).toBe(1);
    expect(firstAttemptEntries[0]?.occurrence).toBe(1);
    // Recorded at the FIRST mark (clock=50), not the third (clock=550).
    expect(firstAttemptEntries[0]?.elapsedMs).toBe(50);

    // A retry resets occurrences (same mechanism `hasPhase()`'s own retry
    // test pins), so the new attempt's transcript_received is not treated as
    // already seen - a genuinely new attempt gets its own fresh receipt mark.
    batches.length = 0;
    clock += 100;
    timings.begin(UUID_A, UUID_C, null);
    clock += 25;
    timings.mark(UUID_A, "transcript_received");
    timings.flush();

    const secondAttemptEntries = allEntries(batches).filter(
      (entry) => entry.phase === "transcript_received",
    );
    expect(secondAttemptEntries).toHaveLength(1);
    expect(secondAttemptEntries[0]?.attempt).toBe(2);
    expect(secondAttemptEntries[0]?.occurrence).toBe(1);
    // Origin (elapsedMs) is still the ORIGINAL begin() at clock=0: 50 (begin)
    // + 500 (repeats) + 100 (between begin() calls) + 25 = 675.
    expect(secondAttemptEntries[0]?.elapsedMs).toBe(675);
    // attemptElapsedMs is scoped to THIS attempt's own begin(), which fired
    // at clock=650 (50+500+100): 25ms after it.
    expect(secondAttemptEntries[0]?.attemptElapsedMs).toBe(25);
  });

  it("a retry (begin() again) adopts the new clientActionId/observerKey and resets occurrences, but preserves the ORIGINAL elapsed origin while attemptElapsedMs restarts", () => {
    const perfNow = vi.spyOn(performance, "now");
    let clock = 0;
    perfNow.mockImplementation(() => clock);

    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, "observer-1");
    timings.mark(UUID_A, "validated");
    clock += 200;
    timings.begin(UUID_A, UUID_C, "observer-2");

    timings.flush();
    const firstRound = allEntries(batches);
    const [received, validated, retransmitted] = firstRound;
    expect(received?.phase).toBe("received");
    expect(received?.attempt).toBe(1);
    expect(validated?.phase).toBe("validated");
    expect(retransmitted?.phase).toBe("retransmitted");
    expect(retransmitted?.previousPhase).toBe("validated");
    expect(retransmitted?.attempt).toBe(2);
    // Origin preserved: 200ms since the ORIGINAL begin(), not a reset clock.
    expect(retransmitted?.elapsedMs).toBe(200);
    // attemptElapsedMs restarts with the new attempt: this retry is itself
    // 0ms old at the moment it fires.
    expect(retransmitted?.attemptElapsedMs).toBe(0);
    expect(retransmitted?.clientActionId).toBe(UUID_C);

    // The retried attempt's own occurrences are reset: the SAME phase that
    // already fired once under attempt 1 can fire again as attempt 2's
    // occurrence 1, not occurrence 2.
    clock += 10;
    timings.mark(UUID_A, "validated");
    timings.flush();
    const secondValidated = allEntries(batches).at(-1);
    expect(secondValidated?.phase).toBe("validated");
    expect(secondValidated?.attempt).toBe(2);
    expect(secondValidated?.occurrence).toBe(1);
    expect(secondValidated?.elapsedMs).toBe(210);
    expect(secondValidated?.attemptElapsedMs).toBe(10);

    // begin() also reset pendingReconciled=false for the new attempt.
    expect(timings.pendingIsUnreconciled(UUID_A)).toBe(true);

    // And the retry adopted the new observer: a mark for the OLD observer no
    // longer matches.
    batches.length = 0;
    timings.markForObserver(UUID_A, "observer-1", "acceptance_held");
    timings.markForObserver(UUID_A, "observer-2", "acceptance_held");
    timings.flush();
    expect(allEntries(batches)).toHaveLength(1);
  });

  it("markForObserver only fires for the trace's CURRENT observer - a faster bystander must not win", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, "originating-connection");
    timings.markForObserver(UUID_A, "bystander-connection", "acceptance_held");
    timings.markForObserver(
      UUID_A,
      "originating-connection",
      "acceptance_held",
    );
    timings.flush();

    const entries = allEntries(batches);
    expect(
      entries.filter((entry) => entry.phase === "acceptance_held"),
    ).toHaveLength(1);
  });

  it("hasPhase() reflects the occurrences map for the CURRENT attempt only", () => {
    const { timings } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    expect(timings.hasPhase(UUID_A, "acceptance_received")).toBe(false);
    timings.mark(UUID_A, "acceptance_received");
    expect(timings.hasPhase(UUID_A, "acceptance_received")).toBe(true);

    // A retry resets occurrences: the phase is no longer considered "seen"
    // for the new attempt until it is marked again.
    timings.begin(UUID_A, UUID_C, null);
    expect(timings.hasPhase(UUID_A, "acceptance_received")).toBe(false);
  });

  it("pendingIsUnreconciled()/reconcilePending() gate at most one reconciliation per attempt, and a retry re-arms it", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    expect(timings.pendingIsUnreconciled(UUID_A)).toBe(true);

    timings.reconcilePending(UUID_A, "pending_replaced_by_transcript");
    expect(timings.pendingIsUnreconciled(UUID_A)).toBe(false);
    // A second reconciliation attempt for the SAME attempt is silently
    // dropped, even naming a different phase.
    timings.reconcilePending(UUID_A, "pending_removed");
    timings.flush();
    const phases = allEntries(batches).map((entry) => entry.phase);
    expect(phases.filter((phase) => phase.startsWith("pending_"))).toEqual([
      "pending_replaced_by_transcript",
    ]);

    // A retry re-arms the gate for the new attempt.
    timings.begin(UUID_A, UUID_C, null);
    expect(timings.pendingIsUnreconciled(UUID_A)).toBe(true);
    timings.reconcilePending(UUID_A, "pending_removed");
    timings.flush();
    expect(allEntries(batches).at(-1)?.phase).toBe("pending_removed");
  });

  it("bounds the buffer: entries beyond 4096 are dropped and counted in droppedEntries, without breaking bounded trace retention", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    const OVER_CAP = 4096 + 50;
    // `begin()` already produced 1 entry ("received"); fill the rest with a
    // freely-recurring phase.
    for (let index = 0; index < OVER_CAP - 1; index += 1) {
      timings.mark(UUID_A, "queued");
    }
    timings.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.entries).toHaveLength(4096);
    expect(batches[0]?.droppedEntries).toBe(OVER_CAP - 4096);

    // The dropped-count resets on the NEXT batch: it is per-flush, not a
    // running total.
    timings.mark(UUID_A, "validated");
    timings.flush();
    expect(batches[1]?.droppedEntries).toBe(0);
  });

  it("bounds retention: the oldest trace is evicted once MAX_TRACES (128) is exceeded, and a mark on an evicted id is silently dropped", () => {
    const { timings, batches } = recordingTimings(true);
    const MAX_TRACES = 128;
    for (let index = 0; index < MAX_TRACES; index += 1) {
      timings.begin(`msg-${String(index)}`, UUID_B, null);
    }
    timings.begin("msg-overflow", UUID_B, null);
    timings.flush();
    expect(allEntries(batches)).toHaveLength(MAX_TRACES + 1);

    batches.length = 0;
    timings.mark("msg-0", "validated");
    timings.flush();
    expect(batches).toHaveLength(0);

    timings.mark("msg-overflow", "validated");
    timings.flush();
    expect(batches).toHaveLength(1);
  });

  it("silently drops begin() for an oversized messageId or clientActionId (>128 chars): no trace starts, and a later mark on it emits nothing", () => {
    const oversized = "a".repeat(129);
    const fits = "a".repeat(128);

    const { timings, batches } = recordingTimings(true);
    timings.begin(oversized, UUID_B, null);
    timings.mark(oversized, "validated");
    timings.flush();
    expect(batches).toHaveLength(0);

    timings.begin(UUID_A, oversized, null);
    timings.mark(UUID_A, "validated");
    timings.flush();
    expect(batches).toHaveLength(0);

    // The boundary itself (exactly 128) is not oversized and still traces.
    timings.begin(fits, UUID_B, null);
    timings.flush();
    expect(batches).toHaveLength(1);
  });

  it("mark(null, phase) and markForObserver with no matching trace are silent no-ops", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    timings.flush();
    batches.length = 0;

    expect(() => {
      timings.mark(null, "attachments_ready");
    }).not.toThrow();
    expect(() => {
      timings.markForObserver("no-such-message", "observer-1", "queue_held");
    }).not.toThrow();
    timings.flush();
    expect(batches).toHaveLength(0);

    timings.mark(UUID_A, "validated");
    timings.flush();
    expect(allEntries(batches).map((entry) => entry.phase)).toEqual([
      "validated",
    ]);
  });

  it("clear() flushes any buffered entries synchronously, THEN drops every in-flight trace", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin(UUID_A, UUID_B, null);
    timings.mark(UUID_A, "validated");
    timings.clear();

    expect(batches).toHaveLength(1);
    expect(batches[0]?.entries.map((entry) => entry.phase)).toEqual([
      "received",
      "validated",
    ]);

    batches.length = 0;
    timings.mark(UUID_A, "queued");
    timings.flush();
    expect(batches).toHaveLength(0);
  });

  it("renders a non-UUID message/action id as <non-uuid> rather than leaking the raw value", () => {
    const { timings, batches } = recordingTimings(true);
    timings.begin("not-a-uuid", "also-not-a-uuid", null);
    timings.flush();
    const entry = allEntries(batches)[0];
    expect(entry?.messageId).toBe("<non-uuid>");
    expect(entry?.clientActionId).toBe("<non-uuid>");
  });

  it("isolates the caller from a throwing emit callback: flush() never throws, even though the entries that triggered the throw are lost", () => {
    const thrownBatches: SendTimingBatch[] = [];
    const timings = new SendTimings(
      CONTEXT,
      (batch) => {
        thrownBatches.push(batch);
        throw new Error("emit sink is down");
      },
      true,
    );

    timings.begin(UUID_A, UUID_B, null);
    expect(() => {
      timings.flush();
    }).not.toThrow();
    expect(thrownBatches).toHaveLength(1);

    // A later, non-throwing flush still comes through: one bad emit does not
    // wedge the recorder or the trace.
    const { timings: healthy, batches } = recordingTimings(true);
    healthy.begin(UUID_A, UUID_B, null);
    healthy.flush();
    batches.length = 0;
    healthy.mark(UUID_A, "queued");
    healthy.flush();
    expect(allEntries(batches).map((entry) => entry.phase)).toEqual(["queued"]);
  });
});
