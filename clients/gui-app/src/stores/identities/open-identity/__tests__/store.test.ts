/**
 * `createOpenIdentityStore` driven through REAL lane adapters
 * (`createIdentityStateLaneAdapter` / `createIdentityFileLaneAdapter`, composed
 * inside `store.ts` itself) and fake stream clients this suite controls
 * directly - the same fake-stream-client shape
 * `identity-state-lane-adapter.test.ts` / `identity-file-lane-adapter.test.ts`
 * use, one container up. Every server frame is built by parsing a plain object
 * through the real wire schema, never hand-typed, so a fixture that drifts from
 * the contract fails at construction.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  agentIdentityStateSubscribeServerFrameSchemaV10,
  type AgentIdentityStateSubscribeServerFrameV10,
} from "@traycer/protocol/host/agent-identity/state-subscribe";
import {
  agentIdentityFileSubscribeServerFrameSchemaV10,
  type AgentIdentityFileSubscribeServerFrameV10,
} from "@traycer/protocol/host/agent-identity/file-subscribe";
import type {
  IdentityFileStreamClientFactory,
  IdentityFileStreamClientRequest,
  IdentityStateStreamClientFactory,
} from "@traycer-clients/shared/identity-lanes";
import type { IdentityStateStreamCallbacks } from "@traycer-clients/shared/host-transport/identity-state-stream-client";
import type { EpicLaneCursor } from "@traycer/protocol/host/epic/lane-cursor";
import { createRendererRuntimeEnvironment } from "@/stores/epics/open-epic/runtime/runtime-environment";
import { encodeDocStateVectorBase64 } from "@/stores/epics/open-epic/runtime/dirty-watermark";
import {
  createOpenIdentityStore,
  type OpenIdentityStoreHandle,
} from "@/stores/identities/open-identity/store";

const HOST_ID = "host-a";
const IDENTITY_ID = "identity-1";
const EPOCH = "epoch-1";

// ─── Frame builders (parsed through the real schema) ───────────────────────

interface IdentityFixture {
  readonly title: string;
  readonly description: string | null;
  readonly evolution: {
    readonly intervalTurns: number;
    readonly reviewHarnessId: null;
    readonly reviewModel: string | null;
    readonly reviewReasoningEffort: string | null;
  };
}

function identityFixture(title: string): IdentityFixture {
  return {
    title,
    description: null,
    evolution: {
      intervalTurns: 0,
      reviewHarnessId: null,
      reviewModel: null,
      reviewReasoningEffort: null,
    },
  };
}

function incarnationOf(path: string): string {
  return "inc:" + path;
}

interface DocumentRowFixture {
  readonly path: string;
  readonly incarnation: string;
  readonly shardRoomId: string;
  readonly fragmentName: string;
  readonly updatedAt: number;
  readonly provenance: "agent";
  readonly revision: number;
}

function documentRowFixture(
  path: string,
  fragmentName: string,
  revision: number,
): DocumentRowFixture {
  return {
    path,
    incarnation: incarnationOf(path),
    shardRoomId: "shard-a",
    fragmentName,
    updatedAt: 1000,
    provenance: "agent",
    revision,
  };
}

/** Like {@link documentRowFixture}, with the incarnation named explicitly. */
function documentRowAt(
  path: string,
  incarnation: string,
  fragmentName: string,
  revision: number,
): DocumentRowFixture {
  return {
    path,
    incarnation,
    shardRoomId: "shard-a",
    fragmentName,
    updatedAt: 1000,
    provenance: "agent",
    revision,
  };
}

interface SnapshotOverrides {
  readonly documents?: readonly DocumentRowFixture[];
}

function snapshotFrame(
  overrides: SnapshotOverrides,
): Extract<AgentIdentityStateSubscribeServerFrameV10, { kind: "snapshot" }> {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    authorityEpoch: EPOCH,
    position: 0,
    basis: "cold",
    reconciledWithCloud: false,
    identity: { revision: 1, identity: identityFixture("An Identity") },
    documents: overrides.documents ?? [],
    files: [],
    shards: [],
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "snapshot") throw new Error("fixture drift: snapshot");
  return parsed;
}

function docFrame(
  path: string,
  docGuid: string,
  stateVectorBase64: string,
): Extract<AgentIdentityFileSubscribeServerFrameV10, { kind: "doc" }> {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "doc",
    authorityEpoch: EPOCH,
    path,
    docGuid,
    stateVectorBase64,
    hasBinaryPayload: true,
  });
  if (parsed.kind !== "doc") throw new Error("fixture drift: doc");
  return parsed;
}

interface DeltaOverrides {
  readonly seq: number;
  readonly documentUpserts?: readonly DocumentRowFixture[];
  readonly removals?: readonly {
    readonly population: "document" | "file";
    readonly path: string;
    readonly incarnation: string;
    readonly revision: number;
  }[];
}

function deltaFrame(
  overrides: DeltaOverrides,
): Extract<AgentIdentityStateSubscribeServerFrameV10, { kind: "delta" }> {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "delta",
    authorityEpoch: EPOCH,
    seq: overrides.seq,
    documentUpserts: overrides.documentUpserts ?? [],
    fileUpserts: [],
    removals: overrides.removals ?? [],
    identity: null,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "delta") throw new Error("fixture drift: delta");
  return parsed;
}

function unavailableFrame(
  path: string,
  code: string,
  terminal: boolean,
): Extract<AgentIdentityFileSubscribeServerFrameV10, { kind: "unavailable" }> {
  const parsed = agentIdentityFileSubscribeServerFrameSchemaV10.parse({
    kind: "unavailable",
    authorityEpoch: EPOCH,
    path,
    code,
    reason: "host-side summary",
    terminal,
    hasBinaryPayload: false,
  });
  if (parsed.kind !== "unavailable") {
    throw new Error("fixture drift: unavailable");
  }
  return parsed;
}

// ─── Fake state-lane stream client factory ─────────────────────────────────

interface StateHandle {
  readonly callbacks: IdentityStateStreamCallbacks;
  readonly resumeProvider: () => EpicLaneCursor | null;
  closeCalls: number;
}

interface FakeStateFactory {
  readonly factory: IdentityStateStreamClientFactory;
  readonly latest: () => StateHandle;
  readonly callCount: () => number;
}

function createFakeStateFactory(): FakeStateFactory {
  const handles: StateHandle[] = [];
  const factory: IdentityStateStreamClientFactory = (
    _identityId,
    callbacks,
    resumeProvider,
  ) => {
    const handle: StateHandle = { callbacks, resumeProvider, closeCalls: 0 };
    handles.push(handle);
    return {
      close: () => {
        handle.closeCalls += 1;
      },
    };
  };
  return {
    factory,
    latest: () => {
      const handle = handles.at(-1);
      if (handle === undefined) throw new Error("state factory not invoked");
      return handle;
    },
    callCount: () => handles.length,
  };
}

// ─── Fake file-lane stream client factory ──────────────────────────────────

interface FileHandle {
  readonly path: string;
  readonly request: IdentityFileStreamClientRequest;
  closeCalls: number;
  readonly applyUpdateCalls: { docGuid: string; bytes: Uint8Array }[];
}

interface FakeFileFactory {
  readonly factory: IdentityFileStreamClientFactory;
  readonly forPath: (path: string) => FileHandle;
  readonly openCountFor: (path: string) => number;
  readonly totalOpens: () => number;
}

function createFakeFileFactory(): FakeFileFactory {
  const handlesByPath = new Map<string, FileHandle[]>();
  const factory: IdentityFileStreamClientFactory = (request) => {
    const handle: FileHandle = {
      path: request.path,
      request,
      closeCalls: 0,
      applyUpdateCalls: [],
    };
    const existing = handlesByPath.get(request.path) ?? [];
    existing.push(handle);
    handlesByPath.set(request.path, existing);
    return {
      applyUpdate: (docGuid, bytes) => {
        handle.applyUpdateCalls.push({ docGuid, bytes });
      },
      awareness: () => undefined,
      close: () => {
        handle.closeCalls += 1;
      },
    };
  };
  return {
    factory,
    forPath: (path) => {
      const list = handlesByPath.get(path);
      const handle = list?.at(-1);
      if (handle === undefined) {
        throw new Error("file factory not invoked for " + path);
      }
      return handle;
    },
    openCountFor: (path) => handlesByPath.get(path)?.length ?? 0,
    totalOpens: () =>
      Array.from(handlesByPath.values()).reduce(
        (sum, list) => sum + list.length,
        0,
      ),
  };
}

// ─── Rig ─────────────────────────────────────────────────────────────────

interface Rig {
  readonly handle: OpenIdentityStoreHandle;
  readonly state: FakeStateFactory;
  readonly file: FakeFileFactory;
}

function createRig(): Rig {
  const state = createFakeStateFactory();
  const file = createFakeFileFactory();
  const handle = createOpenIdentityStore({
    hostId: HOST_ID,
    identityId: IDENTITY_ID,
    environment: createRendererRuntimeEnvironment(),
    stateStreamClientFactory: state.factory,
    fileStreamClientFactory: file.factory,
    getCurrentUserId: () => "user-1",
    memory: null,
  });
  return { handle, state, file };
}

describe("createOpenIdentityStore", () => {
  const opened: OpenIdentityStoreHandle[] = [];

  afterEach(() => {
    for (const handle of opened.splice(0)) handle.dispose();
  });

  function rigUnderTest(): Rig {
    const rig = createRig();
    opened.push(rig.handle);
    return rig;
  }

  it("hydrates documents/files by path and flips hydrated on the first snapshot", () => {
    const rig = rigUnderTest();
    expect(rig.handle.store.getState().hydrated).toBe(false);

    rig.state.latest().callbacks.onSnapshot(
      snapshotFrame({
        documents: [documentRowFixture("SOUL.md", "doc", 1)],
      }),
    );

    const state = rig.handle.store.getState();
    expect(state.hydrated).toBe(true);
    expect(state.documents.allPaths).toEqual(["SOUL.md"]);
    expect(state.documents.byPath["SOUL.md"]).toMatchObject({
      path: "SOUL.md",
      fragmentName: "doc",
    });
    expect(state.identity).toMatchObject({ title: "An Identity" });
  });

  it("acquireFileBodyLease opens exactly one file stream client per leased path", () => {
    const rig = rigUnderTest();
    rig.state.latest().callbacks.onSnapshot(
      snapshotFrame({
        documents: [
          documentRowFixture("SOUL.md", "doc", 1),
          documentRowFixture("MEMORY.md", "doc", 1),
        ],
      }),
    );

    const releaseFirst = rig.handle.acquireFileBodyLease("SOUL.md");
    expect(rig.file.openCountFor("SOUL.md")).toBe(1);

    // A second lease on the SAME path must not open a second client.
    const releaseSecond = rig.handle.acquireFileBodyLease("SOUL.md");
    expect(rig.file.openCountFor("SOUL.md")).toBe(1);

    // A lease on a DIFFERENT path opens its own client.
    const releaseThird = rig.handle.acquireFileBodyLease("MEMORY.md");
    expect(rig.file.openCountFor("MEMORY.md")).toBe(1);
    expect(rig.file.totalOpens()).toBe(2);

    releaseFirst();
    releaseSecond();
    releaseThird();
  });

  it("releasing the last lease on a path closes and forgets that file client", () => {
    const rig = rigUnderTest();
    rig.state
      .latest()
      .callbacks.onSnapshot(
        snapshotFrame({ documents: [documentRowFixture("SOUL.md", "doc", 1)] }),
      );

    const releaseFirst = rig.handle.acquireFileBodyLease("SOUL.md");
    const releaseSecond = rig.handle.acquireFileBodyLease("SOUL.md");
    expect(rig.handle.attachedBodyPaths()).toContain("SOUL.md");

    // Releasing one of two holders must not close the lane yet.
    releaseFirst();
    expect(rig.handle.attachedBodyPaths()).toContain("SOUL.md");
    expect(rig.file.forPath("SOUL.md").closeCalls).toBe(0);

    // The LAST release closes the lane and drops the path from the attached set.
    releaseSecond();
    expect(rig.handle.attachedBodyPaths()).not.toContain("SOUL.md");
    expect(rig.file.forPath("SOUL.md").closeCalls).toBe(1);
  });

  it("a doc snapshot frame makes the fragment available and flips availability to ready", () => {
    const rig = rigUnderTest();
    rig.state
      .latest()
      .callbacks.onSnapshot(
        snapshotFrame({ documents: [documentRowFixture("SOUL.md", "doc", 1)] }),
      );

    const release = rig.handle.acquireFileBodyLease("SOUL.md");
    expect(rig.handle.getFileBodyAvailability("SOUL.md").kind).toBe(
      "awaiting-seed",
    );
    expect(rig.handle.getFileFragment("SOUL.md")).toBeNull();

    const donor = new Y.Doc();
    donor.getXmlFragment("doc").insert(0, [new Y.XmlText("hello")]);
    const frame = docFrame(
      "SOUL.md",
      "guid-1",
      encodeDocStateVectorBase64(new Y.Doc()),
    );
    rig.file
      .forPath("SOUL.md")
      .request.callbacks.onDoc(frame, Y.encodeStateAsUpdate(donor));

    expect(rig.handle.getFileBodyAvailability("SOUL.md")).toEqual({
      kind: "ready",
    });
    const fragment = rig.handle.getFileFragment("SOUL.md");
    expect(fragment).not.toBeNull();
    expect(fragment?.toJSON()).toContain("hello");

    release();
  });

  it("an edit made while disconnected flushes on reconnect after the file's last view was released", () => {
    const rig = rigUnderTest();
    rig.state.latest().callbacks.onSnapshot(
      snapshotFrame({
        documents: [
          documentRowFixture("SOUL.md", "doc", 1),
          documentRowFixture("MEMORY.md", "doc", 1),
        ],
      }),
    );
    rig.state.latest().callbacks.onConnectionStatus("open", null);
    expect(rig.handle.store.getState().connection).toBe("open");

    const release = rig.handle.acquireFileBodyLease("SOUL.md");
    const fileHandle = rig.file.forPath("SOUL.md");
    fileHandle.request.callbacks.onDoc(
      docFrame("SOUL.md", "guid-a", encodeDocStateVectorBase64(new Y.Doc())),
      Y.encodeStateAsUpdate(new Y.Doc()),
    );

    // The connection drops - writes must retain locally rather than send.
    rig.state.latest().callbacks.onConnectionStatus("closed", null);
    expect(rig.handle.store.getState().connection).not.toBe("open");

    const doc = rig.handle.getFileDoc("SOUL.md");
    if (doc === null) throw new Error("expected a seeded doc");
    doc.transact(() => {
      doc.getXmlFragment("doc").insert(0, [new Y.XmlText("offline")]);
    });
    expect(rig.handle.store.getState().dirtyPaths).toContain("SOUL.md");

    // The editor's last view goes away, but the lane is kept open: the
    // tier still retains bytes no lane has carried yet.
    release();
    expect(rig.handle.attachedBodyPaths()).toContain("SOUL.md");
    expect(fileHandle.applyUpdateCalls).toHaveLength(0);

    // Reconnect: the store flushes the retained edit over the SAME lane
    // (never closed while pending bytes existed), then releases it once
    // the flush leaves nothing behind to protect.
    rig.state.latest().callbacks.onConnectionStatus("open", null);

    expect(fileHandle.applyUpdateCalls.length).toBeGreaterThan(0);
    const merged = new Y.Doc();
    for (const call of fileHandle.applyUpdateCalls) {
      Y.applyUpdate(merged, call.bytes);
    }
    expect(merged.getXmlFragment("doc").toJSON()).toContain("offline");

    expect(rig.handle.attachedBodyPaths()).not.toContain("SOUL.md");
    expect(rig.handle.store.getState().dirtyPaths).not.toContain("SOUL.md");
  });

  it("a new incarnation at a refused path reopens its body lane", () => {
    const rig = rigUnderTest();
    rig.state.latest().callbacks.onSnapshot(
      snapshotFrame({
        documents: [documentRowAt("SOUL.md", "inc-1", "doc", 1)],
      }),
    );

    const release = rig.handle.acquireFileBodyLease("SOUL.md");
    expect(rig.file.openCountFor("SOUL.md")).toBe(1);

    rig.file
      .forPath("SOUL.md")
      .request.callbacks.onUnavailable(
        unavailableFrame("SOUL.md", "fileNotFound", true),
      );

    expect(rig.handle.getFileBodyAvailability("SOUL.md")).toEqual({
      kind: "unavailable",
      code: "file-not-found",
      reason: "host-side summary",
    });
    expect(rig.file.openCountFor("SOUL.md")).toBe(1);

    rig.state.latest().callbacks.onDelta(
      deltaFrame({
        seq: 1,
        documentUpserts: [documentRowAt("SOUL.md", "inc-2", "doc", 2)],
        removals: [
          {
            population: "document",
            path: "SOUL.md",
            incarnation: "inc-1",
            revision: 2,
          },
        ],
      }),
    );

    expect(rig.file.openCountFor("SOUL.md")).toBe(2);

    const donor = new Y.Doc();
    donor.getXmlFragment("doc").insert(0, [new Y.XmlText("fresh")]);
    rig.file
      .forPath("SOUL.md")
      .request.callbacks.onDoc(
        docFrame("SOUL.md", "guid-2", encodeDocStateVectorBase64(new Y.Doc())),
        Y.encodeStateAsUpdate(donor),
      );

    expect(rig.handle.getFileBodyAvailability("SOUL.md")).toEqual({
      kind: "ready",
    });
    expect(rig.handle.getFileFragment("SOUL.md")).not.toBeNull();

    release();
  });
});
