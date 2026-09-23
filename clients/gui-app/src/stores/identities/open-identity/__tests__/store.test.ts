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
    const handle: FileHandle = { path: request.path, request, closeCalls: 0 };
    const existing = handlesByPath.get(request.path) ?? [];
    existing.push(handle);
    handlesByPath.set(request.path, existing);
    return {
      applyUpdate: () => undefined,
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
});
