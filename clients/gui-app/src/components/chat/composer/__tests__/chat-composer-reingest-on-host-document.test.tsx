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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useCallback, useState } from "react";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DraftDocument } from "@traycer/protocol/host";
import type { ImageAttachmentRewrite } from "@/components/chat/composer/editor/extensions/image-attachment-extension";
import type { JsonContent } from "@traycer/protocol/common/registry";

import { useChatComposerDraft } from "../use-chat-composer-draft";
import { useComposerReingestOnReplacement } from "../use-composer-reingest-on-replacement";
import { ComposerPromptEditor } from "../composer-prompt-editor";
import type { ComposerPromptEditorHandle } from "../composer-prompt-editor";
import { createComposerPickerStore } from "../picker/composer-picker-store";
import { createFakeComposerPromptEditorHandle } from "./composer-prompt-editor-handle-fixtures";
import {
  applyComposerHostDocument,
  useComposerDraftStore,
} from "@/stores/composer/composer-draft-store";
import { useComposerPendingImageIngest } from "@/hooks/composer/use-composer-pending-image-ingest";
import { resetLandingImageBudgetReservationsForTesting } from "@/lib/composer/landing-image-budget";
import { installFreshIndexedDb } from "@/lib/composer/__tests__/fake-idb";

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
    // The ancestor a fork-only draft replaces (#1913). An ordinary host
    // document has none.
    supersedes: null,
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
    chatTitle: null,
    epicTitle: null,
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
    // The whole `ImageAttachmentRewrite`, not a bare hash: preparation can
    // change a node's `fileName`, `mimeType`, `size` and `byHashEligible`, so
    // what the rewrite installs is the description of the STORED bytes rather
    // than a new address for the pasted ones. A fake still typed `(id, hash)`
    // would accept this call by arity and silently stop matching the member it
    // stands in for.
    const rewriteImageAttachmentHashById = (
      _id: string,
      _rewrite: ImageAttachmentRewrite,
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

/**
 * The ON-CHANGE half of the same restart, at the three surfaces that own a
 * composer document.
 *
 * `reingestPendingImages` fires on editor readiness and on a host-document
 * replacement, and neither can see a node that does not exist yet.
 * `commitBrowserTabPreviewInsertion` appends a browser-preview screenshot
 * asynchronously, long after mount and through no paste - so without a caller
 * on the change handler that node travels inline until the next mount. The
 * hook's `noteContentImages` is edge-triggered per node id for the life of the
 * mount, which is what makes a per-keystroke caller cost one scan; that
 * guard's own "exactly once" is pinned in the hook's suite, with a counted
 * `runPendingImageJob`. What is pinned HERE is the thing that suite cannot
 * see: that each surface actually calls it, from the handler the editor is
 * actually given.
 *
 * SOURCE-LEVEL, and this file is its own argument for why. Its docblock above
 * records that its first version restated the effect body in the harness and
 * "stayed green with `chat-composer.tsx`'s effect deleted" - a harness that
 * called `noteContentImages` itself would repeat exactly that mistake one
 * layer down, since the harness is a stand-in for the component and the claim
 * IS about the component. Rendering three full composer trees to observe one
 * call is the cost this codebase's composer tests explicitly avoid.
 *
 * The second assertion per surface is the load-bearing one. `chat-composer.tsx`
 * has TWO change handlers - an inner one and the wrapper that also notes the
 * authority edit - and only the wrapper is handed to the editor. A call placed
 * in the inner one type-checks, reads correctly, and never runs.
 *
 * NOT asserted here: `landing-composer.tsx`, which has the identical hook
 * shape and is deliberately left unwired. Its picker is built with
 * `currentEpicId: null`, and browser-tab mention rows need a resolved chat host
 * and an epic-scoped source, so `commitBrowserTabPreviewInsertion` is not
 * reachable from it. That is an inference from the gating, not a proof, and it
 * is the one thing that would make this a four-surface claim if it changed.
 */
// `chat-composer.tsx` and `chat-message-user-body.tsx` receive the editor's
// third `onDocumentChange` argument (`changedImages`) and call
// `noteContentImages` only when it is non-null - see `composer-image-changes.ts`.
// `new-conversation-modal.tsx` is deliberately unchanged and still scans the
// whole `content` on every change (ticket W2-F left it out of scope).
const ON_CHANGE_SURFACES = [
  {
    path: "src/components/chat/composer/chat-composer.tsx",
    handler: "handleDocumentChangeNotingEdit",
    expectedCall: "noteContentImages(changedImages)",
  },
  {
    path: "src/components/epic-canvas/sidebar/new-conversation-modal.tsx",
    handler: "handleDocumentChange",
    expectedCall: "noteContentImages(content)",
  },
  {
    path: "src/components/chat/chat-message-user-body.tsx",
    handler: "onDocumentChange",
    expectedCall: "noteContentImages(changedImages)",
  },
] as const;

function surfaceSource(relativePath: string): string {
  return readFileSync(
    join(import.meta.dirname, "..", "..", "..", "..", "..", relativePath),
    "utf8",
  );
}

/**
 * The body of a top-level `useCallback` handler, from its declaration to the
 * `\n  );` that closes it. Every one of these is a component-level const at two
 * spaces, so the close is unambiguous without parsing.
 */
function changeHandlerBody(source: string, handlerName: string): string {
  const start = source.indexOf(`const ${handlerName} = useCallback(`);
  if (start === -1) throw new Error(`no ${handlerName} declaration`);
  const end = source.indexOf("\n  );", start);
  if (end === -1) throw new Error(`unterminated ${handlerName}`);
  return source.slice(start, end);
}

describe("a b64 node appended after mount is re-ingested, because each surface notes its content changes", () => {
  for (const surface of ON_CHANGE_SURFACES) {
    it(`${surface.path} calls noteContentImages from the handler the editor is given`, () => {
      const source = surfaceSource(surface.path);
      expect(changeHandlerBody(source, surface.handler)).toContain(
        surface.expectedCall,
      );
      expect(source).toContain(`onDocumentChange={${surface.handler}}`);
    });
  }
});

/**
 * The source check above proves each surface's real wrapper is wired to
 * `onDocumentChange` and calls `noteContentImages` guarded on `changedImages`.
 * It cannot prove the VALUE that guard receives is right - that a document
 * already carrying one image, plus a freshly inserted second one, produces a
 * `changedImages` containing only the new node, and that handing exactly that
 * into the real `noteContentImages` still starts the real ingest job for it.
 * This mounts the real `ComposerPromptEditor` beside the real
 * `useComposerPendingImageIngest` (as `chat-composer.tsx` does) rather than
 * restating either side's logic.
 */
describe("changedImages end to end: what the editor emits is what the real ingest hook consumes", () => {
  function b64PngAttrs(id: string) {
    return {
      id,
      fileName: `${id}.png`,
      b64content: b64Of(`${id}-bytes`),
      mimeType: "image/png",
      size: 10,
    };
  }

  // `imageAttachment` is an INLINE node - it must sit inside a paragraph, not
  // as a direct child of `doc`. `docWithInlinePng` above is fed only to the
  // FAKE handle in the F4 suite, which never validates against the real
  // schema; this suite mounts a REAL editor, which does.
  function inlinePngParagraphDoc(id: string, b64content: string): JsonContent {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
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
        },
      ],
    };
  }

  it("ingests only the newly inserted image, leaving an untouched existing one alone", async () => {
    const editorRef: { current: ComposerPromptEditorHandle | null } = {
      current: null,
    };
    let rewriteCallCount = 0;
    const rewrittenIds: string[] = [];
    const rewriteImageAttachmentHashById = (
      id: string,
      _rewrite: ImageAttachmentRewrite,
    ): boolean => {
      rewriteCallCount += 1;
      rewrittenIds.push(id);
      return true;
    };

    function Harness() {
      const [pickerStore] = useState(() => createComposerPickerStore());
      const { noteContentImages } = useComposerPendingImageIngest({
        editorRef,
        runPendingImageJob: immediateRunPendingImageJob,
        draftId: null,
      });
      return (
        <ComposerPromptEditor
          ref={(instance) => {
            if (instance === null) {
              editorRef.current = null;
              return;
            }
            editorRef.current = { ...instance, rewriteImageAttachmentHashById };
          }}
          initialContent={inlinePngParagraphDoc(
            "already-ingested",
            b64Of("already-ingested-bytes"),
          )}
          initialSelection={null}
          pickerStore={pickerStore}
          placeholder="test"
          editorClassName={undefined}
          isActive={false}
          disabled={false}
          slashProviderId="claude"
          hasPastedImageBytes={null}
          ingestPastedComposerImages={null}
          stabilizeImageAttachmentCaret={false}
          onDocumentChange={(_content, _selection, changedImages) => {
            if (changedImages !== null) noteContentImages(changedImages);
          }}
          onSelectionChange={() => undefined}
          onSubmit={() => undefined}
          onPaste={() => undefined}
          onDragOver={() => undefined}
          onDrop={() => undefined}
          onKeyDown={undefined}
          onFocus={() => undefined}
          onBlur={() => undefined}
          onEditorReady={null}
        />
      );
    }

    render(<Harness />);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // This harness deliberately does not wire the mount-time restart (that
    // path is the F4 suite above) - only the on-change path is under test,
    // so nothing has touched the pre-existing "already-ingested" node yet.
    act(() => {
      editorRef.current?.focusAtEnd();
    });
    act(() => {
      editorRef.current?.insertImageAttachments([
        {
          ...b64PngAttrs("just-inserted"),
          byHashEligible: false,
        },
      ]);
    });

    await waitFor(() => {
      expect(rewriteCallCount).toBe(1);
    });
    expect(rewrittenIds).toEqual(["just-inserted"]);
  });
});
