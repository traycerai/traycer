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
  const handle = createManagedCommandOutputStore({
    epicId: "epic-1",
    commandId: "cmd-1",
    streamClientFactory: (_epicId, _commandId, callbacks) => {
      captured = callbacks;
      return {
        loadOlder: (frame) => {
          sent.push(frame);
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
    h.emit().onOutput([line("live-1"), line("live-2")]);

    expect(texts(h.handle)).toEqual(["tail-1", "tail-2", "live-1", "live-2"]);
    expect(h.handle.store.getState().command).toEqual(COMMAND);
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
});
