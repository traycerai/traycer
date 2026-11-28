import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import {
  browserAnnotationRecordSchema,
  canvasAnnotationRecordSchema,
} from "@traycer/protocol/persistence/epic/schemas";
import { setMobileApp } from "@/lib/mobile-app";
import { composerCanvasAnnotationsKey } from "@/lib/persist";
import { useComposerDraftStore } from "../composer-draft-store";
import { persistedCanvasAnnotationImageHashes } from "../composer-canvas-persistence";

const STORAGE_KEY = "traycer-gui-app:composer-drafts";
const CHAT_ID = "chat-1";

const TYPED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "draft" }] }],
};
const EDITED: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "edited" }] }],
};

const CANVAS = canvasAnnotationRecordSchema.parse({
  kind: "browser-annotation",
  annotationId: "canvas-ann",
  source: {
    kind: "canvas",
    artifactId: "artifact-1",
    boardPath: "boards/home.html",
    canvasPage: null,
    artifactTitle: "Study",
  },
  capturedAt: 1,
  comment: "canvas note",
  counts: { elements: 1, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: null,
  imageHash: null,
});

const BROWSER = browserAnnotationRecordSchema.parse({
  kind: "browser-annotation",
  annotationId: "browser-ann",
  tabId: "tab-1",
  sessionId: "session-1",
  origin: "https://example.com",
  pageUrl: "https://example.com/",
  pageTitle: "Example",
  capturedAt: 1,
  comment: "browser note",
  counts: { elements: 0, regions: 0, strokes: 0 },
  elements: [],
  imageFileName: "browser-annotation-browser-ann.png",
  imageHash: "hash-browser",
});

/** The native shell hands each window its own id; every window shares one localStorage. */
function runAsWindow(windowId: string): void {
  Reflect.set(globalThis, "runnerHost", { windows: { windowId } });
}

function storedEntries(): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const key = window.localStorage.key(index);
    const value = key === null ? null : window.localStorage.getItem(key);
    if (key !== null && value !== null) entries.push([key, value]);
  }
  return entries;
}

/**
 * A fresh launch of the window: nothing in memory, then hydrate from
 * localStorage. Clearing the in-memory store writes through the persist
 * middleware, so what the previous launch left on disk is put back first.
 */
async function relaunchAs(windowId: string): Promise<void> {
  const onDisk = storedEntries();
  runAsWindow(windowId);
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  window.localStorage.clear();
  for (const [key, value] of onDisk) window.localStorage.setItem(key, value);
  await useComposerDraftStore.persist.rehydrate();
}

function annotationIds(): readonly string[] {
  return (
    useComposerDraftStore.getState().drafts[CHAT_ID]?.browserAnnotations ?? []
  ).map((record) => record.annotationId);
}

function storageEntries(
  storage: Storage,
): ReadonlyArray<readonly [string, string]> {
  const entries: Array<readonly [string, string]> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    const value = key === null ? null : storage.getItem(key);
    if (key !== null && value !== null) entries.push([key, value]);
  }
  return entries;
}

/**
 * A restart of the installed app or of a web tab: no shell window identity,
 * memory emptied, then the store rehydrates from whatever storage survived.
 * `keepSession: false` is a brand-new tab, which has no session storage.
 */
async function restart(keepSession: boolean): Promise<void> {
  const local = storageEntries(window.localStorage);
  const session = keepSession ? storageEntries(window.sessionStorage) : [];
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
  window.localStorage.clear();
  window.sessionStorage.clear();
  for (const [key, value] of local) window.localStorage.setItem(key, value);
  for (const [key, value] of session) window.sessionStorage.setItem(key, value);
  await useComposerDraftStore.persist.rehydrate();
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "runnerHost");
  setMobileApp(false);
  window.localStorage.clear();
  window.sessionStorage.clear();
  useComposerDraftStore.setState({
    drafts: {},
    pendingSubmittedDraftDeletes: {},
  });
});

describe("canvas annotations in the shared composer drafts", () => {
  it("keep a canvas card in its own window across a reload, out of the shared drafts, and browser cards stay shared", async () => {
    runAsWindow("window-a");
    const store = useComposerDraftStore.getState();
    store.setSnapshot(CHAT_ID, TYPED, null);
    store.addBrowserAnnotation(CHAT_ID, BROWSER);
    store.addBrowserAnnotation(CHAT_ID, CANVAS);

    const shared = window.localStorage.getItem(STORAGE_KEY) ?? "";
    expect(shared).toContain("browser-ann");
    expect(shared).not.toContain("canvas-ann");
    expect(shared).not.toContain("canvas note");

    await relaunchAs("window-a");
    expect(annotationIds()).toEqual(
      expect.arrayContaining(["browser-ann", "canvas-ann"]),
    );
    expect(annotationIds()).toHaveLength(2);
  });

  it("do not appear in another window sharing the same drafts", async () => {
    runAsWindow("window-a");
    const store = useComposerDraftStore.getState();
    store.setSnapshot(CHAT_ID, TYPED, null);
    store.addBrowserAnnotation(CHAT_ID, BROWSER);
    store.addBrowserAnnotation(CHAT_ID, CANVAS);

    await relaunchAs("window-b");

    expect(annotationIds()).toEqual(["browser-ann"]);
    expect(useComposerDraftStore.getState().drafts[CHAT_ID]?.content).toEqual(
      TYPED,
    );
  });

  it("survive another window editing and persisting the same chat's draft", async () => {
    runAsWindow("window-a");
    const first = useComposerDraftStore.getState();
    first.setSnapshot(CHAT_ID, TYPED, null);
    first.addBrowserAnnotation(CHAT_ID, CANVAS);

    await relaunchAs("window-b");
    useComposerDraftStore.getState().setSnapshot(CHAT_ID, EDITED, null);
    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation(CHAT_ID, "browser-ann");

    await relaunchAs("window-a");
    expect(annotationIds()).toEqual(["canvas-ann"]);
  });

  it("keep their crop rooted for image cleanup while another window is the one running", async () => {
    runAsWindow("window-a");
    const store = useComposerDraftStore.getState();
    store.setSnapshot(CHAT_ID, TYPED, null);
    store.addBrowserAnnotation(CHAT_ID, {
      ...CANVAS,
      annotationId: "canvas-with-crop",
      imageFileName: "canvas-selection.png",
      imageHash: "crop-of-window-a",
    });

    await relaunchAs("window-b");

    expect(annotationIds()).toEqual([]);
    expect(persistedCanvasAnnotationImageHashes()).toContain(
      "crop-of-window-a",
    );
  });

  it("are dropped when they arrive through the shared drafts, which belong to no window", async () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          drafts: {
            [CHAT_ID]: {
              content: TYPED,
              selection: null,
              browserAnnotations: [CANVAS, BROWSER],
            },
          },
        },
      }),
    );

    await relaunchAs("window-a");

    expect(annotationIds()).toEqual(["browser-ann"]);
  });
});

describe("canvas annotations without a native window identity", () => {
  const MOBILE_KEY = composerCanvasAnnotationsKey("mobile");
  const SESSION_KEY = composerCanvasAnnotationsKey("session");

  it("the installed phone app keeps a canvas card and its crop across a restart", async () => {
    setMobileApp(true);
    const store = useComposerDraftStore.getState();
    store.setSnapshot(CHAT_ID, TYPED, null);
    store.addBrowserAnnotation(CHAT_ID, {
      ...CANVAS,
      imageFileName: "canvas-selection.png",
      imageHash: "crop-of-phone",
    });

    expect(window.localStorage.getItem(MOBILE_KEY)).toContain("canvas-ann");
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();

    await restart(false);
    expect(annotationIds()).toEqual(["canvas-ann"]);

    expect(persistedCanvasAnnotationImageHashes()).toContain("crop-of-phone");
  });

  it("a phone reads the old session bucket only until it writes its own, and a removal does not bring it back", async () => {
    const store = useComposerDraftStore.getState();
    store.setSnapshot(CHAT_ID, TYPED, null);
    store.addBrowserAnnotation(CHAT_ID, CANVAS);
    expect(window.sessionStorage.getItem(SESSION_KEY)).toContain("canvas-ann");

    setMobileApp(true);
    await restart(true);
    expect(annotationIds()).toEqual(["canvas-ann"]);
    expect(window.localStorage.getItem(MOBILE_KEY)).toBeNull();

    useComposerDraftStore.getState().addBrowserAnnotation(CHAT_ID, BROWSER);
    expect(window.localStorage.getItem(MOBILE_KEY)).toContain("canvas-ann");
    expect(window.sessionStorage.getItem(SESSION_KEY)).toBeNull();

    useComposerDraftStore
      .getState()
      .removeBrowserAnnotation(CHAT_ID, "canvas-ann");
    expect(window.localStorage.getItem(MOBILE_KEY)).toBeNull();

    await restart(true);
    expect(annotationIds()).toEqual(["browser-ann"]);
  });

  it("an ordinary web tab keeps its card in session storage only, so a new tab does not see it", async () => {
    const store = useComposerDraftStore.getState();
    store.setSnapshot(CHAT_ID, TYPED, null);
    store.addBrowserAnnotation(CHAT_ID, CANVAS);

    expect(window.sessionStorage.getItem(SESSION_KEY)).toContain("canvas-ann");
    expect(window.localStorage.getItem(MOBILE_KEY)).toBeNull();
    expect(JSON.stringify(storageEntries(window.localStorage))).not.toContain(
      "canvas note",
    );

    await restart(true);
    expect(annotationIds()).toEqual(["canvas-ann"]);

    await restart(false);
    expect(annotationIds()).toEqual([]);
  });
});
