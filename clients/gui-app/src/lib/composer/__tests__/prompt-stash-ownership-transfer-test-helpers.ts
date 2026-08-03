/**
 * Shared harness for prompt-stash ownership-transfer matrix split suites.
 * Drives real production surface adapters through usePromptStash + repository.
 */
import { expect, onTestFinished, vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import { bytesToBase64 } from "@/lib/composer/image-base64";
import {
  pngBytesOfSize,
  twoFrameGifBytesOfSize,
} from "./prompt-stash-image-fixtures";
import { installFreshIndexedDb } from "./prompt-stash-fake-idb";

export {
  installFreshIndexedDb,
  pngBytesOfSize,
  twoFrameGifBytesOfSize,
  bytesToBase64,
};

type TestingLibrary = typeof import("@testing-library/react");
type RepoModule = typeof import("@/lib/composer/prompt-stash-repository");
type ContentModule = typeof import("@/lib/composer/prompt-stash-content");
type UsePromptStashModule = typeof import("@/hooks/composer/use-prompt-stash");
type ChatAdapters =
  typeof import("@/components/chat/composer/use-chat-prompt-stash-adapters");
type LandingAdapters =
  typeof import("@/components/home/composer/use-landing-prompt-stash-adapters");
type ModalAdapters =
  typeof import("@/components/epic-canvas/sidebar/use-new-conversation-prompt-stash-adapters");
type ComposerDraftStore =
  typeof import("@/stores/composer/composer-draft-store");
type PromptStashStore = typeof import("@/stores/composer/prompt-stash-store");
type LandingDraftStore = typeof import("@/stores/home/landing-draft-store");
type DraftRuntimeRegistry =
  typeof import("@/stores/home/draft-runtime-registry");
type ModalStore = typeof import("@/stores/epics/new-conversation-modal-store");
type LandingImageStore = typeof import("@/lib/composer/landing-image-store");
type LandingBudget = typeof import("@/lib/composer/landing-image-budget");
type EditorHandle =
  import("@/components/chat/composer/composer-prompt-editor").ComposerPromptEditorHandle;

export interface Harness {
  readonly testing: TestingLibrary;
  readonly repo: RepoModule;
  readonly content: ContentModule;
  readonly usePromptStash: UsePromptStashModule["usePromptStash"];
  readonly chat: ChatAdapters;
  readonly landing: LandingAdapters;
  readonly modal: ModalAdapters;
  readonly composerDraft: ComposerDraftStore;
  readonly promptStashStore: PromptStashStore;
  readonly landingDraft: LandingDraftStore;
  readonly draftRuntime: DraftRuntimeRegistry;
  readonly modalStore: ModalStore;
  readonly landingImages: LandingImageStore;
  readonly landingBudget: LandingBudget;
}

export type { EditorHandle, JsonContent, LandingImageStore, TestingLibrary };

export function textDoc(text: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

export function emptyDoc(): JsonContent {
  return {
    type: "doc",
    content: [{ type: "paragraph" }],
  };
}

export function multiImageDoc(
  images: ReadonlyArray<{
    readonly id: string;
    readonly fileName: string;
    readonly hash: string | null;
    readonly b64content: string | null;
    readonly mimeType: string;
    readonly size: number;
  }>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "prefix " },
          ...images.map((attrs) => ({
            type: "imageAttachment" as const,
            attrs: { ...attrs },
          })),
          { type: "text", text: " suffix" },
        ],
      },
    ],
  };
}

export function findImageAttrs(node: JsonContent): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  if (node.type === "imageAttachment" && node.attrs !== undefined) {
    found.push(node.attrs);
  }
  for (const child of node.content ?? []) {
    found.push(...findImageAttrs(child));
  }
  return found;
}

export function makeEditorHandle(
  options:
    | {
        ready?: boolean;
        content?: JsonContent;
        onFocus?: () => void;
        onSetContent?: (
          content: JsonContent,
          selection: { from: number; to: number } | null,
        ) => void;
      }
    | undefined,
): {
  readonly handle: EditorHandle;
  readonly editorRef: { current: EditorHandle | null };
  readonly setContents: Array<{
    method: "setContent" | "syncContent";
    content: JsonContent;
    selection: { from: number; to: number } | null;
  }>;
  remount: () => EditorHandle;
  unmount: () => void;
} {
  let ready = options?.ready ?? true;
  let content = options?.content ?? emptyDoc();
  const setContents: Array<{
    method: "setContent" | "syncContent";
    content: JsonContent;
    selection: { from: number; to: number } | null;
  }> = [];

  const build = (): EditorHandle => ({
    isReady: () => ready,
    hasFocus: () => false,
    focus: () => {
      options?.onFocus?.();
    },
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => {
      content = emptyDoc();
    },
    setContent: (next, nextSelection) => {
      content = next;
      setContents.push({
        method: "setContent",
        content: next,
        selection: nextSelection,
      });
      options?.onSetContent?.(next, nextSelection);
    },
    syncContent: (next, nextSelection) => {
      content = next;
      setContents.push({
        method: "syncContent",
        content: next,
        selection: nextSelection,
      });
      options?.onSetContent?.(next, nextSelection);
    },
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  });

  const handle = build();
  const editorRef: { current: EditorHandle | null } = { current: handle };
  return {
    handle,
    editorRef,
    setContents,
    remount: () => {
      ready = true;
      const next = build();
      editorRef.current = next;
      return next;
    },
    unmount: () => {
      editorRef.current = null;
    },
  };
}

export async function loadHarness(): Promise<Harness> {
  vi.resetModules();
  installFreshIndexedDb();
  Reflect.deleteProperty(globalThis, "runnerHost");

  vi.doMock("sonner", () => ({
    toast: {
      error: vi.fn(),
      warning: vi.fn(),
      success: vi.fn(),
      info: vi.fn(),
    },
  }));

  const testing = await import("@testing-library/react");
  const repo = await import("@/lib/composer/prompt-stash-repository");
  const content = await import("@/lib/composer/prompt-stash-content");
  const { usePromptStash } = await import("@/hooks/composer/use-prompt-stash");
  const chat =
    await import("@/components/chat/composer/use-chat-prompt-stash-adapters");
  const landing =
    await import("@/components/home/composer/use-landing-prompt-stash-adapters");
  const modal =
    await import("@/components/epic-canvas/sidebar/use-new-conversation-prompt-stash-adapters");
  const composerDraft = await import("@/stores/composer/composer-draft-store");
  const promptStashStore = await import("@/stores/composer/prompt-stash-store");
  const landingDraft = await import("@/stores/home/landing-draft-store");
  const draftRuntime = await import("@/stores/home/draft-runtime-registry");
  const modalStore =
    await import("@/stores/epics/new-conversation-modal-store");
  const landingImages = await import("@/lib/composer/landing-image-store");
  const landingBudget = await import("@/lib/composer/landing-image-budget");

  await promptStashStore.usePromptStashStore.getState().hydrate();

  // Register cleanup as soon as the module-level resources exist so a failed
  // assertion cannot leak runtimes, reservations, modal drafts, or mounts into
  // the next ownership-transfer case.
  onTestFinished(() => {
    testing.cleanup();
    modalStore.useNewConversationModalStore.getState().resetForTests();
    draftRuntime.draftRuntimeRegistry.resetForTesting();
    landingBudget.resetLandingImageBudgetReservationsForTesting();
  });

  return {
    testing,
    repo,
    content,
    usePromptStash,
    chat,
    landing,
    modal,
    composerDraft,
    promptStashStore,
    landingDraft,
    draftRuntime,
    modalStore,
    landingImages,
    landingBudget,
  };
}

export function requireEntry(
  rows: ReadonlyArray<
    import("@/lib/composer/prompt-stash-codec").PromptStashRow
  >,
  label: string,
): import("@/lib/composer/prompt-stash-codec").PromptStashEntry {
  for (const row of rows) {
    if (row.kind === "entry") {
      return row.entry;
    }
  }
  throw new Error(`expected entry for ${label}`);
}

export function expectBytesEqual(
  actual: Uint8Array | null | undefined,
  expected: Uint8Array,
): void {
  expect(actual).toBeTruthy();
  if (actual === null || actual === undefined) return;
  // fake-indexeddb structured-clone can yield a different ArrayBuffer realm,
  // so toEqual on Uint8Array may fail with "no visual difference".
  expect(actual.byteLength).toBe(expected.byteLength);
  expect(Array.from(actual)).toEqual(Array.from(expected));
}

export function firstSetContent(
  setContents: ReadonlyArray<{
    method: "setContent" | "syncContent";
    content: JsonContent;
    selection: { from: number; to: number } | null;
  }>,
): {
  method: "setContent" | "syncContent";
  content: JsonContent;
  selection: { from: number; to: number } | null;
} {
  expect(setContents.length).toBeGreaterThan(0);
  const first = setContents.at(0);
  if (first === undefined) {
    throw new Error("expected setContent write");
  }
  return first;
}

export async function assertLandingAdoptedPngGifPair(
  written: JsonContent,
  landingImages: LandingImageStore,
  png: Uint8Array<ArrayBuffer>,
  gif: Uint8Array<ArrayBuffer>,
): Promise<void> {
  expect(written.content?.[0]?.content?.[0]).toEqual({
    type: "text",
    text: "prefix ",
  });
  const attrs = findImageAttrs(written);
  expect(attrs).toHaveLength(2);
  const expected = [
    {
      oldId: "src-a",
      mimeType: "image/png",
      size: png.byteLength,
      bytes: png,
    },
    {
      oldId: "src-b",
      mimeType: "image/gif",
      size: gif.byteLength,
      bytes: gif,
    },
  ] as const;
  const seenIds = new Set<unknown>();
  for (const [index, spec] of expected.entries()) {
    const node = attrs.at(index);
    if (node === undefined) {
      throw new Error(`expected image attr at ${index}`);
    }
    expect(node.id).not.toBe(spec.oldId);
    expect(seenIds.has(node.id)).toBe(false);
    seenIds.add(node.id);
    expect(node.b64content).toBeNull();
    expect(node.hash).toBeTruthy();
    expect(node.mimeType).toBe(spec.mimeType);
    expect(node.size).toBe(spec.size);
    expectBytesEqual(
      await landingImages.getImageBytes(String(node.hash)),
      spec.bytes,
    );
  }
}

export async function awaitStashComplete(
  testing: TestingLibrary,
  hook: { current: { pulseEpoch: number; saving: boolean } },
  priorEpoch: number,
): Promise<void> {
  const { act, waitFor } = testing;
  await act(async () => {
    // allow microtasks from stashCurrentAsync to schedule
    await Promise.resolve();
  });
  await waitFor(
    () => {
      expect(hook.current.pulseEpoch).toBeGreaterThan(priorEpoch);
      expect(hook.current.saving).toBe(false);
    },
    { timeout: 4000 },
  );
}
