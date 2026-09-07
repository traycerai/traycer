/**
 * Render-count regression tests using the React Profiler API.
 *
 * Asserts the projector's identity contract end-to-end: editing one
 * artifact must NOT cause a component subscribed to a sibling artifact
 * (or to an unrelated slice such as the connection pill) to re-render.
 *
 * These tests are the safety net for the "Y update -> targeted slice
 * patch -> no cross-component churn" claim that justifies the refactor.
 */
import { afterEach, describe, expect, it } from "vitest";
import { Profiler, type ProfilerOnRenderCallback } from "react";
import { act, cleanup, render } from "@testing-library/react";
import * as Y from "yjs";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";
import { type EpicStreamClientFactory } from "@/stores/epics/open-epic/store";
import {
  openStoreForTest,
  type OpenedStoreForTest,
} from "@/stores/epics/open-epic/test-support/open-store-for-test";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import { useStore } from "zustand";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-render-counts",
      title: "Render Counts",
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
    permissionRole: "editor",
    repos: [],
    workspaces: [],
    repoMapping: [],
    workspaceFolders: [],
    unresolvedRepos: [],
    hostStateVectorBase64: encodeBase64(Y.encodeStateVector(new Y.Doc())),
  };
}

function newSession(): OpenedStoreForTest {
  const captured: { value: EpicStreamCallbacks | null } = { value: null };
  const factory: EpicStreamClientFactory = (_id, callbacks) => {
    captured.value = callbacks;
    return {
      applyUpdate: () => undefined,
      awareness: () => undefined,
      applyArtifactRoomUpdate: () => undefined,
      artifactRoomAwareness: () => undefined,
      retryMigration: () => undefined,
      close: () => undefined,
    };
  };
  const handle = openStoreForTest({
    epicId: "epic-render-counts",
    userId: null,
    // The factories go to the COMPOSITION now, not the store:
    // `createOpenEpicStore` stopped constructing a runtime, so a
    // suite that used to hand it a `streamClientFactory` has nothing
    // to hand it. `handle.doc` still resolves because this harness
    // builds the runtime in THIS thread.
    factories: {
      streamClientFactory: factory,
      laneSelection: null,
    },
    // Explicit: `null` means this suite never writes, so a write in
    // one that said so fails rather than resolving quietly.
    writeCommand: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  captured.value.onSnapshot(makeMeta(), Y.encodeStateAsUpdate(new Y.Doc()));
  return handle;
}

interface ProfilerSpy {
  readonly callback: ProfilerOnRenderCallback;
  readonly counts: Map<string, number>;
}

function makeSpy(): ProfilerSpy {
  const counts = new Map<string, number>();
  const callback: ProfilerOnRenderCallback = (id) => {
    counts.set(id, (counts.get(id) ?? 0) + 1);
  };
  return { callback, counts };
}

afterEach(() => {
  cleanup();
});

describe("epic projector render-count regressions", () => {
  it("editing artifact A does NOT re-render a component subscribed to artifact B", async () => {
    const handle = newSession();
    const idA = createArtifactInDocForTests(handle.doc, "spec", null);
    const idB = createArtifactInDocForTests(handle.doc, "spec", null);

    const spy = makeSpy();

    function ArtifactBView() {
      const title = useStore(handle.store, (s) =>
        Object.hasOwn(s.artifacts.byId, idB) ? s.artifacts.byId[idB].title : "",
      );
      return <span data-testid="b">{title}</span>;
    }

    render(
      <Profiler id="b" onRender={spy.callback}>
        <ArtifactBView />
      </Profiler>,
    );

    const initial = spy.counts.get("b") ?? 0;
    expect(initial).toBeGreaterThan(0);

    await act(async () => {
      await handle.store.getState().renameArtifact(idA, "A renamed once");
      await handle.store.getState().renameArtifact(idA, "A renamed twice");
      await handle.store.getState().renameArtifact(idA, "A renamed thrice");
    });

    expect(spy.counts.get("b") ?? 0).toBe(initial);
    handle.dispose();
  });

  it("editing artifact title does NOT re-render the connection-status subscriber", async () => {
    const handle = newSession();
    const idA = createArtifactInDocForTests(handle.doc, "spec", null);

    const spy = makeSpy();

    function ConnectionStatusView() {
      const status = useStore(handle.store, (s) => s.connectionStatus);
      return <span>{status}</span>;
    }

    render(
      <Profiler id="conn" onRender={spy.callback}>
        <ConnectionStatusView />
      </Profiler>,
    );

    const initial = spy.counts.get("conn") ?? 0;

    await act(async () => {
      await handle.store.getState().renameArtifact(idA, "Title 1");
      await handle.store.getState().renameArtifact(idA, "Title 2");
    });

    expect(spy.counts.get("conn") ?? 0).toBe(initial);
    handle.dispose();
  });

  it("tree slice stays referentially stable when only a title changes", async () => {
    const handle = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);

    const spy = makeSpy();

    function RootIdsView() {
      // Subscribes to rootIds reference. Title-only edits should not bump it.
      const rootIds = useStore(handle.store, (s) => s.tree.rootIds);
      return <span>{rootIds.length}</span>;
    }

    render(
      <Profiler id="root" onRender={spy.callback}>
        <RootIdsView />
      </Profiler>,
    );
    const initial = spy.counts.get("root") ?? 0;

    await act(async () => {
      await handle.store.getState().renameArtifact(id, "Title only");
    });

    expect(spy.counts.get("root") ?? 0).toBe(initial);
    handle.dispose();
  });

  it("structural change DOES re-render the rootIds subscriber", () => {
    const handle = newSession();

    const spy = makeSpy();

    function RootIdsView() {
      const rootIds = useStore(handle.store, (s) => s.tree.rootIds);
      return <span>{rootIds.length}</span>;
    }

    render(
      <Profiler id="root" onRender={spy.callback}>
        <RootIdsView />
      </Profiler>,
    );
    const initial = spy.counts.get("root") ?? 0;

    act(() => {
      createArtifactInDocForTests(handle.doc, "spec", null);
    });

    // Adding a root invalidates rootIds → at least one extra render.
    expect((spy.counts.get("root") ?? 0) - initial).toBeGreaterThanOrEqual(1);
    handle.dispose();
  });
});
