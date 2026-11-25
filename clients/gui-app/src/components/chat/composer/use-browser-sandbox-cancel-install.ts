import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import type { ComposerPromptEditorHandle } from "./composer-prompt-editor";
import { isEmptyLandingDraftContent } from "@/lib/composer/landing-draft-empty";
import { normalizeComposerContentWithSelection } from "@/lib/composer/composer-content-normalizer";
import {
  draftAuthorityActorIsCurrent,
  subscribeToDraftAuthoritySessionChanges,
} from "@/lib/drafts/draft-authority-session";
import { putImageBytesAtHash, sessionImageBytes } from "@/lib/composer/landing-image-store";
import {
  useBrowserSandboxCancelComposerBinding,
  type BrowserSandboxCancelInstallation,
  type BrowserSandboxCancelPress,
  type BrowserSandboxCancelSnapshot,
} from "@/lib/sandboxes/browser-sandbox-cancel-composer";
import {
  readComposerDraftSnapshot,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";

export interface BrowserSandboxCancelPreview {
  readonly snapshot: BrowserSandboxCancelSnapshot;
  readonly urls: ReadonlyMap<string, string>;
}

interface ProvisionalInstall extends BrowserSandboxCancelPreview {
  readonly sendId: string;
  readonly press: BrowserSandboxCancelPress;
  readonly editor: ComposerPromptEditorHandle;
  readonly wasEmptyCurrent: () => boolean;
  readonly baseIsCurrent: () => boolean;
  readonly resolve: (installation: BrowserSandboxCancelInstallation | null) => void;
  readonly committed: Promise<BrowserSandboxCancelInstallation | null>;
  documentGeneration: number | null;
}

export function useBrowserSandboxCancelInstall(input: {
  readonly active: boolean;
  readonly chatId: string;
  readonly hostId: string;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}) {
  const { active, chatId, hostId, editorRef } = input;
  const bind = useBrowserSandboxCancelComposerBinding();
  const cardsRef = useRef<HTMLDivElement | null>(null);
  const provisional = useRef<ProvisionalInstall | null>(null);
  const [preview, setPreview] = useState<ProvisionalInstall | null>(null);

  const finishLocalInstall = useCallback((install: ProvisionalInstall, commit: boolean): number | null => {
    if (provisional.current !== install) return null;
    provisional.current = null;
    setPreview(null);
    const sameEditor = editorRef.current === install.editor;
    if (commit && sameEditor) {
      const store = useComposerDraftStore.getState();
      store.setSnapshot(chatId, install.snapshot.content, null);
      store.restoreBrowserAnnotations(chatId, install.snapshot.browserAnnotations);
    } else if (sameEditor && install.documentGeneration !== null &&
               install.editor.draftGeneration() === install.documentGeneration) {
      const current = readComposerDraftSnapshot(chatId);
      install.editor.syncContent(current.content, current.selection);
    }
    for (const url of install.urls.values()) URL.revokeObjectURL(url);
    return commit && sameEditor ? readComposerDraftSnapshot(chatId).revision : null;
  }, [chatId, editorRef]);

  useLayoutEffect(() => {
    if (bind === null || !active) return;
    let mounted = true;
    const unregister = bind(({ actor, sendId, chatId: requestedChatId, hostId: requestedHostId }) => {
      if (requestedChatId !== chatId || requestedHostId !== hostId ||
          !draftAuthorityActorIsCurrent(actor)) return null;
      const previous = provisional.current;
      if (previous !== null)
        return previous.sendId === sendId && previous.baseIsCurrent() ? previous.press : null;

      const editor = editorRef.current;
      const incarnation = editor?.getEditorIncarnation() ?? null;
      const before = readComposerDraftSnapshot(chatId);
      if (editor === null || incarnation === null || !editor.isEmpty() ||
          !isEmptyLandingDraftContent(before.content) || before.browserAnnotations.length !== 0)
        return null;
      const generation = editor.draftGeneration();
      const baseIsCurrent = (): boolean => {
        const live = readComposerDraftSnapshot(chatId);
        return mounted && draftAuthorityActorIsCurrent(actor) &&
          editorRef.current === editor && editor.getEditorIncarnation() === incarnation &&
          live.revision === before.revision && live.resetEpoch === before.resetEpoch;
      };
      const wasEmptyCurrent = (): boolean =>
        baseIsCurrent() && editor.draftGeneration() === generation && editor.isEmpty();
      const press: BrowserSandboxCancelPress = {
        isCurrent: () => {
          const install = provisional.current;
          return install?.press === press
            ? baseIsCurrent() && (install.documentGeneration === null
              ? wasEmptyCurrent()
              : editor.draftGeneration() === install.documentGeneration)
            : wasEmptyCurrent();
        },
        install: (snapshot) => {
          const install = provisional.current;
          if (install !== null)
            return install.press === press &&
              install.snapshot.returnId === snapshot.returnId &&
              install.snapshot.generation === snapshot.generation
              ? install.committed
              : Promise.resolve(null);
          if (!wasEmptyCurrent()) return Promise.resolve(null);
          const urls = new Map<string, string>();
          try {
            for (const [digest, blob] of snapshot.bytes)
              urls.set(digest, URL.createObjectURL(blob));
          } catch {
            for (const url of urls.values()) URL.revokeObjectURL(url);
            return Promise.resolve(null);
          }
          const { promise, resolve } = Promise.withResolvers<BrowserSandboxCancelInstallation | null>();
          const next: ProvisionalInstall = {
            sendId, press, editor, snapshot, urls, wasEmptyCurrent, baseIsCurrent, resolve,
            committed: promise,
            documentGeneration: null,
          };
          provisional.current = next;
          setPreview(next);
          return promise;
        },
      };
      return press;
    });

    const rollback = (): void => {
      const install = provisional.current;
      if (install === null) return;
      finishLocalInstall(install, false);
      install.resolve(null);
    };
    const stopSession = subscribeToDraftAuthoritySessionChanges(rollback);
    return () => {
      mounted = false;
      unregister();
      stopSession();
      rollback();
    };
  }, [active, bind, chatId, editorRef, finishLocalInstall, hostId]);

  useLayoutEffect(() => {
    if (preview === null || provisional.current !== preview ||
        preview.documentGeneration !== null) return;
    const content = (value: BrowserSandboxCancelSnapshot["content"]): string =>
      JSON.stringify(normalizeComposerContentWithSelection(value, null).content);
    const isCurrent = (): boolean => {
      if (provisional.current !== preview || !preview.baseIsCurrent() ||
          preview.editor.draftGeneration() !== preview.documentGeneration ||
          content(preview.editor.getJSON()) !== content(preview.snapshot.content)) return false;
      const cards = cardsRef.current?.querySelectorAll<HTMLElement>("[data-annotation-id]");
      if (cards === undefined || cards.length !== preview.snapshot.browserAnnotations.length)
        return false;
      return preview.snapshot.browserAnnotations.every((annotation, index) => {
        const card = cards[index];
        if (card?.dataset.annotationId !== annotation.annotationId) return false;
        if (annotation.imageHash === null) return true;
        const url = preview.urls.get(annotation.imageHash);
        return url !== undefined && card.querySelector("img")?.getAttribute("src") === url;
      });
    };
    if (preview.wasEmptyCurrent()) {
      try {
        preview.editor.syncContent(preview.snapshot.content, null);
      } catch {
        preview.documentGeneration = preview.editor.draftGeneration();
        finishLocalInstall(preview, false);
        preview.resolve(null);
        return;
      }
      preview.documentGeneration = preview.editor.draftGeneration();
    }
    if (!isCurrent()) {
      finishLocalInstall(preview, false);
      preview.resolve(null);
      return;
    }
    preview.resolve({
      expectedChat: preview.snapshot.expectedChat,
      isCurrent,
      finish: async (outcome) => {
        if (outcome === "fallback" || !isCurrent())
          return finishLocalInstall(preview, false);
        for (const [digest, blob] of preview.snapshot.bytes) {
          if (sessionImageBytes(digest) !== null) continue;
          const buffer = await blob.arrayBuffer().catch(() => null);
          if (!isCurrent()) return finishLocalInstall(preview, false);
          if (buffer !== null)
            await putImageBytesAtHash(digest, new Uint8Array(buffer)).catch(() => false);
        }
        return finishLocalInstall(preview, isCurrent());
      },
    });
  }, [finishLocalInstall, preview]);

  const permitsOrdinaryWrites = useCallback((): boolean => provisional.current === null, []);
  return { preview, cardsRef, permitsOrdinaryWrites };
}
