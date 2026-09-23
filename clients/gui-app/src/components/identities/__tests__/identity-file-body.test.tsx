/**
 * `IdentityFileBody`: a document file mounts the collab editor over a REAL
 * open-identity store (fake stream clients, real lane adapters - the same rig
 * `store.test.ts` uses), a blob file previews an image through a faked
 * `useIdentityBlobQueryForClient`, and a pending blob renders the pending
 * notice.
 */
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { OpenIdentityContext } from "@/providers/open-identity-context";
import { TabHostProvider } from "@/components/epic-canvas/tab-host-provider";
import { IdentityFileBody } from "@/components/identities/identity-file-body";
import type { IdentityTreeFile } from "@/lib/identities/file-tree";
import type { IdentityBlobSource } from "@/lib/identities/blob-source";

const HOST_ID = "host-a";
const IDENTITY_ID = "identity-1";
const EPOCH = "epoch-1";

// ─── Blob query fake (mutable across tests via vi.hoisted) ────────────────

const blobMocks = vi.hoisted(() => ({
  data: null as IdentityBlobSource | null,
  isFetching: false,
  isError: false,
  refetch: vi.fn(),
}));

vi.mock("@/hooks/identities/use-identity-blob-query", () => ({
  useIdentityBlobQueryForClient: () => ({
    data: blobMocks.data,
    isFetching: blobMocks.isFetching,
    isError: blobMocks.isError,
    refetch: blobMocks.refetch,
  }),
}));

// The blob body resolves its client through the full host-runtime hook chain
// (`useHostClient` / `useHostBinding`), which needs a `HostRuntimeProvider`
// this suite does not mount - faked the same way `identity-file-tree.test.tsx`
// fakes it, since the blob query itself is already faked above and never
// touches the client it is handed.
vi.mock("@/hooks/host/use-tab-host-client", () => ({
  useTabHostClient: () => null,
}));

// ─── Rig: same shape as store.test.ts's real-adapter / fake-stream rig ────

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

function snapshotFrame(
  documents: readonly {
    readonly path: string;
    readonly incarnation: string;
    readonly shardRoomId: string;
    readonly fragmentName: string;
    readonly updatedAt: number;
    readonly provenance: "agent";
    readonly revision: number;
  }[],
): Extract<AgentIdentityStateSubscribeServerFrameV10, { kind: "snapshot" }> {
  const parsed = agentIdentityStateSubscribeServerFrameSchemaV10.parse({
    kind: "snapshot",
    authorityEpoch: EPOCH,
    position: 0,
    basis: "cold",
    reconciledWithCloud: false,
    identity: { revision: 1, identity: identityFixture("An Identity") },
    documents,
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

interface StateHandle {
  readonly callbacks: IdentityStateStreamCallbacks;
  readonly resumeProvider: () => EpicLaneCursor | null;
}

interface FakeStateFactory {
  readonly factory: IdentityStateStreamClientFactory;
  readonly latest: () => StateHandle;
}

function createFakeStateFactory(): FakeStateFactory {
  const handles: StateHandle[] = [];
  const factory: IdentityStateStreamClientFactory = (
    _identityId,
    callbacks,
    resumeProvider,
  ) => {
    handles.push({ callbacks, resumeProvider });
    return { close: () => undefined };
  };
  return {
    factory,
    latest: () => {
      const handle = handles.at(-1);
      if (handle === undefined) throw new Error("state factory not invoked");
      return handle;
    },
  };
}

interface FileHandle {
  readonly request: IdentityFileStreamClientRequest;
}

interface FakeFileFactory {
  readonly factory: IdentityFileStreamClientFactory;
  readonly forPath: (path: string) => FileHandle;
}

function createFakeFileFactory(): FakeFileFactory {
  const handlesByPath = new Map<string, FileHandle>();
  const factory: IdentityFileStreamClientFactory = (request) => {
    handlesByPath.set(request.path, { request });
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      close: () => undefined,
    };
  };
  return {
    factory,
    forPath: (path) => {
      const handle = handlesByPath.get(path);
      if (handle === undefined) throw new Error(`no file client for ${path}`);
      return handle;
    },
  };
}

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

const DOCUMENT_FILE: IdentityTreeFile = {
  path: "SOUL.md",
  name: "SOUL.md",
  group: "soul",
  kind: "document",
  mediaType: "text/markdown",
  byteLength: null,
  status: null,
  pending: false,
  executable: false,
};

const PNG_FILE: IdentityTreeFile = {
  path: "logo.png",
  name: "logo.png",
  group: "soul",
  kind: "blob",
  mediaType: "image/png",
  byteLength: 3,
  status: "available",
  pending: false,
  executable: false,
};

const opened: OpenIdentityStoreHandle[] = [];

afterEach(() => {
  cleanup();
  for (const handle of opened.splice(0)) handle.dispose();
  blobMocks.data = null;
  blobMocks.isFetching = false;
  blobMocks.isError = false;
  blobMocks.refetch.mockClear();
});

describe("IdentityFileBody - document", () => {
  it("mounts the collab editor once a doc snapshot lands", async () => {
    const rig = createRig();
    opened.push(rig.handle);

    rig.state.latest().callbacks.onSnapshot(
      snapshotFrame([
        {
          path: "SOUL.md",
          incarnation: "inc:SOUL.md",
          shardRoomId: "shard-a",
          fragmentName: "doc",
          updatedAt: 1000,
          provenance: "agent",
          revision: 1,
        },
      ]),
    );

    const { container } = render(
      <TabHostProvider hostId={HOST_ID}>
        <OpenIdentityContext.Provider
          value={{ kind: "ready", handle: rig.handle }}
        >
          <IdentityFileBody
            identityId={IDENTITY_ID}
            hostId={HOST_ID}
            file={DOCUMENT_FILE}
            hydrated
          />
        </OpenIdentityContext.Provider>
      </TabHostProvider>,
    );

    // The lease is acquired in a layout effect on mount, so the file client
    // exists by the time render() returns.
    const donor = new Y.Doc();
    const paragraph = new Y.XmlElement("paragraph");
    paragraph.insert(0, [new Y.XmlText("hello world")]);
    donor.getXmlFragment("doc").insert(0, [paragraph]);
    const frame = docFrame(
      "SOUL.md",
      "guid-1",
      encodeDocStateVectorBase64(new Y.Doc()),
    );
    act(() => {
      rig.file
        .forPath("SOUL.md")
        .request.callbacks.onDoc(frame, Y.encodeStateAsUpdate(donor));
    });

    expect(screen.getByTestId("identity-document-editor")).not.toBeNull();
    await waitFor(() => {
      const prosemirror = container.querySelector(
        ".tc-editor-body .ProseMirror",
      );
      expect(prosemirror).not.toBeNull();
    });
  });
});

describe("IdentityFileBody - blob", () => {
  it("renders an image preview for a PNG blob", () => {
    blobMocks.data = {
      kind: "bytes",
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
    };
    // jsdom has no object-URL implementation; installed fresh here, the way
    // `use-report-issue-attachments.test.ts` does.
    URL.createObjectURL = vi.fn(() => "blob:mock/1");
    URL.revokeObjectURL = vi.fn();

    const rig = createRig();
    opened.push(rig.handle);
    rig.state.latest().callbacks.onSnapshot(snapshotFrame([]));

    render(
      <TabHostProvider hostId={HOST_ID}>
        <OpenIdentityContext.Provider
          value={{ kind: "ready", handle: rig.handle }}
        >
          <IdentityFileBody
            identityId={IDENTITY_ID}
            hostId={HOST_ID}
            file={PNG_FILE}
            hydrated
          />
        </OpenIdentityContext.Provider>
      </TabHostProvider>,
    );

    const img = screen.getByTestId("identity-blob-image");
    expect(img.getAttribute("src")).toBe("blob:mock/1");
  });

  it("renders the pending notice for a pending blob", () => {
    blobMocks.data = { kind: "pending", reason: "Still downloading." };

    const rig = createRig();
    opened.push(rig.handle);
    rig.state.latest().callbacks.onSnapshot(snapshotFrame([]));

    render(
      <TabHostProvider hostId={HOST_ID}>
        <OpenIdentityContext.Provider
          value={{ kind: "ready", handle: rig.handle }}
        >
          <IdentityFileBody
            identityId={IDENTITY_ID}
            hostId={HOST_ID}
            file={PNG_FILE}
            hydrated
          />
        </OpenIdentityContext.Provider>
      </TabHostProvider>,
    );

    expect(screen.getByTestId("identity-blob-pending")).not.toBeNull();
  });
});
