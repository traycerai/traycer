/**
 * Landing prompt-stash destination - identity/acceptance.
 */
import { cleanup } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { landingStashIdentity } from "@/components/home/composer/use-landing-prompt-stash-adapters";
import { getImageBytes } from "@/lib/composer/landing-image-store";
import { importPromptStashContentToLanding } from "@/lib/composer/landing-stash-import";
import {
  reserveLandingImageBudget,
  resetLandingImageBudgetReservationsForTesting,
} from "@/lib/composer/landing-image-budget";
import * as promptStashRepository from "@/lib/composer/prompt-stash-repository";
import type { PromptStashRestoreBlob } from "@/lib/composer/prompt-stash-codec";
import {
  draftRuntimeRegistry,
  type DraftRuntimeState,
} from "@/stores/home/draft-runtime-registry";
import { useLandingDraftStore } from "@/stores/home/landing-draft-store";
import {
  bytesOf,
  collectImageNodes,
  drainLandingStore,
  emptyDoc,
  emptyRuntime,
  holdPutImage,
  imageDoc,
  makeEditorHandle,
  makeEntry,
  renderLandingDestination,
  requireDefined,
  restoreThroughLanding,
  seedStashImage,
  stashBlobs,
  textDoc,
} from "./landing-composer-prompt-stash-destination-test-helpers";

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") {
    throw new Error("idb keys in these tests are strings");
  }
  return key;
}

vi.mock("idb-keyval", () => {
  const dummyStore = () => Promise.reject(new Error("unused"));
  return {
    createStore: vi.fn(() => dummyStore),
    get: vi.fn((key: IDBValidKey) =>
      Promise.resolve(idbData.get(idbStringKey(key))),
    ),
    set: vi.fn((key: IDBValidKey, value: unknown) => {
      idbData.set(idbStringKey(key), value);
      return Promise.resolve();
    }),
    setMany: vi.fn((entries: ReadonlyArray<[IDBValidKey, unknown]>) => {
      for (const [key, value] of entries) {
        idbData.set(idbStringKey(key), value);
      }
      return Promise.resolve();
    }),
    del: vi.fn((key: IDBValidKey) => {
      idbData.delete(idbStringKey(key));
      return Promise.resolve();
    }),
    delMany: vi.fn((keys: ReadonlyArray<IDBValidKey>) => {
      for (const key of keys) {
        idbData.delete(idbStringKey(key));
      }
      return Promise.resolve();
    }),
    keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
  };
});

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
  }),
}));

describe("landing composer prompt-stash destination identity/acceptance", () => {
  beforeEach(async () => {
    idbData.clear();
    stashBlobs.clear();
    resetLandingImageBudgetReservationsForTesting();
    draftRuntimeRegistry.resetForTesting();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
    Reflect.deleteProperty(globalThis, "runnerHost");
    await drainLandingStore();
    vi.spyOn(
      promptStashRepository,
      "readPromptStashRestoreBlobs",
    ).mockImplementation((hashes) => {
      const out = new Map<string, PromptStashRestoreBlob>();
      for (const hash of hashes) {
        const blob = stashBlobs.get(hash);
        if (blob === undefined) {
          return Promise.resolve({ status: "missing" as const });
        }
        out.set(hash, blob);
      }
      return Promise.resolve({ status: "ok" as const, blobs: out });
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "runnerHost");
    await drainLandingStore();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("returns null captureIdentity when editor is missing or unready", () => {
    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const { result: missing } = renderLandingDestination({
      stashIdentity: "draft-1",
      draftId: "draft-1",
      runtimeStore,
      editorRef: { current: null },
    });
    expect(missing.current.captureIdentity()).toBeNull();

    const unready = makeEditorHandle({ ready: false });
    const { result: dest } = renderLandingDestination({
      stashIdentity: "draft-1",
      draftId: "draft-1",
      runtimeStore,
      editorRef: unready.editorRef,
    });
    expect(dest.current.captureIdentity()).toBeNull();
  });
  it("accepts React Compiler handle-facade churn for the same editor incarnation", async () => {
    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result } = renderLandingDestination({
      stashIdentity: "draft-compiler-churn",
      draftId: "draft-compiler-churn",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const captured = requireDefined(
      result.current.captureIdentity(),
      "capture",
    );

    const replacement = editor.replaceFacade();
    expect(replacement).not.toBe(editor.handle);
    expect(replacement.getEditorIncarnation()).toBe(captured.editorIncarnation);

    const insertResult = await result.current.importAndInsert({
      identity: captured,
      content: textDoc("restored after facade churn"),
    });

    expect(insertResult).toEqual({ status: "accepted" });
    expect(editor.setContents).toEqual([
      {
        content: textDoc("restored after facade churn"),
        selection: null,
      },
    ]);
  });
  it("returns stale on identity switch after materialize and releases reservation", async () => {
    const bytes = bytesOf([7, 7, 7]);
    const stashHash = await seedStashImage(bytes);
    const held = holdPutImage();

    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result: destAtCaptureResult } = renderLandingDestination({
      stashIdentity: landingStashIdentity("draft-a", null),
      draftId: "draft-a",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const destAtCapture = destAtCaptureResult.current;
    const captured = requireDefined(destAtCapture.captureIdentity(), "capture");
    const materialize = requireDefined(
      destAtCapture.materialize,
      "materialize",
    );

    const pendingMaterialize = materialize(
      makeEntry({
        content: imageDoc({
          id: "n",
          fileName: "x.png",
          hash: stashHash,
          b64content: null,
          mimeType: "image/png",
          size: 3,
        }),
        id: "landing-entry",
        blobHashes: [stashHash],
      }),
    );
    await held.waitedUntilHeld();
    held.release();
    const materialized = await pendingMaterialize;
    held.restore();
    const mat = requireDefined(materialized, "materialized content");

    // Post-materialize destination has a different identity.
    const { result: destAfterSwitchResult } = renderLandingDestination({
      stashIdentity: landingStashIdentity("draft-b", null),
      draftId: "draft-b",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const destAfterSwitch = destAfterSwitchResult.current;
    const result = await destAfterSwitch.importAndInsert({
      identity: captured,
      content: mat.content,
    });
    mat.release?.();

    expect(result).toEqual({ status: "stale" });
    expect(editor.setContents).toHaveLength(0);

    const reReserve = reserveLandingImageBudget("draft-b", [
      { hash: stashHash, bytes: bytes.byteLength },
    ]);
    expect(reReserve).not.toBeNull();
    requireDefined(reReserve, "re-reserve after stale").release();
  });
  it("returns stale on remount after materialize and releases reservation", async () => {
    const bytes = bytesOf([8, 8, 8]);
    const stashHash = await seedStashImage(bytes);
    const held = holdPutImage();

    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result: destResult } = renderLandingDestination({
      stashIdentity: "draft-same",
      draftId: "draft-same",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const dest = destResult.current;
    const captured = requireDefined(dest.captureIdentity(), "capture");
    expect(captured.editorIncarnation).toBe(
      editor.handle.getEditorIncarnation(),
    );
    const materialize = requireDefined(dest.materialize, "materialize");

    const pendingMaterialize = materialize(
      makeEntry({
        content: imageDoc({
          id: "n",
          fileName: "x.png",
          hash: stashHash,
          b64content: null,
          mimeType: "image/png",
          size: 3,
        }),
        id: "landing-entry",
        blobHashes: [stashHash],
      }),
    );
    await held.waitedUntilHeld();
    const remounted = editor.remount();
    expect(remounted).not.toBe(editor.handle);
    expect(remounted.getEditorIncarnation()).not.toBe(
      captured.editorIncarnation,
    );
    held.release();
    const materialized = await pendingMaterialize;
    held.restore();
    const mat = requireDefined(materialized, "materialized content");

    const result = await dest.importAndInsert({
      identity: captured,
      content: mat.content,
    });
    mat.release?.();

    expect(result).toEqual({ status: "stale" });
    expect(editor.setContents).toHaveLength(0);

    const reReserve = reserveLandingImageBudget("draft-same", [
      { hash: stashHash, bytes: bytes.byteLength },
    ]);
    expect(reReserve).not.toBeNull();
    requireDefined(reReserve, "re-reserve after remount stale").release();
  });
  it("returns stale when editor unmounts after materialize", async () => {
    const bytes = bytesOf([5, 5]);
    const stashHash = await seedStashImage(bytes);
    const held = holdPutImage();

    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result: destResult } = renderLandingDestination({
      stashIdentity: "draft-1",
      draftId: "draft-1",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const dest = destResult.current;
    const captured = requireDefined(dest.captureIdentity(), "capture");
    const materialize = requireDefined(dest.materialize, "materialize");

    const pendingMaterialize = materialize(
      makeEntry({
        content: imageDoc({
          id: "n",
          fileName: "x.png",
          hash: stashHash,
          b64content: null,
          mimeType: "image/png",
          size: 2,
        }),
        id: "landing-entry",
        blobHashes: [stashHash],
      }),
    );
    await held.waitedUntilHeld();
    editor.unmount();
    held.release();
    const materialized = await pendingMaterialize;
    held.restore();
    const mat = requireDefined(materialized, "materialized content");

    const result = await dest.importAndInsert({
      identity: captured,
      content: mat.content,
    });
    mat.release?.();

    expect(result).toEqual({ status: "stale" });
    expect(editor.setContents).toHaveLength(0);
  });
  it("appends restored content after the latest typed content", async () => {
    const bytes = bytesOf([11, 22, 33]);
    const stashHash = await seedStashImage(bytes);
    const held = holdPutImage();

    const runtimeStore = createStore<DraftRuntimeState>(() => ({
      content: textDoc("typed before restore"),
      selection: null,
      contentRevision: 2,
      attachmentRoots: new Set(),
      isSubmitting: false,
    }));
    const editor = makeEditorHandle({
      content: textDoc("typed before restore"),
    });
    const { result: destResult } = renderLandingDestination({
      stashIdentity: "draft-1",
      draftId: "draft-1",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const dest = destResult.current;
    const captured = requireDefined(dest.captureIdentity(), "capture");
    const materialize = requireDefined(dest.materialize, "materialize");
    const entry = makeEntry({
      content: imageDoc({
        id: "n",
        fileName: "x.png",
        hash: stashHash,
        b64content: null,
        mimeType: "image/png",
        size: 3,
      }),
      id: "landing-entry",
      blobHashes: [stashHash],
    });

    const pendingMaterialize = materialize(entry);
    await held.waitedUntilHeld();
    runtimeStore.setState({
      content: textDoc("typed during import"),
      selection: null,
      contentRevision: 3,
      attachmentRoots: new Set(),
      isSubmitting: false,
    });
    held.release();
    const materialized = await pendingMaterialize;
    held.restore();
    const mat = requireDefined(materialized, "materialized content");

    const result = await dest.importAndInsert({
      identity: captured,
      content: mat.content,
    });
    mat.release?.();

    expect(result).toEqual({ status: "accepted" });
    expect(editor.setContents).toHaveLength(1);
    const written = requireDefined(editor.setContents[0], "setContent write");
    expect(written.content.content?.[0]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "typed during import" }],
    });
    const images = collectImageNodes(written.content);
    expect(images).toHaveLength(1);
    const node = requireDefined(images[0], "image node");
    expect(node.attrs?.hash).toBe(stashHash);
    expect(await getImageBytes(String(node.attrs?.hash))).toEqual(bytes);
    expect(written.selection).toBeNull();
  });
  it("places the caret at the end when destination content is empty", async () => {
    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result: destResult } = renderLandingDestination({
      stashIdentity: "draft-empty",
      draftId: "draft-empty",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const dest = destResult.current;
    const captured = requireDefined(dest.captureIdentity(), "capture");

    const result = await restoreThroughLanding(
      dest,
      captured,
      makeEntry({
        content: textDoc("into empty"),
        id: "landing-entry",
        blobHashes: [],
      }),
    );
    expect(result).toEqual({ status: "accepted" });
    const written = requireDefined(editor.setContents[0], "setContent write");
    expect(written.content).toEqual(textDoc("into empty"));
    expect(written.selection).toBeNull();
  });
  it("opens a distinct landing-image DB name per windowId during import", async () => {
    const { createStore: idbCreateStore } = await import("idb-keyval");
    const { landingImagePartition } =
      await import("@/lib/composer/landing-image-store");

    const bytesA = bytesOf([1, 0, 0]);
    const bytesB = bytesOf([0, 1, 0]);
    const stashHashA = await seedStashImage(bytesA);
    const stashHashB = await seedStashImage(bytesB);

    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "window-a" },
    });
    expect(landingImagePartition()).toBe("window-a");
    vi.mocked(idbCreateStore).mockClear();
    const importedA = await importPromptStashContentToLanding(
      makeEntry({
        content: imageDoc({
          id: "a",
          fileName: "a.png",
          hash: stashHashA,
          b64content: null,
          mimeType: "image/png",
          size: 3,
        }),
        id: "entry-a",
        blobHashes: [stashHashA],
      }),
      "draft-a",
    );
    const resultA = requireDefined(importedA, "import A");
    expect(idbCreateStore).toHaveBeenCalledWith(
      expect.stringContaining(":window-a:landing-images"),
      "bytes",
    );
    resultA.reservation.release();

    Reflect.set(globalThis, "runnerHost", {
      windows: { windowId: "window-b" },
    });
    expect(landingImagePartition()).toBe("window-b");
    vi.mocked(idbCreateStore).mockClear();
    const importedB = await importPromptStashContentToLanding(
      makeEntry({
        content: imageDoc({
          id: "b",
          fileName: "b.png",
          hash: stashHashB,
          b64content: null,
          mimeType: "image/png",
          size: 3,
        }),
        id: "entry-b",
        blobHashes: [stashHashB],
      }),
      "draft-b",
    );
    const resultB = requireDefined(importedB, "import B");
    expect(idbCreateStore).toHaveBeenCalledWith(
      expect.stringContaining(":window-b:landing-images"),
      "bytes",
    );
    resultB.reservation.release();
  });
});
