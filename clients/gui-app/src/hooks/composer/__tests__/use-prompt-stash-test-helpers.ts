/**
 * Shared fixtures for use-prompt-stash split suites.
 */
import { vi, type Mock } from "vitest";
import type { JsonContent } from "@traycer/protocol/common/registry";
import type { RefObject } from "react";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";
import {
  createComposerEditorIncarnation,
  type ComposerEditorIncarnation,
} from "@/lib/composer/composer-editor-incarnation";
import { appendPromptStashContent } from "@/lib/composer/prompt-stash-content";
import type {
  PromptStashDestinationAdapter,
  PromptStashDestinationIdentity,
  PromptStashDestinationResult,
} from "@/lib/composer/prompt-stash-destination";
import type {
  PromptStashSourceAdapter,
  PromptStashSourceSnapshot,
  PromptStashSurface,
  PromptStashSourceToken,
} from "@/lib/composer/prompt-stash-source";
import type { KeybindingRouter } from "@/lib/keybindings/dispatch";

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

export function makeEditorIncarnation(): ComposerEditorIncarnation {
  return createComposerEditorIncarnation();
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

export interface MutableSource extends PromptStashSourceAdapter {
  readonly capture: Mock<PromptStashSourceAdapter["capture"]>;
  readonly clearIfUnchanged: Mock<PromptStashSourceAdapter["clearIfUnchanged"]>;
  setRevision: (revision: number) => void;
  setContent: (content: JsonContent) => void;
  getRevision: () => number;
  getIdentity: () => string;
}

/**
 * Controllable fake adapter for hook-level tests. `clearIfUnchanged` defaults
 * to a real CAS against the live revision so race tests can bump it mid-save.
 */
export function makeSource(
  options:
    | {
        content?: JsonContent;
        revision?: number;
        identity?: string;
        surface?: PromptStashSurface;
        clearIfUnchanged?: (token: PromptStashSourceToken) => boolean;
      }
    | undefined,
): MutableSource {
  let content = options?.content ?? textDoc("stash me");
  let revision = options?.revision ?? 1;
  const identity = options?.identity ?? "test";
  const surface = options?.surface ?? "test";

  const capture: Mock<PromptStashSourceAdapter["capture"]> = vi.fn(
    (): PromptStashSourceSnapshot | null => ({
      content,
      token: { surface, identity, revision },
    }),
  );

  const clearIfUnchanged: Mock<PromptStashSourceAdapter["clearIfUnchanged"]> =
    vi.fn((token: PromptStashSourceToken): boolean => {
      if (options?.clearIfUnchanged !== undefined) {
        return options.clearIfUnchanged(token);
      }
      return (
        token.surface === surface &&
        token.identity === identity &&
        token.revision === revision
      );
    });

  return {
    capture,
    clearIfUnchanged,
    setRevision: (next) => {
      revision = next;
    },
    setContent: (next) => {
      content = next;
    },
    getRevision: () => revision,
    getIdentity: () => identity,
  };
}

export interface InsertedPayload {
  readonly identity: PromptStashDestinationIdentity;
  readonly content: JsonContent;
}

export interface MutableDestination extends PromptStashDestinationAdapter {
  readonly captureIdentity: Mock<
    PromptStashDestinationAdapter["captureIdentity"]
  >;
  readonly importAndInsert: Mock<
    PromptStashDestinationAdapter["importAndInsert"]
  >;
  readonly materialize:
    | Mock<NonNullable<PromptStashDestinationAdapter["materialize"]>>
    | undefined;
  setIdentity: (identity: string | null) => void;
  setSurface: (surface: string) => void;
  /**
   * Replaces the ready editor incarnation token (simulates remount under the
   * same owner id). Import against a previously captured incarnation is stale.
   */
  setEditorIncarnation: (incarnation: ComposerEditorIncarnation) => void;
  getEditorIncarnation: () => ComposerEditorIncarnation;
  setLatestContent: (content: JsonContent) => void;
  getLatestContent: () => JsonContent;
  getInserts: () => readonly InsertedPayload[];
}

/**
 * Controllable destination for Ticket 2/3. Default path mirrors production
 * chat/modal adapters: surface + identity + same editor incarnation, append
 * against latest content, and place the caret at the end. Materialization
 * defaults to the hook's `materializePromptStashEntry` unless `materialize`
 * is passed.
 */
export function makeDestination(
  options:
    | {
        surface?: string;
        identity?: string | null;
        editorIncarnation?: ComposerEditorIncarnation;
        latestContent?: JsonContent;
        importResult?: PromptStashDestinationResult;
        importAndInsert?: PromptStashDestinationAdapter["importAndInsert"];
        materialize?: NonNullable<PromptStashDestinationAdapter["materialize"]>;
      }
    | undefined,
): MutableDestination {
  let surface = options?.surface ?? "test";
  let identity: string | null =
    options?.identity === undefined ? "dest-1" : options.identity;
  let editorIncarnation: ComposerEditorIncarnation =
    options?.editorIncarnation ?? makeEditorIncarnation();
  let latestContent = options?.latestContent ?? emptyDoc();
  const inserts: InsertedPayload[] = [];

  const captureIdentity: Mock<
    PromptStashDestinationAdapter["captureIdentity"]
  > = vi.fn((): PromptStashDestinationIdentity | null => {
    if (identity === null) return null;
    return { surface, identity, editorIncarnation };
  });

  const defaultImport: PromptStashDestinationAdapter["importAndInsert"] = (
    args,
  ) => {
    if (options?.importResult !== undefined) {
      if (options.importResult.status === "accepted") {
        inserts.push({
          identity: args.identity,
          content: args.content,
        });
        const nextContent = appendPromptStashContent(
          latestContent,
          args.content,
        );
        latestContent = nextContent;
      }
      return Promise.resolve(options.importResult);
    }
    if (
      identity === null ||
      args.identity.surface !== surface ||
      args.identity.identity !== identity ||
      args.identity.editorIncarnation !== editorIncarnation
    ) {
      return Promise.resolve({ status: "stale" });
    }
    const nextContent = appendPromptStashContent(latestContent, args.content);
    latestContent = nextContent;
    inserts.push({
      identity: args.identity,
      content: args.content,
    });
    return Promise.resolve({ status: "accepted" });
  };

  const importAndInsert: Mock<
    PromptStashDestinationAdapter["importAndInsert"]
  > = vi.fn(options?.importAndInsert ?? defaultImport);

  const materialize =
    options?.materialize === undefined ? undefined : vi.fn(options.materialize);

  return {
    captureIdentity,
    importAndInsert,
    materialize,
    setIdentity: (next) => {
      identity = next;
    },
    setSurface: (next) => {
      surface = next;
    },
    setEditorIncarnation: (next) => {
      editorIncarnation = next;
    },
    getEditorIncarnation: () => editorIncarnation,
    setLatestContent: (next) => {
      latestContent = next;
    },
    getLatestContent: () => latestContent,
    getInserts: () => inserts,
  };
}

export function makeEditor(initial: {
  content: JsonContent;
  ready?: boolean;
}): {
  readonly handle: ComposerPromptEditorHandle;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
  readonly clears: number[];
  readonly focuses: number[];
  setContent: (content: JsonContent) => void;
} {
  let content = initial.content;
  const ready = initial.ready ?? true;
  const clears: number[] = [];
  const focuses: number[] = [];
  const editorIncarnation = makeEditorIncarnation();

  const handle: ComposerPromptEditorHandle = {
    isReady: () => ready,
    getEditorIncarnation: () => (ready ? editorIncarnation : null),
    hasFocus: () => false,
    focus: () => {
      focuses.push(1);
    },
    focusAtEnd: () => undefined,
    getJSON: () => content,
    isEmpty: () => false,
    clear: () => {
      clears.push(1);
      content = emptyDoc();
    },
    setContent: (next) => {
      content = next;
    },
    syncContent: (next) => {
      content = next;
    },
    insertImageAttachments: () => undefined,
    insertMentionAttachment: () => false,
    beginPathInsertion: () => null,
    removeImageAttachmentById: () => undefined,
    rewriteImageAttachmentHashById: () => false,
    insertDictatedText: () => undefined,
    dismissActiveSuggestion: () => false,
  };

  return {
    handle,
    editorRef: { current: handle },
    clears,
    focuses,
    setContent: (next) => {
      content = next;
    },
  };
}

export function noopRouter(): KeybindingRouter {
  return {
    getPathname: () => "/",
    navigateHome: () => undefined,
    navigateSettings: () => undefined,
    navigateToEpic: () => undefined,
    navigateToEpicTab: () => undefined,
    navigateToEpicList: () => undefined,
    navigateSettingsSection: () => undefined,
    navigateToTabIntent: () => undefined,
    goBack: () => undefined,
    goForward: () => undefined,
    isHistoryNavAvailable: () => false,
    canGoBack: () => false,
    canGoForward: () => false,
  };
}

export function hookArgs(partial: {
  editorRef: RefObject<ComposerPromptEditorHandle | null>;
  source?: PromptStashSourceAdapter;
  destination: PromptStashDestinationAdapter;
  active?: boolean;
  disabled?: boolean;
  readHashImage?: (hash: string) => Promise<Uint8Array<ArrayBuffer> | null>;
}) {
  return {
    active: partial.active ?? true,
    disabled: partial.disabled ?? false,
    editorRef: partial.editorRef,
    readHashImage: partial.readHashImage ?? (() => Promise.resolve(null)),
    source: partial.source ?? makeSource({ content: emptyDoc() }),
    destination: partial.destination,
  };
}
