/**
 * Shared fixtures for landing composer prompt-stash destination split suites.
 */
import type { StoreApi } from "zustand/vanilla";
import { renderHook } from "@testing-library/react";
import { vi } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import { useLandingPromptStashDestination } from "@/components/home/composer/use-landing-prompt-stash-adapters";
import {
  deleteImage,
  imageHashKeys,
  putImage,
  releaseSession,
} from "@/lib/composer/landing-image-store";
import * as landingImageStore from "@/lib/composer/landing-image-store";
import type {
  PromptStashDestinationAdapter,
  PromptStashDestinationIdentity,
  PromptStashDestinationResult,
} from "@/lib/composer/prompt-stash-destination";
import type {
  PromptStashEntry,
  PromptStashRestoreBlob,
} from "@/lib/composer/prompt-stash-codec";
import type { DraftSelection } from "@/stores/composer/composer-draft-store";
import type { DraftRuntimeState } from "@/stores/home/draft-runtime-registry";

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

export function bytesOf(values: readonly number[]): Uint8Array<ArrayBuffer> {
  return new Uint8Array(values);
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function imageDoc(attrs: Record<string, unknown>): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "imageAttachment", attrs }],
      },
    ],
  };
}

export function multiImageDoc(
  nodes: ReadonlyArray<Record<string, unknown>>,
): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: nodes.map((attrs) => ({ type: "imageAttachment", attrs })),
      },
    ],
  };
}

export function makeEntry(args: {
  readonly content: JsonContent;
  readonly id: string;
  readonly blobHashes: readonly string[];
}): PromptStashEntry {
  return {
    id: args.id,
    createdAt: 1,
    content: args.content,
    blobHashes: args.blobHashes,
  };
}

export function requireDefined<T>(
  value: T | null | undefined,
  label: string,
): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label}`);
  }
  return value;
}

/** In-memory stash blobs for `readPromptStashRestoreBlobs` spy. */
export const stashBlobs = new Map<string, PromptStashRestoreBlob>();

export async function seedStashImage(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const hash = await sha256Hex(bytes);
  stashBlobs.set(hash, {
    bytes,
    byteLength: bytes.byteLength,
    mimeType: "image/png",
  });
  return hash;
}

/** Drive the real production landing destination hook. */
export function renderLandingDestination(args: {
  readonly stashIdentity: string;
  readonly draftId: string | null;
  readonly runtimeStore: StoreApi<DraftRuntimeState>;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
}) {
  return renderHook(() =>
    useLandingPromptStashDestination({
      stashIdentity: args.stashIdentity,
      draftId: args.draftId,
      runtimeStore: args.runtimeStore,
      editorRef: args.editorRef,
    }),
  );
}

/** Drive materialize → importAndInsert → release like the restore hook. */
export async function restoreThroughLanding(
  dest: PromptStashDestinationAdapter,
  identity: PromptStashDestinationIdentity,
  entry: PromptStashEntry,
): Promise<PromptStashDestinationResult | null> {
  const materialize = requireDefined(dest.materialize, "landing materialize");
  const materialized = await materialize(entry);
  if (materialized === null) return null;
  try {
    return await dest.importAndInsert({
      identity,
      content: materialized.content,
    });
  } finally {
    materialized.release?.();
  }
}

export function makeEditorHandle(options: {
  ready?: boolean;
  content?: JsonContent;
}): {
  readonly handle: ComposerPromptEditorHandle;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly setContents: Array<{
    content: JsonContent;
    selection: DraftSelection | null;
  }>;
  setReady: (ready: boolean) => void;
  unmount: () => void;
  remount: () => ComposerPromptEditorHandle;
} {
  let ready = options.ready ?? true;
  let content = options.content ?? emptyDoc();
  const setContents: Array<{
    content: JsonContent;
    selection: DraftSelection | null;
  }> = [];

  const buildHandle = (): ComposerPromptEditorHandle => ({
    isReady: () => ready,
    hasFocus: () => false,
    focus: () => undefined,
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => {
      content = emptyDoc();
    },
    setContent: (next, nextSelection) => {
      content = next;
      setContents.push({ content: next, selection: nextSelection });
    },
    syncContent: (next, nextSelection) => {
      content = next;
      setContents.push({ content: next, selection: nextSelection });
    },
    insertImageAttachments: () => undefined,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  });

  const handle = buildHandle();
  const editorRef: { current: ComposerPromptEditorHandle | null } = {
    current: handle,
  };

  return {
    handle,
    editorRef,
    setContents,
    setReady: (next) => {
      ready = next;
    },
    unmount: () => {
      editorRef.current = null;
    },
    remount: () => {
      ready = true;
      const next = buildHandle();
      editorRef.current = next;
      return next;
    },
  };
}

export function collectImageNodes(content: JsonContent): JsonContent[] {
  const found: JsonContent[] = [];
  const walk = (node: JsonContent): void => {
    if (node.type === "imageAttachment") {
      found.push(node);
      return;
    }
    if (!Array.isArray(node.content)) return;
    for (const child of node.content) {
      walk(child);
    }
  };
  walk(content);
  return found;
}

export async function drainLandingStore(): Promise<void> {
  for (const hash of await imageHashKeys()) {
    await deleteImage(hash);
    releaseSession(hash);
  }
}

export function holdPutImage(): {
  release: () => void;
  restore: () => void;
  waitedUntilHeld: () => Promise<void>;
} {
  let resolveHold: (() => void) | undefined;
  let resolveEntered: (() => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    resolveHold = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  const originalPut = putImage;
  const spy = vi
    .spyOn(landingImageStore, "putImage")
    .mockImplementation(async (bytes) => {
      resolveEntered?.();
      await hold;
      return originalPut(bytes);
    });
  return {
    release: () => {
      resolveHold?.();
    },
    restore: () => {
      spy.mockRestore();
    },
    waitedUntilHeld: () => entered,
  };
}

export function emptyRuntime(): DraftRuntimeState {
  return {
    content: emptyDoc(),
    selection: null,
    contentRevision: 0,
    attachmentRoots: new Set(),
    isSubmitting: false,
  };
}
