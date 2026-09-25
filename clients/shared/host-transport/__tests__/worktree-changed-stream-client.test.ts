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

  constructor() {
    super(true);
  }

  override subscribeWithParamsProvider(
    method: string,
    paramsProvider: (onWireVersion: SchemaVersion | null) => unknown,
  ): FakeStreamSession {
    this.provider = paramsProvider;
    const session = super.subscribeWithParamsProvider(method, paramsProvider);
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

function open(cursor: WorktreeChangedCursorStore): {
  readonly transport: ReconnectingStreamClient;
  readonly changed: WorktreeChangedScope[];
  readonly client: WorktreeChangedStreamClient;
} {
  const transport = new ReconnectingStreamClient();
  const changed: WorktreeChangedScope[] = [];
  const client = new WorktreeChangedStreamClient({
    wsStreamClient: transport,
    cursor,
    callbacks: {
      onChanged: (scope) => {
        changed.push(scope);
      },
      onConnectionStatus: () => {},
    },
  });
  return { transport, changed, client };
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
