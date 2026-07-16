/**
 * B6 GUI artifact-room binding characterization
 * (ticket:e86b8372-ad33-45d7-9672-2e1851d777e8/900a0484).
 *
 * After B6 the renderer no longer reads body fragments from the root
 * Epic doc - it routes through `artifactRoomId` on the artifact metadata and
 * a per-artifact-room Y.Doc replica seeded by `onArtifactRoomSnapshot`. These tests pin the
 * post-cutover invariants:
 *
 *   - Freshly created artifacts are metadata-only placeholders with no
 *     root `content` fragment and no `artifactRoomId` (seeded here via
 *     `createArtifactInDocForTests`, standing in for the host-side create).
 *   - `getArtifactFragment` returns null when no artifactRoom has been seeded for
 *     the artifact's `artifactRoomId` (the expected state after a fresh
 *     create).
 *   - Chat / unknown artifacts still return null.
 *   - The projector no longer bumps `contentRevByArtifactId` on edits to
 *     the legacy root `content` fragment because body edits now live on
 *     the artifact-room doc - the root doc carries metadata only.
 */
import "../../../../../__tests__/test-browser-apis";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createArtifactInDocForTests } from "./projection-helpers-test-shims";
import {
  createOpenEpicStore,
  type EpicStreamClientFactory,
  type OpenEpicStoreHandle,
} from "@/stores/epics/open-epic/store";
import type { EpicStreamCallbacks } from "@traycer-clients/shared/host-transport/epic-stream-client";
import type { SnapshotMetaEpic } from "@traycer/protocol/host/epic/snapshot-meta";

function encodeBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function makeMeta(): SnapshotMetaEpic {
  return {
    schemaVersion: "1.0",
    epicLight: {
      id: "epic-test",
      title: "Epic test",
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

function newSession(): {
  handle: OpenEpicStoreHandle;
  callbacks: EpicStreamCallbacks;
} {
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
  const handle = createOpenEpicStore({
    epicId: "epic-test",
    streamClientFactory: factory,
    userId: null,
    onAuthError: null,
  });
  if (captured.value === null) throw new Error("factory not invoked");
  const seed = Y.encodeStateAsUpdate(new Y.Doc());
  captured.value.onSnapshot(makeMeta(), seed);
  return { handle, callbacks: captured.value };
}

function readContentField(
  doc: Y.Doc,
  artifactId: string,
): Y.XmlFragment | null {
  const epic = doc.getMap<unknown>("epic");
  const artifacts = epic.get("artifacts");
  if (!(artifacts instanceof Y.Map)) return null;
  const artifactsMap: Y.Map<unknown> = artifacts;
  const entry = artifactsMap.get(artifactId);
  if (!(entry instanceof Y.Map)) return null;
  const entryMap: Y.Map<unknown> = entry;
  const value = entryMap.get("content");
  return value instanceof Y.XmlFragment ? value : null;
}

describe("open-epic store artifact-room binding (post-B6)", () => {
  it("a freshly seeded artifact is a metadata-only root entry with no local body fragment", () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const fragment = readContentField(handle.doc, id);
    expect(fragment).toBeNull();
    expect(
      handle.store.getState().artifacts.byId[id].artifactRoomId,
    ).toBeNull();
    handle.dispose();
  });

  it("does not bump contentRevByArtifactId for legacy root content edits", () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    const before = handle.store.getState().contentRevByArtifactId[id];

    const epic = handle.doc.getMap<unknown>("epic");
    const artifacts = epic.get("artifacts");
    if (!(artifacts instanceof Y.Map)) throw new Error("missing artifacts");
    const artifactsMap: Y.Map<unknown> = artifacts;
    const entry = artifactsMap.get(id);
    if (!(entry instanceof Y.Map)) throw new Error("missing artifact entry");
    const entryMap: Y.Map<unknown> = entry;
    const legacyRootContent = new Y.XmlFragment();
    entryMap.set("content", legacyRootContent);
    const text = new Y.XmlText();
    text.insert(0, "legacy root body");
    legacyRootContent.insert(0, [text]);

    expect(handle.store.getState().contentRevByArtifactId[id]).toBe(before);
    expect(handle.store.getState().getArtifactFragment(id)).toBeNull();
    handle.dispose();
  });

  it("getArtifactFragment returns null for an artifact without a artifactRoomId / artifactRoom snapshot", () => {
    // A locally-created artifact has no `artifactRoomId` until the host
    // assigns one and ships a `artifactRoomSnapshot` for the chosen artifactRoom. Until
    // then the editor must render a placeholder rather than bind a stale
    // root-doc fragment.
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "spec", null);
    expect(handle.store.getState().getArtifactFragment(id)).toBeNull();
    expect(handle.store.getState().getArtifactBodyAvailability(id)).toBe(
      "unavailable",
    );
    handle.dispose();
  });

  it("getArtifactFragment returns null for chat artifacts (no body fragment)", () => {
    const { handle } = newSession();
    const id = createArtifactInDocForTests(handle.doc, "chat", null);
    expect(handle.store.getState().getArtifactFragment(id)).toBeNull();
    handle.dispose();
  });

  it("getArtifactFragment returns null for unknown artifact ids", () => {
    const { handle } = newSession();
    expect(handle.store.getState().getArtifactFragment("missing")).toBeNull();
    handle.dispose();
  });
});
