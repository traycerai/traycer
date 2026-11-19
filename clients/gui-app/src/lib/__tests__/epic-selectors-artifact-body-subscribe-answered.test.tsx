/**
 * `useEpicArtifactBodySubscribeAnswered` pinned against a REAL open-epic
 * store - not a hand-rolled `OpenEpicState` object - because the fact it
 * reports (has the body plane said ANYTHING about this artifact yet) is a
 * property of the real replica's bookkeeping, not just the projected field:
 * `dropAllOnViewerDowngrade()` only clears the map when the rooms replica's
 * OWN internal ledger (`availabilityByRoom`) is non-empty, so a state faked
 * by `store.setState(...)` alone would not exercise the drop this test's
 * access-loss test depends on.
 *
 * Same rig shape as `replica-runtime-behavior-identity.test.ts`'s
 * access-loss pin (`applyRootSnapshot`'s `rooms.dropAllOnViewerDowngrade()`
 * call, driven by a role nothing recognises) - reused here through the actual
 * hook rather than the bare store. A `viewer` role reads as `editor`, so it
 * loses nothing: its own test below pins that.
 */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ReactNode } from "react";
import * as Y from "yjs";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { EpicSessionContext } from "@/lib/registries/epic-session-registry";
import { useEpicArtifactBodySubscribeAnswered } from "@/lib/epic-selectors";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function stateVectorBase64(doc: Y.Doc): string {
  return encodeBase64(Y.encodeStateVector(doc));
}

function emptySnapshot(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/** Same shape as `replica-runtime-behavior-identity.test.ts`'s `buildMeta`. */
function buildMeta(
  role: "owner" | "editor" | "viewer" | "supervisor" | null,
  hostDoc: Y.Doc,
): SnapshotMetaEpic {
  // `"supervisor"` stands for a role nothing recognises. It never parses on the
  // wire, so it is handed over the way a decoder that let it through would.
  const meta: SnapshotMetaEpic = {
    schemaVersion: "1.0",
    epicLight:
      role === null
        ? null
        : {
            id: "epic-a",
            title: "Epic A",
            initialUserPrompt: "",
            ticketCount: 0,
            specCount: 0,
            storyCount: 0,
            reviewCount: 0,
            status: "open",
            createdAt: 0,
            updatedAt: 0,
            createdBy: "u",
            version: "1",
          },
    permissionRole: null,
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: stateVectorBase64(hostDoc),
  };
  return Object.assign(meta, { permissionRole: role });
}

/** Same shape as `replica-runtime-behavior-identity.test.ts`'s helper. */
function seedRootArtifactWithArtifactRoom(
  targetDoc: Y.Doc,
  artifactId: string,
  artifactRoomId: string,
): void {
  const epicMap = targetDoc.getMap<unknown>("epic");
  let artifacts = epicMap.get("artifacts");
  if (!(artifacts instanceof Y.Map)) {
    artifacts = new Y.Map<unknown>();
    epicMap.set("artifacts", artifacts);
  }
  const entry = new Y.Map<unknown>();
  entry.set("id", artifactId);
  entry.set("kind", "spec");
  entry.set("title", "Spec One");
  entry.set("parentId", null);
  entry.set("createdAt", 0);
  entry.set("updatedAt", 0);
  entry.set("artifactRoomId", artifactRoomId);
  (artifacts as Y.Map<unknown>).set(artifactId, entry);
}

interface FakeStreamHandle {
  readonly callbacks: EpicStreamCallbacks;
}

function fakeFactory(): {
  readonly factory: EpicStreamClientFactory;
  readonly handle: () => FakeStreamHandle;
} {
  let current: FakeStreamHandle | null = null;
  const factory: EpicStreamClientFactory = (_epicId, callbacks) => {
    current = { callbacks };
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  return {
    factory,
    handle: () => {
      if (current === null) throw new Error("factory not invoked");
      return current;
    },
  };
}

function openEpicWrapper(handle: OpenedStoreForTest) {
  return function OpenEpicWrapper(props: { readonly children: ReactNode }) {
    return (
      <EpicSessionContext.Provider value={handle}>
        {props.children}
      </EpicSessionContext.Provider>
    );
  };
}

describe("useEpicArtifactBodySubscribeAnswered", () => {
  const handles: OpenedStoreForTest[] = [];

  afterEach(() => {
    cleanup();
    for (const handle of handles.splice(0)) handle.dispose();
  });

  function openAnsweredSession(): {
    readonly result: { readonly current: boolean };
    readonly streamHandle: () => FakeStreamHandle;
    readonly donor: Y.Doc;
  } {
    const { factory, handle: streamHandle } = fakeFactory();
    const handle = openStoreForTest({
      epicId: "epic-subscribe-answered",
      userId: null,
      factories: { streamClientFactory: factory, laneSelection: null },
      writeCommand: null,
    });
    handles.push(handle);

    const { result } = renderHook(
      () => useEpicArtifactBodySubscribeAnswered("art-1"),
      { wrapper: openEpicWrapper(handle) },
    );

    // Before any body-plane frame: nothing has been said about this artifact
    // yet - this is the window the collapse-into-"unavailable" bug lived in.
    expect(result.current).toBe(false);

    const donor = new Y.Doc();
    seedRootArtifactWithArtifactRoom(donor, "art-1", "artifact-room-0");
    act(() => {
      streamHandle().callbacks.onConnectionStatus("open", null, false, null);
      streamHandle().callbacks.onSnapshot(
        buildMeta("editor", donor),
        Y.encodeStateAsUpdate(donor),
      );
      streamHandle().callbacks.onArtifactRoomSnapshot(
        "artifact-room-0",
        emptySnapshot(),
        stateVectorBase64(new Y.Doc()),
      );
    });

    // The room's own snapshot lands: the artifact now has an availability
    // entry, answered or not.
    expect(result.current).toBe(true);
    return { result, streamHandle, donor };
  }

  it("is false before any body-plane frame, true once the artifact has an availability entry, and false again after a role nothing recognises clears the map (dropAllOnViewerDowngrade)", () => {
    const { result, streamHandle, donor } = openAnsweredSession();

    act(() => {
      // A reconnect snapshot whose role grants nothing. Per
      // `applyRootSnapshot`, an unwritable role fails closed:
      // `rooms.dropAllOnViewerDowngrade()` clears every room's availability
      // entry - this artifact goes back to "not answered", not to a
      // host-refusal verdict.
      streamHandle().callbacks.onSnapshot(
        buildMeta("supervisor", donor),
        Y.encodeStateAsUpdate(donor),
      );
    });

    expect(result.current).toBe(false);
  });

  it("stays true after a reconnect snapshot naming viewer: a viewer role reads as editor, so no room's availability is dropped", () => {
    const { result, streamHandle, donor } = openAnsweredSession();

    act(() => {
      streamHandle().callbacks.onSnapshot(
        buildMeta("viewer", donor),
        Y.encodeStateAsUpdate(donor),
      );
    });

    expect(result.current).toBe(true);
  });
});
