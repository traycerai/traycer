/** Production adapter wiring for landing prompt-stash image adoption. */
import { cleanup } from "@testing-library/react";
import { createStore } from "zustand/vanilla";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  reserveLandingImageBudget,
  resetLandingImageBudgetReservationsForTesting,
} from "@/lib/composer/landing-image-budget";
import { getImageBytes } from "@/lib/composer/landing-image-store";
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
  imageDoc,
  makeEditorHandle,
  makeEntry,
  renderLandingDestination,
  requireDefined,
  restoreThroughLanding,
  seedStashImage,
  stashBlobs,
} from "./landing-composer-prompt-stash-destination-test-helpers";

const idbData = vi.hoisted(() => new Map<string, unknown>());

function idbStringKey(key: IDBValidKey): string {
  if (typeof key !== "string") throw new Error("idb keys must be strings");
  return key;
}

vi.mock("idb-keyval", () => ({
  createStore: vi.fn(() => () => undefined),
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
    for (const key of keys) idbData.delete(idbStringKey(key));
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve(Array.from(idbData.keys()))),
}));

describe("landing prompt-stash image adoption wiring", () => {
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
      const blobs = new Map<string, PromptStashRestoreBlob>();
      for (const hash of hashes) {
        const blob = stashBlobs.get(hash);
        if (blob === undefined) return Promise.resolve({ status: "missing" });
        blobs.set(hash, blob);
      }
      return Promise.resolve({ status: "ok", blobs });
    });
  });

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    Reflect.deleteProperty(globalThis, "runnerHost");
    await drainLandingStore();
    useLandingDraftStore.setState({ drafts: [], activeDraftId: null });
  });

  it("imports stash bytes into landing hashes with fresh ids before accepting", async () => {
    const bytes = bytesOf([10, 20, 30, 40]);
    const stashHash = await seedStashImage(bytes);
    const runtimeStore = createStore<DraftRuntimeState>(() => emptyRuntime());
    const editor = makeEditorHandle({ content: emptyDoc() });
    const { result } = renderLandingDestination({
      stashIdentity: "draft-1",
      draftId: "draft-1",
      runtimeStore,
      editorRef: editor.editorRef,
    });
    const destination = result.current;
    const identity = requireDefined(destination.captureIdentity(), "capture");
    const entry = makeEntry({
      content: imageDoc({
        id: "stashed-node",
        fileName: "shot.png",
        hash: stashHash,
        b64content: null,
        mimeType: "image/png",
        size: bytes.byteLength,
      }),
      id: "landing-entry",
      blobHashes: [stashHash],
    });

    expect(await restoreThroughLanding(destination, identity, entry)).toEqual({
      status: "accepted",
    });

    const written = requireDefined(editor.setContents[0], "setContent write");
    const node = requireDefined(
      collectImageNodes(written.content)[0],
      "image node",
    );
    expect(node.attrs?.id).not.toBe("stashed-node");
    expect(node.attrs?.hash).toBe(stashHash);
    expect(node.attrs?.fileName).toBe("shot.png");
    expect(await getImageBytes(String(node.attrs?.hash))).toEqual(bytes);
    expect(written.selection).toBeNull();

    const reservation = reserveLandingImageBudget("draft-1", [
      { hash: stashHash, bytes: bytes.byteLength },
    ]);
    requireDefined(reservation, "re-reserve after success").release();
  });
});
