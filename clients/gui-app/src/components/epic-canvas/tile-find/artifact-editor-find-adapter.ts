import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  applyArtifactFindSearch,
  calculateArtifactFindMatches,
  clearArtifactFind,
  findNearestArtifactFindMatchIndex,
  getArtifactFindState,
  hasArtifactFindTransactionMeta,
  setArtifactFindCurrent,
  setArtifactFindSearchMeta,
} from "@/editor-core";
import type { TileKindId } from "@/stores/epics/canvas/tile-kinds";
import type {
  TileFindAdapter,
  TileFindCapability,
  TileFindExactHighlight,
  TileFindInput,
  TileFindReplace,
  TileFindStateSnapshot,
  TileFindStatus,
  TileReplaceInput,
} from "@/stores/tile-find";

interface ArtifactEditorFindAdapterParams {
  readonly editor: Editor;
  readonly tileInstanceId: string;
  readonly tileKind: TileKindId;
  readonly activeUnitId: string;
}

const FIND_ONLY_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>(["find"]);
const REPLACE_CAPABILITIES: ReadonlySet<TileFindCapability> =
  new Set<TileFindCapability>(["find", "replace", "replaceAll"]);
const ARTIFACT_FIND_RESCAN_DEBOUNCE_MS = 80;
const ARTIFACT_FIND_CURRENT_SELECTOR = "[data-artifact-find-current]";
const ARTIFACT_FIND_SCROLL_RETRY_FRAMES = 2;

export function createArtifactEditorFindAdapter(
  params: ArtifactEditorFindAdapterParams,
): TileFindAdapter {
  const { editor, tileInstanceId, tileKind, activeUnitId } = params;
  const listeners = new Set<() => void>();
  let snapshot = snapshotFromEditor(editor, activeUnitId, "");
  let replaceText = "";
  let unsubscribeEditor: (() => void) | null = null;
  let rescanTimer: number | null = null;
  let currentScrollFrame: number | null = null;

  const publish = (): void => {
    snapshot = snapshotFromEditor(editor, activeUnitId, replaceText);
    listeners.forEach((listener) => listener());
  };

  const cancelRescan = (): void => {
    if (rescanTimer === null) return;
    window.clearTimeout(rescanTimer);
    rescanTimer = null;
  };

  const cancelCurrentScroll = (): void => {
    if (currentScrollFrame === null) return;
    window.cancelAnimationFrame(currentScrollFrame);
    currentScrollFrame = null;
  };

  const requestCurrentScroll = (remainingRetries: number): void => {
    currentScrollFrame = window.requestAnimationFrame(() => {
      currentScrollFrame = null;
      const currentElement = editor.view.dom.querySelector<HTMLElement>(
        ARTIFACT_FIND_CURRENT_SELECTOR,
      );
      if (currentElement !== null) {
        currentElement.scrollIntoView({
          block: "center",
          inline: "nearest",
        });
        return;
      }
      if (
        remainingRetries > 0 &&
        getArtifactFindState(editor).matches.length > 0
      ) {
        requestCurrentScroll(remainingRetries - 1);
      }
    });
  };

  const scheduleCurrentScroll = (): void => {
    cancelCurrentScroll();
    if (getArtifactFindState(editor).matches.length === 0) return;
    requestCurrentScroll(ARTIFACT_FIND_SCROLL_RETRY_FRAMES);
  };

  const scheduleRescan = (): void => {
    const state = getArtifactFindState(editor);
    if (state.query.length === 0) {
      publish();
      return;
    }
    cancelRescan();
    publish();
    rescanTimer = window.setTimeout(() => {
      rescanTimer = null;
      const current = getArtifactFindState(editor);
      if (current.query.length === 0) {
        publish();
        return;
      }
      const currentMatch = artifactFindMatchAt(
        current.matches,
        current.currentIndex,
      );
      applyArtifactFindSearch(
        editor,
        {
          requestId: current.requestId,
          query: current.query,
          matchCase: current.matchCase,
        },
        currentMatch === null ? null : currentMatch.from,
      );
      // Passive repaint: recompute highlights/decorations as the doc changes,
      // but never move the viewport. Only explicit user actions (search via the
      // find box, next, previous) scroll the current match into view. Mirrors
      // the chat adapter's "passive streaming/sync repaints must never yank the
      // scroll position" rule.
      publish();
    }, ARTIFACT_FIND_RESCAN_DEBOUNCE_MS);
  };

  const handleTransaction = (props: { readonly transaction: Transaction }) => {
    const hasFindMeta = hasArtifactFindTransactionMeta(props.transaction);
    if (props.transaction.docChanged && !hasFindMeta) {
      scheduleRescan();
      return;
    }
    if (!hasFindMeta) return;
    publish();
  };

  const attachEditorListener = (): void => {
    if (unsubscribeEditor !== null) return;
    editor.on("transaction", handleTransaction);
    unsubscribeEditor = () => {
      editor.off("transaction", handleTransaction);
    };
  };

  const detachEditorListener = (): void => {
    cancelRescan();
    cancelCurrentScroll();
    unsubscribeEditor?.();
    unsubscribeEditor = null;
  };

  const dispatchReplaceCurrent = (input: TileReplaceInput): void => {
    replaceText = input.replaceText;
    if (!editor.isEditable) {
      publish();
      return;
    }
    const current = getArtifactFindState(editor);
    const currentMatch = artifactFindMatchAt(
      current.matches,
      current.currentIndex,
    );
    const matches = calculateArtifactFindMatches(
      editor.state.doc,
      input.query,
      input.matchCase,
    );
    const index = findNearestArtifactFindMatchIndex(
      matches,
      currentMatch === null ? null : currentMatch.from,
    );
    const match = artifactFindMatchAt(matches, index);
    if (match === null) {
      applyArtifactFindSearch(editor, input, null);
      publish();
      return;
    }
    cancelRescan();
    const preferredPosition = match.from + input.replaceText.length;
    const tr = setArtifactFindSearchMeta(
      editor.state.tr.insertText(input.replaceText, match.from, match.to),
      input,
      preferredPosition,
    );
    editor.view.dispatch(tr);
    publish();
    scheduleCurrentScroll();
  };

  const dispatchReplaceAll = (input: TileReplaceInput): void => {
    replaceText = input.replaceText;
    if (!editor.isEditable) {
      publish();
      return;
    }
    const matches = calculateArtifactFindMatches(
      editor.state.doc,
      input.query,
      input.matchCase,
    );
    if (matches.length === 0) {
      applyArtifactFindSearch(editor, input, null);
      publish();
      return;
    }
    cancelRescan();
    const preferredPosition = matches[0].from;
    const tr = matches
      .slice()
      .reverse()
      .reduce(
        (currentTransaction, match) =>
          currentTransaction.insertText(
            input.replaceText,
            match.from,
            match.to,
          ),
        editor.state.tr,
      );
    editor.view.dispatch(
      setArtifactFindSearchMeta(tr, input, preferredPosition),
    );
    publish();
    scheduleCurrentScroll();
  };

  return {
    tileInstanceId,
    tileKind,
    // The artifact editor is the one replace-capable find surface, but
    // editability is dynamic. Expose the replace boundary only while the editor
    // is editable so it agrees with the find-only `capabilities` a read-only
    // editor publishes - the store then refuses replace before `prepareRequest`
    // instead of routing into a no-op. The dispatchers keep their own
    // `!editor.isEditable` guard as defense in depth.
    get replace(): TileFindReplace | null {
      if (!editor.isEditable) return null;
      return {
        replaceCurrent: dispatchReplaceCurrent,
        replaceAll: dispatchReplaceAll,
      };
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      attachEditorListener();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) detachEditorListener();
      };
    },
    search: (input: TileFindInput) => {
      cancelRescan();
      applyArtifactFindSearch(editor, input, null);
      publish();
      scheduleCurrentScroll();
    },
    next: () => {
      const state = getArtifactFindState(editor);
      if (state.matches.length === 0) return;
      const nextIndex =
        state.currentIndex < 0
          ? 0
          : (state.currentIndex + 1) % state.matches.length;
      setArtifactFindCurrent(editor, nextIndex);
      publish();
      scheduleCurrentScroll();
    },
    previous: () => {
      const state = getArtifactFindState(editor);
      if (state.matches.length === 0) return;
      const previousIndex =
        state.currentIndex <= 0
          ? state.matches.length - 1
          : state.currentIndex - 1;
      setArtifactFindCurrent(editor, previousIndex);
      publish();
      scheduleCurrentScroll();
    },
    clear: () => {
      cancelRescan();
      cancelCurrentScroll();
      clearArtifactFind(editor, snapshot.requestId);
      publish();
    },
  };
}

function snapshotFromEditor(
  editor: Editor,
  activeUnitId: string,
  replaceText: string,
): TileFindStateSnapshot {
  const state = getArtifactFindState(editor);
  const total = state.matches.length;
  return {
    requestId: state.requestId,
    status: artifactSnapshotStatus(state.query, state.pending),
    capabilities: editor.isEditable
      ? REPLACE_CAPABILITIES
      : FIND_ONLY_CAPABILITIES,
    query: state.query,
    matchCase: state.matchCase,
    replaceText,
    current: total === 0 ? 0 : state.currentIndex + 1,
    total,
    coverageMessage: null,
    errorMessage: null,
    activeUnitId: total === 0 ? null : activeUnitId,
    exactHighlight: artifactExactHighlight(total, state.pending),
  };
}

function artifactFindMatchAt(
  matches: ReadonlyArray<{ readonly from: number; readonly to: number }>,
  index: number,
): { readonly from: number; readonly to: number } | null {
  if (index < 0) return null;
  return matches.at(index) ?? null;
}

function artifactSnapshotStatus(
  query: string,
  pending: boolean,
): TileFindStatus {
  if (query.length === 0) return "idle";
  return pending ? "searching" : "ready";
}

function artifactExactHighlight(
  total: number,
  pending: boolean,
): TileFindExactHighlight {
  if (total === 0) return "none";
  return pending ? "pending" : "painted";
}
