import type { Editor, EditorEvents } from "@tiptap/core";
import { useEffect } from "react";
import { useEpicRenameArtifact } from "@/hooks/epic/use-epic-node-mutations";
import { settleDetachedEpicMutation } from "@/lib/artifacts/detached-epic-mutation";
import {
  DEFAULT_EPIC_NODE_NAMES,
  isEpicArtifactKind,
} from "@/lib/artifacts/node-display";
import { useOpenEpicHandle } from "@/providers/use-open-epic-handle";
import { useEpicCanvasStore } from "@/stores/epics/canvas/store";
import type { EpicNodeRef } from "@/stores/epics/canvas/types";
import type {
  ArtifactsSlice,
  ArtifactProjection,
} from "@/stores/epics/open-epic/types";

/**
 * The artifact row, or `null` once it has been deleted. Both readers below go
 * through this so the enqueue-time follow check and the flush-time re-check
 * observe the record the same way.
 */
function readArtifact(
  artifacts: ArtifactsSlice,
  artifactId: string,
): ArtifactProjection | null {
  return Object.hasOwn(artifacts.byId, artifactId)
    ? artifacts.byId[artifactId]
    : null;
}

/**
 * Trailing debounce for the authoritative `epic.renameArtifact` persist. The
 * local Y.Doc rename below is applied per doc change so the tab / sidebar
 * title tracks typing live; the RPC only needs to land once the title
 * settles.
 */
const RENAME_PERSIST_DEBOUNCE_MS = 800;

/**
 * The document's own title: the text of a level-1 heading sitting at the very
 * top of the body, or `null` when the doc doesn't start with one. Mirrors the
 * host's disk-ingest fallback (`parseBody` in epic-file-sync), which reads a
 * leading `# ` line - not a heading further down - as the artifact title.
 */
export function leadingDocTitle(editor: Editor): string | null {
  const first = editor.state.doc.firstChild;
  if (first === null || first.type.name !== "heading") return null;
  const level: unknown = first.attrs["level"];
  if (level !== 1) return null;
  const text = first.textContent.trim();
  return text.length > 0 ? text : null;
}

/**
 * Pure decision for one editor update: given the current leading heading text
 * and the accumulated follow state, decide whether the artifact should be
 * renamed and what the tracked "last heading" becomes.
 *
 * The title *follows the doc* while it is empty, still the create-flow default
 * ("New <kind>"), or equal to the last heading text this reducer tracked (i.e.
 * the title was derived from the doc). An explicit rename (sidebar, another
 * client) makes `artifactTitle` diverge from all three, permanently breaking
 * the link so a deliberate title is never clobbered.
 *
 * `lastDocTitle` only ever advances to a NON-NULL heading: clearing the heading
 * (`nextDocTitle === null`) preserves it, so clearing then retyping still reads
 * as "following the doc" and renames again - the bug a naive
 * `lastDocTitle = nextDocTitle` on every update would introduce (the tracked
 * value goes null on clear and never matches `artifactTitle` on retype).
 */
export function nextTitleFollow(params: {
  readonly nextDocTitle: string | null;
  readonly lastDocTitle: string | null;
  readonly artifactTitle: string;
  readonly defaultTitle: string;
  readonly createdManually: boolean;
}): { readonly renameTo: string | null; readonly lastDocTitle: string | null } {
  const {
    nextDocTitle,
    lastDocTitle,
    artifactTitle,
    defaultTitle,
    createdManually,
  } = params;
  // Heading cleared or not a leading H1: keep the last title (never rename to
  // empty) AND keep `lastDocTitle` so a later retype still follows.
  if (nextDocTitle === null) return { renameTo: null, lastDocTitle };
  if (nextDocTitle === lastDocTitle) return { renameTo: null, lastDocTitle };
  // Heading text genuinely changed - this is now the tracked value regardless
  // of whether we end up renaming.
  if (!createdManually) return { renameTo: null, lastDocTitle: nextDocTitle };
  if (artifactTitle === nextDocTitle) {
    return { renameTo: null, lastDocTitle: nextDocTitle };
  }
  const titleFollowsDoc =
    artifactTitle.length === 0 ||
    artifactTitle === defaultTitle ||
    artifactTitle === lastDocTitle;
  return {
    renameTo: titleFollowsDoc ? nextDocTitle : null,
    lastDocTitle: nextDocTitle,
  };
}

/**
 * Notion-style title inheritance for hand-created artifacts: while the
 * artifact's title still *follows* the document, editing the doc's leading
 * `# ` heading renames the artifact, so the canvas tab / sidebar / breadcrumb
 * title mirrors what the author typed instead of staying "New spec".
 *
 * The title follows the doc while it is empty, still the create-flow default
 * ("New <kind>"), or equal to the heading's previous value (i.e. it was
 * derived from the doc). An explicit rename (sidebar inline rename, another
 * client) breaks the link: the follow check fails from then on, so a
 * deliberate title is never clobbered by body edits. Deleting the heading
 * keeps the last title - an artifact never renames to empty.
 *
 * Scope guards: only artifact kinds (spec/ticket/story/review), only
 * `createdManually` records (agent-created artifacts have authored titles),
 * and only for editors (the local rename action and the RPC both reject
 * viewers anyway).
 *
 * Write path matches the sidebar rename: local Y.Doc rename (live title
 * everywhere + host stream sync), tab-ref name snapshot, then the
 * authoritative `epic.renameArtifact` RPC debounced behind typing and flushed
 * on unmount. The rename touches only artifact metadata - never the body
 * fragment - so it cannot re-trigger the editor update this hook listens to.
 */
export function useArtifactDocTitleFollow(params: {
  readonly editor: Editor | null;
  readonly epicId: string;
  readonly node: EpicNodeRef;
  readonly viewTabId: string;
  readonly editable: boolean;
}): void {
  const { editor, epicId, node, viewTabId, editable } = params;
  const artifactId = node.id;
  const nodeType = node.type;
  const handle = useOpenEpicHandle();
  const renameArtifactInTab = useEpicCanvasStore((s) => s.renameArtifactInTab);
  const renameArtifact = useEpicRenameArtifact(artifactId, false);
  const persistRename = renameArtifact.mutateAsync;

  useEffect(() => {
    if (editor === null || !editable) return;
    if (!isEpicArtifactKind(nodeType)) return;
    const defaultTitle = DEFAULT_EPIC_NODE_NAMES[nodeType];
    let lastDocTitle = leadingDocTitle(editor);
    let pendingPersistTitle: string | null = null;
    let persistTimer: number | null = null;

    /**
     * The last title this hook actually asked the authority for.
     *
     * The re-check below needs to tell "the title is where I last put it" from
     * "somebody else renamed this", and after the optimistic local write was
     * removed those two are no longer distinguishable from `artifact.title`
     * alone. Re-running `nextTitleFollow`'s own `titleFollowsDoc` at flush time
     * does not work either: `lastDocTitle` has already advanced to the newest
     * heading, so typing "A" then "B" leaves the artifact reading "A" against a
     * tracked "B" and the check would discard a perfectly ordinary rename.
     */
    let lastRequestedTitle: string | null = null;

    const flushPersist = (): void => {
      persistTimer = null;
      const title = pendingPersistTitle;
      pendingPersistTitle = null;
      if (title === null) return;
      // RE-READ before sending. A sidebar or remote rename can land inside the
      // 800 ms debounce window, and write commands carry no expected entity
      // version — so a delayed request executes after the newer explicit rename
      // and silently overwrites it. This is the guard the optimistic-write
      // removal took with it: the old `artifact.title !== title` test relied on
      // this hook having already written the title locally, so keeping it as-is
      // would now discard EVERY rename rather than only superseded ones.
      const artifact = readArtifact(
        handle.store.getState().artifacts,
        artifactId,
      );
      const currentTitle = artifact?.title ?? "";
      const stillFollowing =
        currentTitle.length === 0 ||
        currentTitle === defaultTitle ||
        currentTitle === lastRequestedTitle;
      if (!stillFollowing) {
        // Following is broken, which is the documented meaning of an explicit
        // rename. Abandon the pending value rather than racing it — the
        // deliberate title wins, exactly as it does at enqueue time.
        return;
      }
      const supersededTitle = lastRequestedTitle;
      lastRequestedTitle = title;
      // Settled, not merely detached - the same terminal handler the other
      // three rename surfaces use. Both arms below are synchronous today, so
      // the two-arm form does cover this chain; it stops covering it the
      // moment either arm grows an `await`, which is precisely how the sibling
      // surfaces acquired the defect this helper exists for.
      settleDetachedEpicMutation(
        persistRename({ epicId, artifactId, title }).then(
          () => renameArtifactInTab(viewTabId, artifactId, title),
          () => {
            // The authority never took this title, so the tracker must not claim
            // it did: the artifact still reads the PREVIOUS title, which the
            // next flush would then mistake for somebody else's rename and stop
            // following on. Only roll back if nothing newer has been requested.
            if (lastRequestedTitle === title) {
              lastRequestedTitle = supersededTitle;
            }
          },
        ),
        "artifact doc title follow",
        "artifact rename settlement",
      );
    };

    const onUpdate = ({ transaction }: EditorEvents["update"]): void => {
      if (!transaction.docChanged) return;
      const artifact = readArtifact(
        handle.store.getState().artifacts,
        artifactId,
      );
      const result = nextTitleFollow({
        nextDocTitle: leadingDocTitle(editor),
        lastDocTitle,
        artifactTitle: artifact?.title ?? "",
        defaultTitle,
        createdManually: artifact?.createdManually ?? false,
      });
      lastDocTitle = result.lastDocTitle;
      if (result.renameTo === null) return;
      pendingPersistTitle = result.renameTo;
      if (persistTimer !== null) window.clearTimeout(persistTimer);
      persistTimer = window.setTimeout(
        flushPersist,
        RENAME_PERSIST_DEBOUNCE_MS,
      );
    };

    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
      if (persistTimer !== null) {
        window.clearTimeout(persistTimer);
        flushPersist();
      }
    };
  }, [
    editor,
    editable,
    nodeType,
    artifactId,
    epicId,
    viewTabId,
    handle,
    renameArtifactInTab,
    persistRename,
  ]);
}
