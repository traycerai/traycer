import { describe, expect, it } from "vitest";
import type { SchemaVersion } from "@traycer/protocol/framework/versioned-stream-rpc";
import type { WorktreeChangedScope } from "@traycer/protocol/host/worktree-changed-stream";
import {
  FakeStreamClient,
  FakeStreamSession,
} from "../__testing__/fake-stream-client";
import {
  WorktreeChangedStreamClient,
  type WorktreeChangedCursorStore,
} from "../worktree-changed-stream-client";

/**
 * Keeps the params provider so a test can play the transport's reconnect: the
 * real clients re-invoke it before every wire subscribe, and that re-read is
 * the whole point of a resume cursor.
 */
class ReconnectingStreamClient extends FakeStreamClient {
  provider: ((onWireVersion: SchemaVersion | null) => unknown) | null = null;
  session: FakeStreamSession | null = null;

  constructor(readonly negotiatedVersion: SchemaVersion | null) {
    super(true);
  }

  override subscribeWithParamsProvider(
    method: string,
    paramsProvider: (onWireVersion: SchemaVersion | null) => unknown,
  ): FakeStreamSession {
    this.provider = paramsProvider;
    const session = super.subscribeWithParamsProvider(method, paramsProvider);
    if (this.negotiatedVersion !== null) {
      session.negotiatedSchemaVersion = this.negotiatedVersion;
    }
    this.session = session;
    return session;
  }

  /** The params the next wire subscribe would carry at `version`. */
  paramsAt(version: SchemaVersion | null): unknown {
    if (this.provider === null) throw new Error("nothing subscribed");
    return this.provider(version);
  }
}

const V10: SchemaVersion = { major: 1, minor: 0 };
const V11: SchemaVersion = { major: 1, minor: 1 };

function openWithAcceptance(
  cursor: WorktreeChangedCursorStore,
  accept: boolean,
  negotiatedVersion: SchemaVersion | null,
): {
  readonly transport: ReconnectingStreamClient;
  readonly changed: WorktreeChangedScope[];
  readonly client: WorktreeChangedStreamClient;
  readonly statusVersions: Array<SchemaVersion | null>;
} {
  const transport = new ReconnectingStreamClient(negotiatedVersion);
  const changed: WorktreeChangedScope[] = [];
  const statusVersions: Array<SchemaVersion | null> = [];
  const client = new WorktreeChangedStreamClient({
    wsStreamClient: transport,
    cursor,
    callbacks: {
      onChanged: (scope) => {
        changed.push(scope);
        return accept;
      },
      onConnectionStatus: (_status, _reason, version) => {
        statusVersions.push(version);
      },
    },
  });
  return { transport, changed, client, statusVersions };
}

function open(cursor: WorktreeChangedCursorStore): {
  readonly transport: ReconnectingStreamClient;
  readonly changed: WorktreeChangedScope[];
  readonly client: WorktreeChangedStreamClient;
} {
  return openWithAcceptance(cursor, true, null);
}

function session(transport: ReconnectingStreamClient): FakeStreamSession {
  if (transport.session === null) throw new Error("no session");
  return transport.session;
}

describe("WorktreeChangedStreamClient resume cursor", () => {
  it("offers no cursor before it has received a frame", () => {
    const { transport } = open({ current: null });
    expect(transport.paramsAt(V11)).toEqual({});
  });

  it("forwards the session's negotiated wire version on connection status", () => {
    const { statusVersions } = openWithAcceptance({ current: null }, true, V10);
    expect(statusVersions).toContainEqual(V10);
  });

  it("offers the last frame's cursor on the next subscribe", () => {
    const store: WorktreeChangedCursorStore = { current: null };
    const { transport, changed } = open(store);
    session(transport).emit(
      {
        kind: "changed",
        scope: { kind: "root", root: "worktrees" },
        cursor: { epoch: "e1", generation: 4 },
        hasBinaryPayload: false,
      },
      null,
    );
    session(transport).emit(
      {
        kind: "changed",
        scope: { kind: "worktreePath", worktreePath: "/wt/a" },
        cursor: { epoch: "e1", generation: 5 },
        hasBinaryPayload: false,
      },
      null,
    );

    expect(changed).toEqual([
      { kind: "root", root: "worktrees" },
      { kind: "worktreePath", worktreePath: "/wt/a" },
    ]);
    expect(transport.paramsAt(V11)).toEqual({
      resume: { epoch: "e1", generation: 5 },
    });
    // The newest line when the version is not known yet.
    expect(transport.paramsAt(null)).toEqual({
      resume: { epoch: "e1", generation: 5 },
    });
    expect(store.current).toEqual({ epoch: "e1", generation: 5 });
  });

  it("does not advance the cursor when the consumer rejects a frame", () => {
    const store: WorktreeChangedCursorStore = {
      current: { epoch: "e1", generation: 4 },
    };
    const { transport } = openWithAcceptance(store, false, null);
    session(transport).emit(
      {
        kind: "changed",
        scope: { kind: "root", root: "worktrees" },
        cursor: { epoch: "e1", generation: 5 },
        hasBinaryPayload: false,
      },
      null,
    );
    expect(store.current).toEqual({ epoch: "e1", generation: 4 });
    expect(transport.paramsAt(V11)).toEqual({
      resume: { epoch: "e1", generation: 4 },
    });
  });

  it("ignores buffered frames after close without advancing the cursor", () => {
    const store: WorktreeChangedCursorStore = {
      current: { epoch: "e1", generation: 4 },
    };
    const { transport, client } = open(store);
    const activeSession = session(transport);
    client.close();
    activeSession.emit(
      {
        kind: "changed",
        scope: { kind: "root", root: "worktrees" },
        cursor: { epoch: "e1", generation: 5 },
        hasBinaryPayload: false,
      },
      null,
    );
    expect(store.current).toEqual({ epoch: "e1", generation: 4 });
  });

  it("offers nothing to a @1.0 host, which cannot read it", () => {
    const { transport } = open({ current: { epoch: "e1", generation: 5 } });
    expect(transport.paramsAt(V10)).toEqual({});
  });

  it("still delivers a @1.0 host's frames, which carry no cursor, and keeps the cursor it had", () => {
    const store: WorktreeChangedCursorStore = {
      current: { epoch: "e1", generation: 5 },
    };
    const { transport, changed } = open(store);
    session(transport).emit(
      {
        kind: "changed",
        scope: { kind: "root", root: "worktrees" },
        hasBinaryPayload: false,
      },
      null,
    );
    expect(changed).toEqual([{ kind: "root", root: "worktrees" }]);
    expect(store.current).toEqual({ epoch: "e1", generation: 5 });
  });

  it("a rebuilt client sharing the store offers the cursor the old one received", () => {
    const store: WorktreeChangedCursorStore = { current: null };
    const first = open(store);
    session(first.transport).emit(
      {
        kind: "changed",
        scope: { kind: "root", root: "worktrees" },
        cursor: { epoch: "e2", generation: 1 },
        hasBinaryPayload: false,
      },
      null,
    );
    const second = open(store);
    expect(second.transport.paramsAt(V11)).toEqual({
      resume: { epoch: "e2", generation: 1 },
    });
  });
});
