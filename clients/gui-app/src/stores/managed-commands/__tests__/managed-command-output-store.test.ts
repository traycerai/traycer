import { describe, expect, it } from "vitest";
import {
  MANAGED_COMMAND_MAX_WINDOW_LINES,
  type ManagedCommandLogLine,
  type ManagedCommandLogPosition,
  type ManagedCommandSubscribeOutputClientFrame,
} from "@traycer/protocol/host/managed-command/subscribe";
import type { FatalErrorDetails } from "@traycer/protocol/framework/ws-protocol";
import type { ManagedCommand } from "@traycer/protocol/host/managed-command/unary-schemas";
import type { ManagedCommandOutputStreamCallbacks } from "@traycer-clients/shared/host-transport/managed-command-output-stream-client";
import {
  createManagedCommandOutputStore,
  MANAGED_COMMAND_OLDER_PAGE_LINES,
  MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES,
  MANAGED_COMMAND_OUTPUT_RETENTION_TARGET_LINES,
  type ManagedCommandOutputStoreHandle,
} from "@/stores/managed-commands/managed-command-output-store";

/**
 * The viewer half of the Shells surface (`UI.md` §4): one interleaved
 * timeline, opened at the tail and paged backwards on demand. Gaplessness is
 * the host's contract - the client's job is to hand back the position it was
 * given and to append what arrives, in order.
 */

const COMMAND: ManagedCommand = {
  id: "cmd-1",
  monitoring: true,
  description: "deploy watcher",
  command: "tail -f deploy.log",
  cwd: "/work/repo",
  cadence: { debounceMs: 500, maxWaitMs: 15_000, throttleMs: 5_000 },
  status: { state: "running", pid: 4410, startedAtMs: 10 },
  chatId: "chat-1",
  createdAtMs: 10,
  updatedAtMs: 10,
};

function line(text: string): ManagedCommandLogLine {
  return { channel: "stdout", text, atMs: 1_000 };
}

/** A close that is about the stream, not the shell - the host's own reader threw. */
const OUTPUT_FAILED: FatalErrorDetails = {
  code: "MANAGED_COMMAND_OUTPUT_FAILED",
  reason: "MANAGED_COMMAND_OUTPUT_FAILED: log reader crashed",
  incompatibleMethods: null,
  upgradeGuidance: null,
};

function position(
  segmentId: string,
  byteOffset: number,
): ManagedCommandLogPosition {
  return { segmentId, byteOffset };
}

interface Harness {
  readonly handle: ManagedCommandOutputStoreHandle;
  readonly emit: () => ManagedCommandOutputStreamCallbacks;
  readonly sent: ManagedCommandSubscribeOutputClientFrame[];
  readonly resnapshotCalls: () => number;
}

/** The one client frame the viewer sends; narrowed for the assertions below. */
function loadOlderFrame(
  frame: ManagedCommandSubscribeOutputClientFrame,
): Extract<ManagedCommandSubscribeOutputClientFrame, { kind: "loadOlder" }> {
  if (frame.kind !== "loadOlder") {
    throw new Error(`expected a loadOlder frame, got ${frame.kind}`);
  }
  return frame;
}

function harness(): Harness {
  let captured: ManagedCommandOutputStreamCallbacks | null = null;
  const sent: ManagedCommandSubscribeOutputClientFrame[] = [];
  let resnapshotCalls = 0;
  const handle = createManagedCommandOutputStore({
    epicId: "epic-1",
    commandId: "cmd-1",
    streamClientFactory: (_epicId, _commandId, callbacks) => {
      captured = callbacks;
      return {
        loadOlder: (frame) => {
          sent.push(frame);
        },
        resnapshot: () => {
          resnapshotCalls += 1;
        },
        close: () => undefined,
        streamMethodSupport: null,
      };
    },
  });
  return {
    handle,
    emit: () => {
      if (captured === null) throw new Error("stream callbacks not wired");
      return captured;
    },
    sent,
    resnapshotCalls: () => resnapshotCalls,
  };
}

function texts(handle: ManagedCommandOutputStoreHandle): string[] {
  return handle.store.getState().lines.map((entry) => entry.text);
}

function openAtTail(h: Harness): void {
  h.emit().onSnapshot({
    command: COMMAND,
    lines: [line("tail-1"), line("tail-2")],
    start: position("seg-2", 40),
    reachedStart: false,
  });
}

describe("managed-command output store", () => {
  it("opens at the tail and appends live output in arrival order", () => {
    const h = harness();

    openAtTail(h);
    h.emit().onOutput({
      lines: [line("live-1"), line("live-2")],
      start: position("seg-2", 80),
    });

    expect(texts(h.handle)).toEqual(["tail-1", "tail-2", "live-1", "live-2"]);
    expect(h.handle.store.getState().command).toEqual(COMMAND);
  });

  it("trims a following timeline only at a positioned frame boundary and pages the discarded gap back", () => {
    const h = harness();
    openAtTail(h);
    const frameSize = 1_000;
    const frameCount = Math.ceil(
      (MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES + frameSize) / frameSize,
    );

    for (let frame = 0; frame < frameCount; frame += 1) {
      h.emit().onOutput({
        start: position("seg-live", frame * frameSize),
        lines: Array.from({ length: frameSize }, (_, index) =>
          line(`live-${frame}-${index}`),
        ),
      });
    }

    const retained = h.handle.store.getState();
    expect(retained.lines.length).toBeLessThanOrEqual(
      MANAGED_COMMAND_OUTPUT_RETENTION_TARGET_LINES + frameSize,
    );
    expect(retained.start).toEqual(position("seg-live", 5_000));
    expect(retained.lines[0].text).toBe("live-5-0");
    expect(retained.reachedStart).toBe(false);

    retained.loadOlder();
    const request = loadOlderFrame(h.sent[0]);
    expect(request.before).toEqual(position("seg-live", 5_000));
    h.emit().onOlder({
      requestId: request.requestId,
      start: position("seg-live", 4_000),
      lines: [line("recovered-before-boundary")],
      reachedStart: false,
    });
    expect(texts(h.handle).slice(0, 2)).toEqual([
      "recovered-before-boundary",
      "live-5-0",
    ]);
  });

  it("abandons a stalled older page before trimming a following timeline", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().loadOlder();
    const stalledRequest = loadOlderFrame(h.sent[0]);

    const frameSize = MANAGED_COMMAND_MAX_WINDOW_LINES;
    const frameCount =
      Math.ceil(MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES / frameSize) + 1;
    for (let frame = 0; frame < frameCount; frame += 1) {
      h.emit().onOutput({
        start: position("seg-live", frame * frameSize),
        lines: Array.from({ length: frameSize }, (_, index) =>
          line(`live-${frame}-${index}`),
        ),
      });
    }

    const trimmed = h.handle.store.getState();
    expect(trimmed.loadingOlder).toBe(false);
    expect(trimmed.lines.length).toBeLessThanOrEqual(
      MANAGED_COMMAND_OUTPUT_RETENTION_TARGET_LINES + frameSize,
    );

    const textsBeforeStaleReply = texts(h.handle);
    h.emit().onOlder({
      requestId: stalledRequest.requestId,
      lines: [line("stale-older-page")],
      start: position("seg-1", 0),
      reachedStart: false,
    });
    expect(texts(h.handle)).toEqual(textsBeforeStaleReply);
  });

  it("does not append while the reader is scrolled back, then resnapshots when follow resumes", () => {
    // Superseded design: a scrolled-back reader used to keep accumulating
    // every live frame in the backing array, unbounded by scroll duration or
    // output rate. It now detaches instead - live output is discarded and
    // only counted, so the held history the reader is looking at never grows
    // behind their back; resuming follow re-bases from a fresh tail rather
    // than replaying everything that was withheld.
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().setFollowing(false);

    for (let frame = 0; frame < 22; frame += 1) {
      h.emit().onOutput({
        start: position("seg-live", frame * 1_000),
        lines: Array.from({ length: 1_000 }, (_, index) =>
          line(`live-${frame}-${index}`),
        ),
      });
    }

    expect(h.handle.store.getState().lines).toHaveLength(2);
    expect(h.handle.store.getState().start).toEqual(position("seg-2", 40));
    expect(h.handle.store.getState().detached).toBe(true);
    expect(h.handle.store.getState().newOutputAvailable).toBe(true);

    h.handle.store.getState().setFollowing(true);
    expect(h.resnapshotCalls()).toBe(1);

    h.emit().onSnapshot({
      command: COMMAND,
      lines: [line("fresh-tail")],
      start: position("seg-live", 22_000),
      reachedStart: false,
    });

    expect(texts(h.handle)).toEqual(["fresh-tail"]);
  });

  it("pages backwards from the position it was handed, oldest lines in front", () => {
    const h = harness();
    openAtTail(h);

    h.handle.store.getState().loadOlder();

    expect(h.sent).toEqual([
      {
        kind: "loadOlder",
        hasBinaryPayload: false,
        // A uuid has no expected value; the outrun-request case below is what
        // pins what the id is FOR.
        requestId: loadOlderFrame(h.sent[0]).requestId,
        before: position("seg-2", 40),
        maxLines: 500,
      },
    ]);
    // A page is a screenful, and the wire refuses anything past its own
    // ceiling - so the constant has to stay under it.
    expect(MANAGED_COMMAND_OLDER_PAGE_LINES).toBeLessThanOrEqual(
      MANAGED_COMMAND_MAX_WINDOW_LINES,
    );

    h.emit().onOlder({
      requestId: loadOlderFrame(h.sent[0]).requestId,
      lines: [line("older-1"), line("older-2")],
      start: position("seg-1", 0),
      reachedStart: true,
    });

    expect(texts(h.handle)).toEqual(["older-1", "older-2", "tail-1", "tail-2"]);
    expect(h.handle.store.getState().reachedStart).toBe(true);
  });

  it("ignores an older window that a newer request outran", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().loadOlder();

    h.emit().onOlder({
      requestId: "some-abandoned-request",
      lines: [line("stale-1")],
      start: position("seg-0", 0),
      reachedStart: true,
    });

    expect(texts(h.handle)).toEqual(["tail-1", "tail-2"]);
    expect(h.handle.store.getState().reachedStart).toBe(false);
  });

  it("stops asking once the host says nothing older is retained", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().loadOlder();
    h.emit().onOlder({
      requestId: loadOlderFrame(h.sent[0]).requestId,
      lines: [line("older-1")],
      start: position("seg-1", 0),
      reachedStart: true,
    });

    h.handle.store.getState().loadOlder();

    expect(h.sent).toHaveLength(1);
  });

  it("leaves the retained lines in state after a deletion - the window decides whether to show them", () => {
    const h = harness();
    openAtTail(h);

    h.emit().onDeleted();

    // The STORE keeps every line it already held; deletion only flips the
    // flag. What a viewer does with them is the window's own call now (it
    // shows none, for the terminal `gone` state) - this store makes no claim
    // about the screen, only about what it retains.
    expect(h.handle.store.getState().deleted).toBe(true);
    expect(texts(h.handle)).toEqual(["tail-1", "tail-2"]);
  });

  it("a fatal close clears an in-flight page and stops paging", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().loadOlder();

    expect(h.sent).toHaveLength(1);
    expect(h.handle.store.getState().loadingOlder).toBe(true);

    h.emit().onConnectionStatus("closed", {
      kind: "fatalError",
      details: OUTPUT_FAILED,
    });

    expect(h.handle.store.getState().loadingOlder).toBe(false);
    expect(h.handle.store.getState().fatalClose).toEqual(OUTPUT_FAILED);

    // Nothing can land on a stream the host closed for good - asking again
    // would leave a second spinner waiting on a reply that never comes.
    h.handle.store.getState().loadOlder();
    expect(h.sent).toHaveLength(1);
  });

  it("a deletion stops paging without claiming the tail was ever the start", () => {
    const h = harness();
    openAtTail(h);
    expect(h.handle.store.getState().reachedStart).toBe(false);

    h.emit().onDeleted();

    // `reachedStart` is the host's own word about the retained log; a
    // deletion is a different fact and must not borrow that word.
    expect(h.handle.store.getState().deleted).toBe(true);
    expect(h.handle.store.getState().reachedStart).toBe(false);
    expect(h.handle.store.getState().loadingOlder).toBe(false);

    h.handle.store.getState().loadOlder();
    expect(h.sent).toHaveLength(0);
  });

  it("follows the command's own state changes", () => {
    const h = harness();
    openAtTail(h);

    h.emit().onStatus({
      ...COMMAND,
      status: { state: "exited", exitCode: 1, signal: null, exitedAtMs: 90 },
      updatedAtMs: 90,
    });

    expect(h.handle.store.getState().command?.status).toEqual({
      state: "exited",
      exitCode: 1,
      signal: null,
      exitedAtMs: 90,
    });
  });

  it("scrolling up and back down without missing any output never resnapshots", () => {
    const h = harness();
    openAtTail(h);

    h.handle.store.getState().setFollowing(false);
    h.handle.store.getState().setFollowing(true);

    // Nothing arrived while the reader was scrolled back, so there is nothing
    // to re-base: a resnapshot round-trip here would be pure waste.
    expect(h.resnapshotCalls()).toBe(0);
    expect(h.handle.store.getState().detached).toBe(false);
    expect(h.handle.store.getState().resyncPending).toBe(false);
    expect(texts(h.handle)).toEqual(["tail-1", "tail-2"]);
  });

  it("discards live output while detached and flags that output was missed", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().setFollowing(false);

    h.emit().onOutput({
      lines: [line("missed-1")],
      start: position("seg-2", 80),
    });

    expect(texts(h.handle)).toEqual(["tail-1", "tail-2"]);
    expect(h.handle.store.getState().detached).toBe(true);
    expect(h.handle.store.getState().newOutputAvailable).toBe(true);

    // Further frames while still detached are discarded the same way; the
    // reader's held history is never disturbed by output it cannot see yet.
    h.emit().onOutput({
      lines: [line("missed-2")],
      start: position("seg-2", 90),
    });
    expect(texts(h.handle)).toEqual(["tail-1", "tail-2"]);
  });

  it("resuming from a detach sends exactly one resnapshot, discards output until it lands, and never resends while it is in flight", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().setFollowing(false);
    h.emit().onOutput({
      lines: [line("missed-1")],
      start: position("seg-2", 80),
    });

    h.handle.store.getState().setFollowing(true);

    expect(h.resnapshotCalls()).toBe(1);
    expect(h.handle.store.getState().resyncPending).toBe(true);
    // Still `detached` until the fresh snapshot actually lands - a viewer
    // must keep showing "resyncing", not silently jump back to "live".
    expect(h.handle.store.getState().detached).toBe(true);

    // Jump-to-live pressed again mid-resync (or the latch flipping again from
    // scroll momentum): must not fire a second resnapshot.
    h.handle.store.getState().setFollowing(true);
    expect(h.resnapshotCalls()).toBe(1);

    // A page request while a resync is in flight would race the replacement
    // snapshot; it must be refused rather than queued against a start the
    // snapshot is about to invalidate.
    h.handle.store.getState().loadOlder();
    expect(h.sent).toHaveLength(0);

    // Output racing the resnapshot request is discarded, not appended ahead
    // of the replacement snapshot that is about to arrive.
    h.emit().onOutput({
      lines: [line("still-missed")],
      start: position("seg-2", 90),
    });
    expect(texts(h.handle)).toEqual(["tail-1", "tail-2"]);

    const lastSeqBeforeResync = h.handle.store.getState().lines.at(-1)?.seq;
    const generationBeforeResync = h.handle.store.getState().timelineGeneration;

    h.emit().onSnapshot({
      command: COMMAND,
      lines: [line("tail-3"), line("tail-4")],
      start: position("seg-3", 0),
      reachedStart: false,
    });

    const resynced = h.handle.store.getState();
    expect(texts(h.handle)).toEqual(["tail-3", "tail-4"]);
    expect(resynced.detached).toBe(false);
    expect(resynced.resyncPending).toBe(false);
    expect(resynced.newOutputAvailable).toBe(false);
    expect(resynced.timelineGeneration).toBe(generationBeforeResync + 1);
    // Row identities are never reset by a snapshot: the tile keys its
    // virtualized rows on `seq`, so a reused id here would misfire its
    // prepend-anchor correction as if the new tail had been scrolled to.
    expect(resynced.lines[0].seq).toBeGreaterThan(lastSeqBeforeResync ?? -1);

    // Following resumed, so ordinary live output appends again.
    h.emit().onOutput({
      lines: [line("live-after-resync")],
      start: position("seg-3", 40),
    });
    expect(texts(h.handle)).toEqual(["tail-3", "tail-4", "live-after-resync"]);
  });

  it("resnapshots after backward paging evicts a quiet command's live tail", () => {
    const h = harness();
    openAtTail(h);
    h.handle.store.getState().setFollowing(false);

    // Every response respects the wire's 500-line page size. No live output
    // arrives: tail eviction alone must still make the window require a fresh
    // snapshot, or Jump to live would land on stale history forever.
    for (let page = 0; page < 41; page += 1) {
      h.handle.store.getState().loadOlder();
      const request = loadOlderFrame(h.sent[page]);
      h.emit().onOlder({
        requestId: request.requestId,
        lines: Array.from({ length: 500 }, (_, index) =>
          line(`older-${page}-${index}`),
        ),
        start: position(`seg-history-${page}`, 0),
        reachedStart: false,
      });
    }

    const state = h.handle.store.getState();
    // The reader asked for older history, so that side is kept; the stale
    // pre-detach tail is what gets evicted to hold the cap.
    expect(state.lines.length).toBeLessThanOrEqual(
      MANAGED_COMMAND_OUTPUT_RETENTION_MAX_LINES,
    );
    expect(state.lines[0].text).toBe("older-40-0");
    expect(texts(h.handle)).not.toContain("tail-1");
    expect(state.detached).toBe(true);
    expect(state.newOutputAvailable).toBe(false);

    state.setFollowing(true);
    expect(h.resnapshotCalls()).toBe(1);
    expect(h.handle.store.getState().resyncPending).toBe(true);
  });
});
