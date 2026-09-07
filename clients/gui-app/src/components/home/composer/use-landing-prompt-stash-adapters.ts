import { useMemo, type RefObject } from "react";
import type { StoreApi } from "zustand/vanilla";

import { appendPromptStashContent } from "@/lib/composer/prompt-stash-content";
import type {
  PromptStashDestinationAdapter,
  PromptStashDestinationIdentity,
  PromptStashMaterializedContent,
} from "@/lib/composer/prompt-stash-destination";
import type { PromptStashEntry } from "@/lib/composer/prompt-stash-codec";
import type { PromptStashSourceAdapter } from "@/lib/composer/prompt-stash-source";
import { importPromptStashContentToLanding } from "@/lib/composer/landing-stash-import";
import {
  draftRuntimeRegistry,
  EMPTY_DRAFT_RUNTIME_CONTENT,
  type DraftRuntimeState,
} from "@/stores/home/draft-runtime-registry";

import type { ComposerPromptEditorHandle } from "@/components/chat/composer/composer-prompt-editor";

/** Reusing one identity across that transition would let a stale unbound-phase token coincidentally match an
 * unrelated later bound revision - a false "unchanged" that clears newer content. */
export function landingStashIdentity(
  draftId: string | null,
  pendingCreateId: string | null,
): string {
  return draftId ?? `landing-unbound:${pendingCreateId ?? "none"}`;
}

/** The bound fallback resolves the canonical runtime fresh from the registry by `draftId` at clear time rather
 * than accepting a captured instance. */
export function useLandingPromptStashSource(args: {
  readonly stashIdentity: string;
  readonly runtimeStore: StoreApi<DraftRuntimeState>;
  /** `null` while still in the unbound phase. */
  readonly draftId: string | null;
  readonly unboundRuntime: StoreApi<DraftRuntimeState>;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}): PromptStashSourceAdapter {
  const { stashIdentity, runtimeStore, draftId, unboundRuntime, editorRef } =
    args;
  return useMemo<PromptStashSourceAdapter>(
    () => ({
      capture: () => {
        const state = runtimeStore.getState();
        return {
          content: state.content,
          token: {
            surface: "landing",
            identity: stashIdentity,
            revision: state.contentRevision,
          },
        };
      },
      clearIfUnchanged: (token) => {
        if (token.surface !== "landing" || token.identity !== stashIdentity) {
          return false;
        }
        if (runtimeStore.getState().contentRevision !== token.revision) {
          return false;
        }
        let canonicalRuntime = null;
        if (draftId !== null) {
          canonicalRuntime = draftRuntimeRegistry.getOrHydrate(draftId);
          if (
            canonicalRuntime === null ||
            canonicalRuntime.store !== runtimeStore
          ) {
            return false;
          }
        }
        const handle = editorRef.current;
        if (handle !== null && handle.isReady()) {
          handle.clear();
          return true;
        }
        if (draftId !== null) {
          if (canonicalRuntime === null) return false;
          canonicalRuntime.setSnapshot(EMPTY_DRAFT_RUNTIME_CONTENT, null);
          return true;
        }
        unboundRuntime.setState((current) => ({
          content: EMPTY_DRAFT_RUNTIME_CONTENT,
          selection: null,
          contentRevision: current.contentRevision + 1,
          attachmentRoots: new Set<string>(),
        }));
        return true;
      },
    }),
    [draftId, editorRef, runtimeStore, stashIdentity, unboundRuntime],
  );
}

/** `importAndInsert` requires the exact ready editor incarnation captured at restore start and appends against
 * the runtime's latest content, resetting selection so the caret lands after the inserted prompt. */
export function useLandingPromptStashDestination(args: {
  readonly stashIdentity: string;
  readonly draftId: string | null;
  readonly runtimeStore: StoreApi<DraftRuntimeState>;
  readonly editorRef: RefObject<ComposerPromptEditorHandle | null>;
}): PromptStashDestinationAdapter {
  const { stashIdentity, draftId, runtimeStore, editorRef } = args;
  return useMemo<PromptStashDestinationAdapter>(
    () => ({
      captureIdentity: (): PromptStashDestinationIdentity | null => {
        const handle = editorRef.current;
        if (handle === null || !handle.isReady()) return null;
        const editorIncarnation = handle.getEditorIncarnation();
        if (editorIncarnation === null) return null;
        return {
          surface: "landing",
          identity: stashIdentity,
          editorIncarnation,
        };
      },
      materialize: async (
        entry: PromptStashEntry,
      ): Promise<PromptStashMaterializedContent | null> => {
        const imported = await importPromptStashContentToLanding(
          entry,
          draftId,
        );
        if (imported === null) return null;
        return {
          content: imported.content,
          release: () => imported.reservation.release(),
        };
      },
      importAndInsert: (importArgs) => {
        const handle = editorRef.current;
        const editorIncarnation =
          handle !== null && handle.isReady()
            ? handle.getEditorIncarnation()
            : null;
        if (
          importArgs.identity.surface !== "landing" ||
          importArgs.identity.identity !== stashIdentity ||
          handle === null ||
          editorIncarnation === null ||
          importArgs.identity.editorIncarnation !== editorIncarnation
        ) {
          return Promise.resolve({ status: "stale" });
        }
        const latest = runtimeStore.getState().content;
        const nextContent = appendPromptStashContent(
          latest,
          importArgs.content,
        );
        handle.setContent(nextContent, null);
        return Promise.resolve({ status: "accepted" });
      },
    }),
    [draftId, editorRef, runtimeStore, stashIdentity],
  );
}
