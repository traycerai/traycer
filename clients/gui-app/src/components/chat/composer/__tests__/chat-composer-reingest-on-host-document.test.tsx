/**
 * F4: the re-ingest-on-replacement restart, driven through the PRODUCTION hook
 * `useComposerReingestOnReplacement` - the same call `chat-composer.tsx` makes.
 *
 * Readiness alone is not enough. Open a chat before its remote draft arrives
 * and the editor becomes ready on an EMPTY document; `reingestPendingImages` at
 * that point finds nothing. `applyComposerHostDocument` later bumps
 * `resetEpoch` and `useChatComposerDraft`'s own reset bridge installs the
 * document via `syncContent`, which deliberately emits no document-change
 * callback - so readiness never fires again on its own. A legacy inline image
 * arriving that way started no rewrite job at all.
 *
 * The first version of this file re-declared the effect body inside its own
 * harness. That proved only that the COPY worked: it stayed green with
 * `chat-composer.tsx`'s effect deleted, and it had already drifted by a key
 * (epoch-only, where production keys the editor-instance/epoch PAIR). The
 * effect is a real exported hook now, and this calls it.
 *
 * What is still a stand-in, and deliberately: the surrounding component. The
 * hook is mounted beside the REAL `useChatComposerDraft` (so the real reset
 * bridge installs the replacement before the hook's effect runs, in the same
 * commit) and the REAL `useComposerPendingImageIngest`, rather than inside a
 * full `ChatComposer` tree - the cost this codebase's own composer tests
 * explicitly avoid (see chat-composer-submit-gate.test.tsx's docstring). The
 * ORDER of those two calls mirrors chat-composer.tsx and is load-bearing.
 */
import { useCallback, useState } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerDraft } from "../use-chat-composer-draft";
import { useComposerReingestOnReplacement } from "../use-composer-reingest-on-replacement";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createFakeComposerPromptEditorHandle } from "./composer-prompt-editor-handle-fixtures";
import {
  applyComposerHostDocument,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { useComposerPendingImageIngest } from "@/hooks/composer/use-composer-pending-image-ingest";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/prompt-stash-fake-idb";

const EMPTY_DOC: JsonContent = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

function b64Of(text: string): string {
  return btoa(text);
}

function docWithInlinePng(id: string, b64content: string): JsonContent {
  return {
    type: "doc",
    content: [
      {
        type: "imageAttachment",
        attrs: {
          id,
          fileName: `${id}.png`,
          b64content,
          mimeType: "image/png",
          size: b64content.length,
        },
      },
    ],
  };
}

function hostDocument(input: {
  readonly chatId: string;
  readonly revision: number;
  readonly content: JsonContent;
}): DraftDocument {
  return {
    draftId: "draft-1",
    kind: "chat-composer",
    target: { epicId: "epic-1", chatId: input.chatId, blockId: null },
    revision: input.revision,
    lastTouchedAt: 1,
    workspace: null,
    ownerHostId: "host-1",
    origin: "own",
    adoption: { state: "adopted", hostId: "host-1" },
    publication: {
      status: "unpublished",
      lastPublishedAt: null,
      publishedRevision: null,
      halted: null,
    },
    portable: {
      content: input.content,
      selection: null,
      runSettings: null,
      composerMode: "chat",
      blobHashes: [],
      closed: false,
    },
  };
}

/** Runs the job immediately, with a signal that never aborts. */
function immediateRunPendingImageJob(
  job: (signal: AbortSignal) => Promise<void>,
): void {
  void job(new AbortController().signal);
}

interface HarnessProps {
  readonly chatId: string;
  readonly editorRef: { current: ComposerPromptEditorHandle | null };
  readonly editorReadyTick: number;
}

/**
 * Mounts the production hook in the same order `chat-composer.tsx` does:
 * `useChatComposerDraft` first, then `useComposerPendingImageIngest`, then
 * `useComposerReingestOnReplacement`. The effect body itself is NOT restated
 * here - that is the whole point of this file's second version.
 */
function useReingestOnReplacementHarness(props: HarnessProps): {
  readonly reingestCalls: number;
} {
  useChatComposerDraft({
    chatId: props.chatId,
    epicId: "epic-1",
    hostId: "host-1",
    editorRef: props.editorRef,
    editorReadyTick: props.editorReadyTick,
  });
  const { reingestPendingImages } = useComposerPendingImageIngest({
    editorRef: props.editorRef,
    runPendingImageJob: immediateRunPendingImageJob,
    draftId: null,
  });
  // `useState`, not a bare ref: the render this setter triggers is what lets
  // the test observe the count through `result.current` at all - a ref mutated
  // only inside the effect is invisible to the render that already returned.
  const [reingestCalls, setReingestCalls] = useState(0);
  // Counting WRAPPER around the real restart, passed into the real hook. The
  // hook decides whether and when to call it; this only records that it did.
  const countedReingest = useCallback(() => {
    setReingestCalls((count) => count + 1);
    reingestPendingImages();
  }, [reingestPendingImages]);
  useComposerReingestOnReplacement({
    chatId: props.chatId,
    editorReadyTick: props.editorReadyTick,
    reingestPendingImages: countedReingest,
  });
  return { reingestCalls };
}

beforeEach(() => {
  installFreshIndexedDb();
  resetLandingImageBudgetReservationsForTesting();
});

afterEach(() => {
  cleanup();
  useComposerDraftStore.setState({ drafts: {} });
});

describe("F4: re-ingest re-fires on a host-document replacement, not just editor readiness", () => {
  it("editor ready on an EMPTY document, then a host replacement carrying an inline storable image - the rewrite runs", async () => {
    // Pre-fix (e1bdceff5): only `editorReadyTick` re-ran `reingestPendingImages`.
    // The editor here becomes ready on an empty document (no pending node to
    // find), and the host draft lands AFTERWARDS via `syncContent`, which
    // emits no document-change callback - so nothing re-triggers the restart,
    // and a legacy inline image arriving this way is never rewritten.
    const chatId = "chat-f4-1";
    const fixture = createFakeComposerPromptEditorHandle({
      ready: true,
      content: EMPTY_DOC,
      selection: null,
      isEmpty: true,
      onFocus: null,
      onClear: null,
    });
    let rewriteCallCount = 0;
    const rewriteImageAttachmentHashById = (
      _id: string,
      _hash: string,
    ): boolean => {
      rewriteCallCount += 1;
      return true;
    };
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: { ...fixture.handle, rewriteImageAttachmentHashById },
    };

    const { result, rerender } = renderHook(
      (props: HarnessProps) => useReingestOnReplacementHarness(props),
      {
        initialProps: {
          chatId,
          editorRef,
          editorReadyTick: 1,
        } satisfies HarnessProps,
      },
    );

    // Nothing to rewrite yet - the editor is ready on an empty document.
    expect(result.current.reingestCalls).toBe(1);

    // The host draft lands: a replacement carrying an inline, storable PNG.
    act(() => {
      applyComposerHostDocument(
        hostDocument({
          chatId,
          revision: 1,
          content: docWithInlinePng("legacy-1", b64Of("legacy-bytes")),
        }),
      );
    });
    rerender({ chatId, editorRef, editorReadyTick: 1 });

    expect(result.current.reingestCalls).toBe(2);
    // Let the background job's real (fake-indexeddb-backed) store write
    // settle - real timers, no fake-timer/IDB interaction to work around.
    await waitFor(() => {
      expect(rewriteCallCount).toBe(1);
    });
  });

  it("runs the restart exactly ONCE per replacement - a re-render at the same epoch does not restart it again", async () => {
    const chatId = "chat-f4-2";
    const fixture = createFakeComposerPromptEditorHandle({
      ready: true,
      content: EMPTY_DOC,
      selection: null,
      isEmpty: true,
      onFocus: null,
      onClear: null,
    });
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: fixture.handle,
    };

    const { result, rerender } = renderHook(
      (props: HarnessProps) => useReingestOnReplacementHarness(props),
      {
        initialProps: {
          chatId,
          editorRef,
          editorReadyTick: 1,
        } satisfies HarnessProps,
      },
    );
    expect(result.current.reingestCalls).toBe(1);

    act(() => {
      applyComposerHostDocument(
        hostDocument({
          chatId,
          revision: 1,
          content: docWithInlinePng("legacy-2", b64Of("legacy-bytes-2")),
        }),
      );
    });
    rerender({ chatId, editorRef, editorReadyTick: 1 });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.reingestCalls).toBe(2);

    // A re-render at the SAME epoch (nothing bumped resetEpoch this time)
    // must not restart the job again.
    rerender({ chatId, editorRef, editorReadyTick: 1 });
    rerender({ chatId, editorRef, editorReadyTick: 1 });
    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.reingestCalls).toBe(2);
  });
});
