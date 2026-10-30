import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/index";
import type { TerminalSubscribeViewer } from "@traycer/protocol/host/terminal/subscribe";
import type { StreamFrameEnvelope } from "@traycer-clients/shared/host-transport/i-stream-session";
import {
  FakeStreamClient,
  type FakeStreamSession,
} from "@traycer-clients/shared/host-transport/__testing__/fake-stream-client";
import { TerminalStreamClient } from "@traycer-clients/shared/host-transport/terminal-stream-client";
import {
  createTerminalSessionStore,
  type TerminalSessionStoreHandle,
  type TerminalWrite,
} from "@/stores/terminals/terminal-session-store";
import { TerminalSessionRegistry } from "@/stores/terminals/terminal-session-registry";

/**
 * The lease path end to end: the real registry parks and revives a real store,
 * whose stream client is the production `TerminalStreamClient` over a fake host
 * stream. Every assertion reads what reached the (fake) wire: subscribes,
 * closes, `viewer`, `ack` and `resize` frames.
 */

const HOST_ID = "host-1";
const INSTANCE_ID = "terminal-1";
const SESSION_ID = "terminal-1";

const V17: SchemaVersion = { major: 1, minor: 7 };
const V16: SchemaVersion = { major: 1, minor: 6 };

/** A host whose every `terminal.subscribe` session negotiates the same line. */
class VersionedFakeStreamClient extends FakeStreamClient {
  constructor(private readonly negotiated: SchemaVersion | null) {
    super(false);
  }

  override subscribe(method: string, params: unknown): FakeStreamSession {
    const session = super.subscribe(method, params);
    session.negotiatedSchemaVersion = this.negotiated;
    return session;
  }
}

const canonicalSession = {
  sessionId: SESSION_ID,
  scope: { kind: "independent" as const },
  sessionKind: "terminal" as const,
  cwd: "/workspace/project",
  currentCwd: "/workspace/project",
  shellCommand: "zsh",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running" as const,
  exitCode: null,
  exitReason: null,
  createdAt: 1,
  title: null,
  activeProcessName: null,
};

// A host with no negotiated version is parsed at the frozen base line, whose
// session info still names an epic.
const legacySession = {
  sessionId: SESSION_ID,
  epicId: "epic-1",
  sessionKind: "terminal" as const,
  cwd: "/workspace/project",
  shellCommand: "zsh",
  shellArgs: [],
  cols: 80,
  rows: 24,
  status: "running" as const,
  exitCode: null,
  exitReason: null,
  createdAt: 1,
  title: null,
  activeProcessName: null,
};

function viewerFrame(viewer: TerminalSubscribeViewer): StreamFrameEnvelope {
  return {
    kind: "viewer",
    hasBinaryPayload: false,
    sessionId: SESSION_ID,
    viewer,
  };
}

interface Rig {
  readonly fake: VersionedFakeStreamClient;
  readonly registry: TerminalSessionRegistry;
  readonly handle: TerminalSessionStoreHandle;
  readonly writes: TerminalWrite[];
  /** The newest host session this rig's stream client opened. */
  readonly session: () => FakeStreamSession;
  /** The viewer each wire subscribe declared, in order. */
  readonly declaredViewers: () => TerminalSubscribeViewer[];
  readonly acquire: (viewer: TerminalSubscribeViewer) => void;
  readonly release: () => void;
  /** Opens the stream, delivers an ack-credit snapshot, then one data chunk. */
  readonly openWithData: (chunk: string) => void;
  readonly liveWrite: () => TerminalWrite;
}

function createRig(negotiated: SchemaVersion | null): Rig {
  const fake = new VersionedFakeStreamClient(negotiated);
  const registry = new TerminalSessionRegistry();
  const writes: TerminalWrite[] = [];
  const handle = createTerminalSessionStore({
    scope: { kind: "epic", epicId: "epic-1" },
    sessionId: SESSION_ID,
    cols: 80,
    rows: 24,
    reattachMode: "fresh",
    kind: "terminal",
    viewer: "presentation",
    // The exact shape the production factory returns around the real client.
    streamClientFactory: (streamArgs) => {
      const client = new TerminalStreamClient({
        wsStreamClient: fake,
        sessionId: streamArgs.sessionId,
        cols: streamArgs.cols,
        rows: streamArgs.rows,
        viewer: streamArgs.viewer,
        callbacks: streamArgs.callbacks,
      });
      return {
        sendAction: (frame) => client.sendAction(frame),
        close: () => client.close(),
        supportsViewerFrames: () => client.supportsViewerFrames(),
      };
    },
  });
  const session = (): FakeStreamSession => {
    const newest = fake.sessions.at(-1);
    if (newest === undefined) throw new Error("no host session was opened");
    return newest;
  };
  return {
    fake,
    registry,
    handle,
    writes,
    session,
    declaredViewers: () =>
      fake.subscribes.map((subscribe) => {
        const params = subscribe.params;
        if (
          typeof params !== "object" ||
          params === null ||
          !("viewer" in params) ||
          (params.viewer !== "presentation" && params.viewer !== "cache")
        ) {
          throw new Error("subscribe did not declare a viewer");
        }
        return params.viewer;
      }),
    acquire: (viewer) => {
      registry.acquire(INSTANCE_ID, () => handle, HOST_ID, viewer);
    },
    release: () => {
      registry.release(INSTANCE_ID, handle, true);
    },
    openWithData: (chunk) => {
      handle.store.getState().setWriter((write) => {
        writes.push(write);
      });
      session().emitStatus("open");
      session().emit(
        {
          kind: "snapshot",
          hasBinaryPayload: false,
          sessionId: SESSION_ID,
          session: negotiated === null ? legacySession : canonicalSession,
          scrollback: "",
          ackCreditSupported: true,
        },
        null,
      );
      session().emit(
        {
          kind: "data",
          hasBinaryPayload: false,
          sessionId: SESSION_ID,
          chunk,
        },
        null,
      );
    },
    liveWrite: () => {
      const live = writes.find((write) => write.kind === "live");
      if (live === undefined) throw new Error("no live write was delivered");
      return live;
    },
  };
}

function ackBytes(session: FakeStreamSession): number[] {
  return session.framesOfKind("ack").map((frame) => {
    const bytes = frame.bytes;
    if (typeof bytes !== "number") throw new Error("ack frame without bytes");
    return bytes;
  });
}

describe("terminal viewer intent through the registry lease, over the real stream client", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("a host that negotiated terminal.subscribe@1.7", () => {
    it("parks and revives a HELD lease with viewer frames on the original subscriber, and its parse debt drains there", () => {
      const rig = createRig(V17);
      rig.acquire("presentation");
      rig.openWithData("parsed during hold");
      const original = rig.session();

      original.emitContinuityStatus("reconnecting", "held");
      // xterm finishes parsing while the stream is held and the lease parked.
      rig.liveWrite().onAckable();
      rig.release();
      expect(original.framesOfKind("viewer")).toEqual([]);

      original.emitContinuityStatus("open", "continued");
      rig.acquire("presentation");
      vi.advanceTimersByTime(1000);

      expect(rig.fake.subscribes).toHaveLength(1);
      expect(original.closed).toBe(false);
      expect(original.framesOfKind("viewer")).toEqual([
        viewerFrame("cache"),
        viewerFrame("presentation"),
      ]);
      expect(ackBytes(original)).toEqual(["parsed during hold".length]);
      rig.registry.forceRelease(INSTANCE_ID);
    });

    it("parks and revives a LIVE lease on the same subscriber, carrying the ack debt across and acking after the parse completes", () => {
      const rig = createRig(V17);
      rig.acquire("presentation");
      rig.openWithData("partial");
      const original = rig.session();

      rig.release();
      expect(original.framesOfKind("viewer")).toEqual([viewerFrame("cache")]);
      rig.acquire("presentation");
      expect(original.framesOfKind("viewer")).toEqual([
        viewerFrame("cache"),
        viewerFrame("presentation"),
      ]);

      // The write was handed to xterm before the park; it completes after the
      // revive, and its credit still belongs to this subscriber.
      rig.liveWrite().onAckable();
      vi.advanceTimersByTime(1000);

      expect(rig.fake.subscribes).toHaveLength(1);
      expect(original.closed).toBe(false);
      expect(ackBytes(original)).toEqual(["partial".length]);
      // No synthetic snapshot reached the store: the one initial snapshot is
      // the only snapshot write the writer ever saw.
      expect(
        rig.writes.filter((write) => write.kind === "snapshot"),
      ).toHaveLength(1);
      rig.registry.forceRelease(INSTANCE_ID);
    });

    it("sends the earned ack and the latest resize before the viewer frame that brings the tile back to presentation", () => {
      const rig = createRig(V17);
      rig.acquire("presentation");
      rig.openWithData("owed bytes");
      const original = rig.session();

      rig.release();
      rig.liveWrite().onAckable();
      rig.handle.store.getState().requestResize(120, 40);
      rig.acquire("presentation");

      const kinds = original.sentFrames
        .map((frame) => frame.kind)
        .filter(
          (kind) => kind === "ack" || kind === "resize" || kind === "viewer",
        );
      const presentationAt = original.sentFrames.findLastIndex(
        (frame) => frame.kind === "viewer",
      );
      const lastAckAt = original.sentFrames.findLastIndex(
        (frame) => frame.kind === "ack",
      );
      const lastResizeAt = original.sentFrames.findLastIndex(
        (frame) => frame.kind === "resize",
      );
      expect(kinds).toContain("ack");
      expect(kinds).toContain("resize");
      expect(lastAckAt).toBeLessThan(presentationAt);
      expect(lastResizeAt).toBeLessThan(presentationAt);
      rig.registry.forceRelease(INSTANCE_ID);
    });
  });

  // Hosts below @1.7 cannot parse a `viewer` frame: intent changes keep
  // reopening the stream. Green on the base and after, by design.
  describe.each([
    { label: "terminal.subscribe@1.6", negotiated: V16 },
    { label: "an unknown negotiated version", negotiated: null },
  ])("a host on $label", ({ negotiated }) => {
    it("keeps replacing the subscriber for a HELD park and revive, once per settled intent, with no viewer frame", () => {
      const rig = createRig(negotiated);
      rig.acquire("presentation");
      rig.openWithData("chunk");
      const first = rig.session();

      first.emitContinuityStatus("reconnecting", "held");
      rig.release();
      expect(rig.fake.subscribes).toHaveLength(1);
      first.emitContinuityStatus("open", "continued");
      rig.acquire("presentation");

      expect(rig.declaredViewers()).toEqual([
        "presentation",
        "cache",
        "presentation",
      ]);
      expect(rig.fake.sessions.map((session) => session.closed)).toEqual([
        true,
        true,
        false,
      ]);
      for (const session of rig.fake.sessions) {
        expect(session.framesOfKind("viewer")).toEqual([]);
      }
      rig.registry.forceRelease(INSTANCE_ID);
    });

    it("keeps replacing the subscriber for a LIVE park and revive, with no viewer frame", () => {
      const rig = createRig(negotiated);
      rig.acquire("presentation");
      rig.openWithData("chunk");

      rig.release();
      rig.acquire("presentation");

      expect(rig.declaredViewers()).toEqual([
        "presentation",
        "cache",
        "presentation",
      ]);
      expect(rig.fake.sessions.map((session) => session.closed)).toEqual([
        true,
        true,
        false,
      ]);
      for (const session of rig.fake.sessions) {
        expect(session.framesOfKind("viewer")).toEqual([]);
      }
      rig.registry.forceRelease(INSTANCE_ID);
    });
  });
});
